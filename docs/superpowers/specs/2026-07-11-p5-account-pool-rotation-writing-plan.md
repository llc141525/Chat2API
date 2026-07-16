# P5 Account Pool Rotation Writing Plan

Date: 2026-07-11
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`
Related provider plan: `docs/superpowers/specs/2026-07-11-p4-provider-expansion-writing-plan.md`

## Objective

Introduce a provider account pool so Chat2API can use multiple configured accounts per provider with explicit health, cooldown, quota, and selection policy.

The target state is not "hide abuse". The target is operational safety: avoid hammering a single account, isolate failed or muted accounts, respect configured limits, and keep long agent sessions coherent.

## Why This Exists

The current system stores multiple accounts, and `LoadBalancer` already has rough `round-robin`, `fill-first`, and `failover` concepts. In practice, provider usage still behaves like a single-account path in important cases:

- account selection state is in-memory and coarse
- failure state is short-lived and not provider-aware enough
- provider-specific risk-control signals are not normalized
- long OpenCode sessions need stable session/account affinity
- UI and diagnostics do not make account-pool behavior obvious

For providers such as Z.ai, Kimi, MiniMax, Qwen, GLM, and DeepSeek, repeated agent probes can trigger provider-side rate limits, muted-account behavior, captcha, or token invalidation. Account pooling must reduce accidental concentration while remaining transparent and bounded.

## Non-Goals

- Do not bypass captcha, account bans, provider policy, or commercial rate limits.
- Do not automatically create accounts.
- Do not rotate accounts mid-conversation unless the selected account is unavailable and the request can be safely retried.
- Do not hide provider failures by endlessly trying accounts.
- Do not store secrets in logs, probe artifacts, or diagnostics.
- Do not make account pooling a prerequisite for the P4 provider adapter plan, though P4 should consume the diagnostics once available.

## Invariants

Existing:

- INV-001 Single Ownership of tool prompt injection.
- INV-002 Stateless Fallback for tool catalogs.
- INV-005 Config-vs-History Split.

New:

- **INV-007 Session Affinity** — a logical client/session/tool catalog turn must keep using the same provider account unless a classified account-level failure makes that impossible.
- **INV-008 Bounded Retry Across Accounts** — cross-account retry is finite, logged, and classified. It must never loop until success.
- **INV-009 Secret-Safe Observability** — diagnostics may include account ID/name hash, provider ID, model, selection reason, and health state; they must never include raw tokens, cookies, refresh tokens, or authorization headers.
- **INV-010 Policy-Respecting Cooldown** — provider risk-control, captcha, muted-account, quota, and auth failures must place the account into an appropriate cooldown or terminal status instead of immediately rotating forever.

## Current Code Surface

Primary files:

- `src/main/proxy/loadbalancer.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/server.ts`
- `src/main/proxy/types.ts`
- `src/main/store/accounts.ts`
- `src/main/store/store.ts`
- `src/main/store/types.ts`
- `src/main/providers/checker.ts`
- `src/main/requestLogs/manager.ts`
- `src/renderer/src/stores/providersStore.ts`
- `src/renderer/src/stores/proxyStore.ts`
- provider adapters under `src/main/proxy/adapters/`

Primary tests:

- new `tests/proxy/account-pool-selection.test.ts`
- new `tests/proxy/account-pool-health.test.ts`
- new `tests/proxy/account-pool-session-affinity.test.ts`
- new `tests/proxy/account-pool-retry.test.ts`
- existing provider flow and final tool gates

## Track A — Account Pool Data Model

### Scope

Define durable account-pool state without leaking credentials.

### Required Changes

1. Extend account metadata with optional pool fields:
   - `poolEnabled?: boolean`
   - `weight?: number`
   - `cooldownUntil?: number`
   - `lastSelectedAt?: number`
   - `consecutiveFailures?: number`
   - `lastFailureKind?: AccountFailureKind`
   - `dailyLimit`
   - `todayUsed`
2. Add `AccountFailureKind`:
   - `auth_expired`
   - `quota_exhausted`
   - `rate_limited`
   - `risk_control`
   - `captcha_required`
   - `muted`
   - `network`
   - `provider_5xx`
   - `malformed_provider_response`
   - `unknown`
3. Add config section:

```ts
accountPool: {
  enabled: boolean
  defaultStrategy: 'round-robin' | 'weighted-round-robin' | 'least-recently-used' | 'failover'
  maxCrossAccountRetries: number
  cooldownMs: Partial<Record<AccountFailureKind, number>>
  stickySessionTtlMs: number
}
```

4. Migration must be backward-compatible with existing account records.

### Tests

- Existing account records load without migration failure.
- New metadata is omitted from exports where sensitive or noisy.
- Secret fields remain encrypted exactly as before.

## Track B — Account Health Classifier

### Scope

Normalize provider-specific failures into account health outcomes.

### Required Changes

1. Add `classifyAccountFailure(providerId, status, error, body)` as a pure utility.
2. Map known provider signals:
   - muted account text from DeepSeek-style envelopes
   - 401/403 auth failures
   - 429/rate-limit messages
   - captcha/risk-control strings from Z.ai
   - quota/credit exhaustion from MiniMax
   - token/JWT expiration from Kimi
3. Return:

```ts
{
  kind: AccountFailureKind
  retryableSameAccount: boolean
  retryableOtherAccount: boolean
  cooldownMs: number
  terminalAccountStatus?: 'expired' | 'error'
  safeMessage: string
}
```

4. Classifier must be conservative. Unknown provider errors should not trigger aggressive cross-account retries.

### Tests

- Each known signal maps to the expected kind.
- Raw provider body is redacted in logs.
- Unknown 4xx defaults to non-retryable unless explicitly known.

## Track C — Selection Strategy and Session Affinity

### Scope

Replace ad hoc selection with a deterministic account-pool selector that supports long agent sessions.

### Required Changes

1. Introduce `AccountPoolSelector`.
2. Candidate filtering:
   - provider enabled
   - account active
   - model supported
   - not in cooldown
   - under daily limit
   - not excluded by current retry attempt
3. Strategies:
   - `round-robin`
   - `weighted-round-robin`
   - `least-recently-used`
   - `failover`
4. Add sticky session map:

```text
client/toolSessionKey/provider/model -> accountId
```

5. Preserve account affinity for:
   - OpenCode multi-turn sessions
   - tool catalog session key
   - provider conversation cleanup
6. If the sticky account enters terminal failure, select a new account only if:
   - request is safely retryable
   - no provider session has already emitted partial output
   - retry budget remains

### Tests

- Same OpenCode/tool session selects the same account across turns.
- Different sessions distribute over the pool.
- Cooldown accounts are skipped.
- Preferred account mapping still wins when healthy.
- Preferred account mapping fails clearly when unhealthy and no fallback is allowed.

## Track D — Bounded Cross-Account Retry

### Scope

Add one controlled retry layer around provider/account failures.

### Required Changes

1. On classified account failure, update account health before retrying.
2. Retry only when:
   - no response bytes were streamed to the client
   - classifier says other-account retry is allowed
   - `maxCrossAccountRetries` remains
   - another healthy candidate exists
3. Do not retry:
   - malformed model tool output after provider returned a valid assistant response
   - summary contamination after its own bounded retry is already attempted
   - user-cancelled requests
   - captcha/risk-control if configured cooldown says terminal for this provider
4. Emit a structured event:

```text
accountPoolRetryAttempted
```

Fields:

- provider ID
- model
- from account safe ID
- to account safe ID
- failure kind
- attempt index
- max attempts

### Tests

- Exactly one retry when budget is one.
- No retry after stream has started.
- No retry on malformed assistant tool output.
- Failure updates account cooldown before selecting the next account.

## Track E — UI and Diagnostics

### Scope

Make account-pool behavior visible enough to debug without exposing secrets.

### Required Changes

1. Provider account list shows:
   - active/inactive/error/expired
   - cooldown remaining
   - today used / daily limit
   - last selected time
   - last failure kind
   - request count
2. Proxy settings expose:
   - enable account pool
   - default strategy
   - max cross-account retries
   - sticky session TTL
3. Logs include:
   - `accountSelected`
   - `accountHealthUpdated`
   - `accountPoolRetryAttempted`
   - `accountPoolExhausted`
4. Logs must use redacted account identifiers.

### Tests

- Renderer store accepts new fields without dropping old records.
- IPC payloads do not include decrypted credentials.
- UI can render cooldown and failure state for multiple accounts.

## Track F — OpenCode Pool Probe

### Scope

Add a real-machine probe that proves account distribution and sticky session behavior.

### Required Changes

1. New verifier:

```powershell
.\tests\agent-capability\verify-opencode-account-pool.ps1 `
  -Model "qwen/Qwen3.7-Max" `
  -Runs 6 `
  -ExpectedDistinctAccounts 2
```

2. Probe must record:
   - selected account safe ID per run
   - selected account safe ID per turn
   - whether sticky session held
   - retry count
   - failure kind, if any
3. For providers where only one account exists, verifier should return `SKIPPED_SINGLE_ACCOUNT`, not pass.
4. Add a synthetic deterministic selector test so CI can verify distribution without real accounts.

### Acceptance

- With at least two healthy accounts for one provider, six independent OpenCode sessions select at least two distinct accounts.
- Within one multi-turn OpenCode session, every turn uses the same account unless a classified retry occurs.
- No raw credentials appear in event artifacts or logs.

## Consolidated Test Gate

Deterministic:

```powershell
node --test tests/proxy/account-pool-selection.test.ts `
  tests/proxy/account-pool-health.test.ts `
  tests/proxy/account-pool-session-affinity.test.ts `
  tests/proxy/account-pool-retry.test.ts
```

Regression:

```powershell
node --test tests/tool-calling/*.test.ts `
  tests/providers/glm-tool-calling.test.ts `
  tests/providers/context-tool-metadata.test.ts `
  tests/providers/qwen-request-routing.test.ts
```

Real OpenCode:

```powershell
.\tests\agent-capability\verify-opencode-account-pool.ps1 `
  -Model "<provider>/<accepted-model-id>" `
  -Runs 6 `
  -ExpectedDistinctAccounts 2
```

## Acceptance Criteria

- Multiple accounts per provider can be selected by policy.
- Sticky session affinity is preserved for long OpenCode/tool sessions.
- Classified account failures update health and cooldown.
- Cross-account retry is bounded and never happens after bytes stream to the client.
- Provider risk-control is surfaced as risk-control, not hidden as success.
- UI and logs make account-pool state inspectable without leaking secrets.

## Stop Conditions

Pause and return to plan owner if:

- Provider behavior indicates rotation is triggering stronger risk-control.
- A retry would require replaying a request after partial streaming output.
- Session affinity conflicts with provider-side conversation IDs.
- Required UI changes would expose decrypted credential fields.
- Account-pool retry masks P0 swallowed replies or P1 tool catalog drift.

## Acceptance Deliverables

1. Deterministic account-pool test output.
2. Regression tool-calling final gate output.
3. OpenCode account-pool probe artifacts with redacted account IDs.
4. Screenshot or renderer test evidence for account-pool diagnostics.
5. Redaction grep proving no raw token/cookie appears in logs or artifacts.

