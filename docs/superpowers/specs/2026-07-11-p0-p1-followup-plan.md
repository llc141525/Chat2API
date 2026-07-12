# P0 + P1 Follow-Up Writing Plan

Date: 2026-07-11
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`
Reopens: `2026-07-10-p0-swallowed-replies-writing-plan.md` and `2026-07-10-p1-tool-mcp-reliability-writing-plan.md`
Owner role: plan + acceptance. Implementation is delegated.

## Why This Follow-Up Exists

The P0 and P1 main writing plans were accepted on 2026-07-10 evidence: deterministic gates green, OpenCode probes green for GLM, Qwen, and DeepSeek. Manual reuse on 2026-07-11 uncovered three failures that the automated gates did not surface:

1. **DeepSeek swallowed reply after tool use** — the same failure shape P0 was designed to close for all managed providers reproduces on DeepSeek. Qwen no longer reproduces it after P0/P1; DeepSeek still does.
2. **Qwen intermittent `malformed_tool_output` classification** — Qwen turns occasionally fail with `Provider returned malformed tool output without usable assistant content for managed tool turn qwen:Qwen3.7-Max`. Failure is sporadic and did not trip a single probe run.
3. **Context management summary compaction has not been re-verified end-to-end for multi-turn tool dialogues** since P1 Step 0 landed. Compaction is the load-bearing path for long agent conversations; a defect here silently corrupts every long OpenCode / Claude Code session.

GLM 5.2's tool-call-count limit was reported at the same time and is explicitly declared out of scope by the user.

## Non-Goals

- Do not add provider-adapter prompt injection to make DeepSeek pass. INV-001 stands.
- Do not weaken `malformed_tool_output` classification to make the Qwen intermittent error go away. If a Qwen turn is genuinely malformed, that is a real terminal outcome — the fix must attack why the parse fails on well-formed model output, not the classifier.
- Do not silently retry tool turns as a way to hide provider instability. Any retry must be bounded, typed, and diagnosed.
- Do not commit real provider tokens or cookies in fixtures.
- Do not attempt the GLM 5.2 tool-call-count limit in this track.

## Invariants Reaffirmed

Every fix on this track must preserve:

- INV-001 Single Ownership: only `ToolCallingEngine` performs managed tool prompt injection. Provider adapters must not import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, `shouldInjectToolPrompt`.
- INV-002 Stateless Fallback: catalog resolution follows `Session Store → OpenAI Tools → Prompt-Embedded → History → Safe Empty`.
- INV-003 Delete = Risk: no removal of existing tool/message processing without equivalent coverage and a written purpose.
- INV-004 Client Quirks Matrix: validate against real OpenCode / Claude Code / Cherry Studio quirks, not only OpenAI docs.
- `detectAvailabilityDrift`'s empty-catalog short-circuit at `availabilityDrift.ts:30` remains preserved.

## Track A — DeepSeek Swallowed Reply After Tool Use (P0 Regression)

### Failure Shape

- Manual reproduction on 2026-07-11: DeepSeek turn that includes a tool call is followed by no usable assistant reply. Same shape as the historical Qwen bug that P0 was supposed to close for all managed providers.
- Not reproduced by the current OpenCode probe on DeepSeek (probe passed 2026-07-10). This means the automated evidence is insufficient; probe scope must widen.

### Confirmed Suspect Surface

- `src/main/proxy/adapters/deepseek-stream.ts`
  - `sendContent` runs `ToolStreamParser` only on the streaming path (line 342 onward). On `handleDone` (line 419) `finish_reason` becomes `tool_calls` when the parser emitted one, `stop` otherwise.
  - `handleNonStream` (line 453 onward) never invokes `ToolStreamParser`. On stream end it builds `message = { role: 'assistant', content: contentWithCitations }` and always emits `finish_reason: 'stop'` at line 650. No tool-call assembly happens on this branch.
  - Result: DeepSeek non-stream tool responses depend entirely on downstream parsing of raw `<|CHAT2API|invoke ...>` content into `tool_calls`. If the raw block was emitted as content only, and a downstream consumer suppresses the raw block without producing a `tool_calls` array, the message becomes empty — the swallowed-reply signature.
- `src/main/proxy/adapters/deepseek.ts`
  - Multi-turn history reconstruction at lines 328-360 rebuilds a plain-text prompt from `assistant.tool_calls` + `tool` messages. If the last-assistant-tool-call anchor is not found, the fallback (line 346) sends "only the last user message + tool results". This drops the tool contract from the model's view of the conversation when the anchor detection fails — a viable mechanism for the reply-swallow after the model has already produced a tool call.

### Diagnostic Gaps

- The stream terminal accounting from P0 Step 3 does not cover the DeepSeek non-stream branch — the `stream.on('end')` handler emits `provider_empty_output` on empty content but classifies the terminal outcome as `finish_reason: 'stop'` at line 620 unconditionally, before any tool-call reassembly runs.
- There is no telemetry event asserting "DeepSeek non-stream saw a `<|CHAT2API|invoke` block in raw content but produced no `tool_calls` in the response". That gap is what allowed the regression through P0 acceptance.

### Fix Direction

Any implementation must:

1. Make the non-stream DeepSeek path run through the same `ToolStreamParser` (or an equivalent buffered parser) that the streaming path uses, so tool-call emission and post-tool-call content suppression are consistent between modes.
2. When the raw block indicates a tool call but assembly fails, classify as `malformed_tool_output` (or `runtime_suppressed_malformed_tool_output`), not `provider_empty` — the diagnostic must tell the truth.
3. Assert a hard invariant: for any managed-tool DeepSeek response, at least one of `content.trim().length > 0`, `tool_calls.length > 0`, or `terminalOutcome != content|tool_calls` must hold. Empty content plus `finish_reason: 'stop'` cannot coexist with a managed-tool contract.

### Test Plan Additions

- `tests/providers/deepseek-tool-calling.test.ts` (new) with fixtures for:
  - Non-stream tool-only response (raw managed XML block, no free content).
  - Non-stream tool + trailing residue (parser must suppress residue as `malformed_tool_output`).
  - Stream tool call followed by later text (post-tool-call suppression contract).
  - Multi-turn: first turn tool call, second turn assistant reply after tool result — reply must not be empty when the model returned content.
  - Non-stream turn where the model returns empty content and no tool call under a managed contract — must fail with `provider_empty`, not silent success.
- `tests/tool-runtime/integration/deepseek-multi-turn.test.ts` (new) exercising the same catalog + history path OpenCode uses.

### Real Probe Additions

- Widen `verify-opencode-capability.ps1` verification for DeepSeek to require:
  - At least one **non-stream** managed tool turn observed via provider logs, and
  - At least one turn where an assistant reply follows a tool result and includes non-empty `content`.
- Run three consecutive DeepSeek probe passes as a hard requirement, mirroring the P1 v2 GLM `1..3` gate.

### Acceptance Criteria

- New deterministic tests pass (both new files and any regression coverage the implementer adds).
- Full deterministic gate stays green.
- Three consecutive DeepSeek real probe runs pass.
- The 2026-07-11 manual reproduction is not reproducible on the same conversation shape.
- No provider adapter imports any tool prompt injection helper.

## Track B — Qwen Intermittent Malformed Tool Output (P0 + P1 Boundary)

### Failure Shape

- Sporadic error string observed manually on 2026-07-11:
  `Error: Provider returned malformed tool output without usable assistant content for managed tool turn qwen:Qwen3.7-Max`
- The exact literal comes from `src/main/proxy/toolCalling/outputInspection.ts:172`.
- Path: `classifyNonStreamOutput` returns `malformed_tool_output` when `content.trim() === '' && toolCalls.length === 0 && (validationFailureKind === 'malformed_tool_output' || 'malformed_container')` (`outputInspection.ts:149`). Or on the stream path, `classifyStreamOutput` returns it when `observation.suppressedMalformedToolOutput` is true and no visible content was emitted (`outputInspection.ts:159`).

### Confirmed Suspect Surface

- `src/main/proxy/toolCalling/ToolStreamParser.ts` at lines 108-154 sets `suppressedMalformedToolOutput` and `suppressedReason = 'malformed_tool_output'` when the parsed container has zero valid tool calls **or** the invalid-name list is empty. Because this is an OR path, a partial parse where the container structure is intact but at least one payload fails schema validation is still classifiable as malformed. Qwen occasionally emits managed XML with a stray unicode / control character (see P2 tail residue history) or with a slightly out-of-order tag; either can flip the parse result.
- `src/main/proxy/toolCalling/protocols/managedXml.ts` (touched in the current working tree per `git status`) — the payload validation path there is the natural place where an intermittent parse failure would land.
- `src/main/proxy/adapters/qwen.ts` snapshot rewrite path (already re-audited during P2). The P2 track fixed the snapshot residue and `|tool_calls>` suffix leakage, but did not verify robustness against sporadic mid-stream noise chunks.

### Diagnostic Gaps

- The intermittent flavor of this bug means the classifier reports the right terminal outcome, but there is no per-turn record of **why** the parse failed — no captured raw fragment, no invalid-token span, no schema mismatch details in the diagnostic event. The implementer cannot reproduce without instrumentation.
- Existing `recordToolDiagnosticEvent` at `outputInspection.ts:46` and `outputInspection.ts:108` includes `validationFailureKind` but not a truncated / redacted excerpt of the offending fragment nor the byte offset where parsing failed.

### Fix Direction

Any implementation must decide between two responses per specific root cause. Both branches must remain typed:

1. **Root cause is stream noise / benign artifact** — repair the parser (whitespace normalization, control-char stripping, order-tolerant assembly) so that Qwen output that is functionally well-formed no longer flips to `malformed_tool_output`. Add a diagnostic counter for each repair path so silent generosity is visible.
2. **Root cause is genuine provider malformed output** — keep the terminal outcome as `malformed_tool_output` but implement a bounded, typed retry once per turn (mirroring the availability drift retry mechanic). The retry must be observable in diagnostics as `parse_retry_result: attempted|succeeded|failed|not_applicable`.

Do **not** silently swallow the classification. Do **not** unify the two responses; the retry path is a fallback of the repair path.

### Test Plan Additions

- `tests/tool-calling/managed-xml-parser-repair.test.ts` (new) with fixtures for:
  - Trailing whitespace after `</|CHAT2API|invoke>` — must parse.
  - CR/LF variance between tags — must parse.
  - Stray zero-width joiner or NBSP inside container — must parse (or classify as malformed with parse retry attempted).
  - Genuinely broken container (missing closing tag) — must classify as `malformed_tool_output` with retry `failed`.
- `tests/providers/qwen-tool-calling.test.ts` add cases for intermittent noise fixtures without weakening existing pass/fail expectations.
- If a retry mechanic is added: `tests/tool-calling/parse-retry.test.ts` covering attempted → succeeded, attempted → failed, and `not_applicable` (stream flush without buffered container).

### Real Probe Additions

- Run Qwen `verify-opencode-capability.ps1` **five consecutive** times as the acceptance gate for this track. Five is picked to make an intermittent flip visible; three is the P1 v2 GLM bar.

### Acceptance Criteria

- Five consecutive Qwen probe runs pass with no `malformed_tool_output` classification.
- If the fix takes the retry route, diagnostics show `parse_retry_result` values across the five runs, and every terminal outcome is either `content` or `tool_calls`.
- Full deterministic gate stays green.
- Historic P2 tail-residue tests still pass unchanged.

## Track C — Context Management Summary Compaction Audit (P1 Multi-Turn Safety)

> **Companion plan (2026-07-11):** the summary generator's *content* is audited separately in `2026-07-11-p0-p1-summary-contamination-plan.md`. That plan attacks the **static-config leaking into summary text** failure mode (INV-005 Config-vs-History Split, input sanitization, injection A/B, bounded auto-retry, drift subkinds). This Track C attacks **ordering / signature coverage / session-catalog / typed subkinds / preserve guardrail**. The two must be implemented consistently: sanitizer runs first, then ordering-preserving compaction runs on the sanitized message set.

### Why This Is P1

P1 Step 0 required context management to preserve tool definition messages. `containsToolDefinitions` in `src/main/proxy/services/contextManagementService.ts` implements that at the type level. However, the compaction path (`SummaryStrategy.execute`) has not been re-audited against the P1 v2 prompt-embedded catalog work or against real multi-turn tool exchanges. In multi-turn dialogue, compaction is what makes the difference between a long session that keeps working and one that silently loses the tool contract.

### Audit Findings (Preliminary, 2026-07-11)

Reading `src/main/proxy/services/contextManagementService.ts` and `src/main/proxy/contextMessageMetadata.ts` reveals five concrete risk points. Each must be either fixed or explicitly rejected with a written reason.

1. **Message reordering under compaction.** `SlidingWindowStrategy.execute` (line 187), `TokenLimitStrategy.execute` (line 238), and `SummaryStrategy.execute` (line 392) all reassemble the output as `[...protectedMessages, ...trimableMessages]` (or `[...protectedMessages, summaryMessage, ...recentMessages]`). This moves every protected message to the front of the conversation regardless of its original position. If a tool definition arrived embedded in an assistant turn (OpenCode does this), the assistant turn now appears **before** the user turn that produced it. Providers may see this as a corrupted turn order and misinterpret which side is the model.

2. **`containsToolDefinitions` signature coverage is not proven for every real client.** The check is `hasGeneralToolPromptSignature(content) || /<tools>[\s\S]*?<\/tools>/i.test(content)` (`contextManagementService.ts:157-159`). Any client that inlines its catalog using a marker not in `GENERAL_TOOL_SIGNATURES` (e.g., Cherry Studio, Kilocode, VSCode Agent) will fail this filter, and its tool-definition message will be silently dropped by compaction.

3. **The session catalog is P1 v2's mitigation but requires a stable `toolSessionKey`.** `resolveToolCatalog` (`catalog.ts:48`) uses `existing` from `sessions.get(input.sessionId)` when `requestTools.length === 0`. After a compaction turn that drops the prompt-embedded block, only the session catalog can recover. If `toolSessionKey` differs across turns (client changed conversation id, restart, retry with new id) the session catalog cannot save the compacted turn — the prompt-embedded extractor fails because the message was pruned, and history fallback returns only observed names with `additionalProperties: true`.

4. **`SummaryStrategy` fallback silently degrades.** When `summaryGenerator` throws or is missing (`contextManagementService.ts:380`, `442`), the strategy returns `[...protectedMessages, ...recentMessages]` — no summary — and marks `trimmed: true`. In practice this collapses to sliding-window semantics but is reported as a summary strategy result. The diagnostic surface does not distinguish "summary succeeded" from "summary failed and I fell back". A long session that quietly loses summary compression can build a runaway context.

5. **`preserveToolExchangePairs` does not protect tool-definition messages.** It only re-inserts assistant `tool_calls` and matching `tool` messages by `tool_call_id` linkage. Prompt-injected tool definition blocks have no `tool_call_id`, so if they are ever mis-classified as non-protected by `containsToolDefinitions`, this pair-preservation pass will not restore them.

### Fix Direction

1. Change all three strategies to preserve original insertion order across protected and trimable messages. Do **not** reassemble by role bucket. Use an in-place drop of non-protected messages that fall outside the window, keeping every protected message at its original index. If the summary strategy needs a new synthetic system message, insert it just before the first kept recent message, not at the front of the array.
2. Route every `containsToolDefinitions` decision through the same signature registry that the prompt-embedded extractor uses (`src/main/proxy/toolCalling/clientAdapters/promptEmbeddedToolExtractor.ts`). One source of truth per project.
3. Guarantee `toolSessionKey` propagation is stable across compacted turns of the same logical conversation, and add a diagnostic event when a compaction turn was rescued by `session_catalog` versus one that was not. This proves the P1 v2 mitigation is doing its job in the compaction path.
4. Distinguish `summary_success | summary_generator_missing | summary_generator_failed | summary_not_needed` as typed strategy result subkinds. Any degraded fallback must appear in the diagnostic event, not just in a console warning.
5. Reserve `preserveToolExchangePairs` for what it does today (tool-call / tool-result pair linkage) and add a new `preserveToolDefinitionMessages` pass that re-inserts any protected tool-definition messages missing from the processed output (guardrail only — the strategies should not drop them in the first place).

### Test Plan Additions

- `tests/services/contextManagement-order-preservation.test.ts` (new) asserting that after sliding window / token limit / summary, protected messages remain at their **original relative index**, not floated to the front.
- `tests/services/contextManagement-tool-definition-signatures.test.ts` (new) exercising every client signature enumerated in `src/main/proxy/constants/signatures.ts` (OpenCode, Cherry Studio, Kilocode, Codex, VSCode Agent, Claude Code, plus generic `## Available Tools`).
- `tests/services/contextManagement-session-catalog-rescue.test.ts` (new) simulating a multi-turn conversation where turn N contains the `## Available Tools` block, turn N+1 does not (compacted), and asserting the resolved catalog for N+1 comes from `session_catalog`, not from history fallback.
- `tests/services/contextManagement-summary-failure-diagnostic.test.ts` (new) covering the summary generator throwing and asserting the diagnostic event reports `summary_generator_failed`.
- `tests/services/contextManagement-preserve-tool-def-guardrail.test.ts` (new) — force `containsToolDefinitions` to miss a tool-def message and assert that the new guardrail pass restores it (or that the pipeline fails typed rather than silently proceeds with the contract missing).

### Real Probe Additions

- Long-conversation probe: extend the OpenCode capability probe (or add a sibling script) to force enough turns that sliding-window and, separately, summary strategies actually trigger. The current probe is short enough that compaction rarely runs. Without this, deterministic tests cover the code but the integration path is not exercised end-to-end.

### Acceptance Criteria

- Each of the five audit findings above is either fixed with a passing new test or explicitly rejected with a written reason in the eventual acceptance run section.
- No sliding-window / token-limit / summary strategy floats protected messages to the front of the array.
- Every strategy result is one of the typed subkinds.
- Long-conversation probe demonstrates catalog survival across ≥1 sliding-window and ≥1 summary compaction event within a single session.
- Full deterministic gate stays green.
- P1 v2 v-track evidence (three GLM probes, one Qwen, one DeepSeek) is re-run and remains green.

## Test Gates (Additions Only)

Add to the existing gates. The current focused, provider, and full gates must all keep passing.

New focused gate for this follow-up:

```powershell
node --test tests/tool-calling/managed-xml-parser-repair.test.ts tests/providers/deepseek-tool-calling.test.ts tests/tool-runtime/integration/deepseek-multi-turn.test.ts tests/services/contextManagement-order-preservation.test.ts tests/services/contextManagement-tool-definition-signatures.test.ts tests/services/contextManagement-session-catalog-rescue.test.ts tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/services/contextManagement-preserve-tool-def-guardrail.test.ts
```

Real OpenCode probe gate (additions):

```powershell
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro" }
1..5 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max" }
```

Plus a long-conversation probe once implemented.

## Diagnostics Additions

For every strict-agent turn, logs must additionally expose:

- `catalogRescueByCompaction` — boolean, true when `catalog.source === 'session_catalog'` on a turn where the tool-definition message would otherwise have been pruned by context management.
- `contextManagementActions` — array of `{ strategyName, subkind: 'trimmed' | 'summary_success' | 'summary_generator_missing' | 'summary_generator_failed' | 'summary_not_needed', originalCount, processedCount }`.
- `parseRetryResult` (only if the Qwen intermittent fix takes the retry route) — `attempted | succeeded | failed | not_applicable`.
- `deepseekResponseMode` — `stream | non_stream`, plus `toolStreamParserUsed` boolean, so the DeepSeek regression cannot recur silently.

Safety: no auth tokens, cookies, or full secrets in any log line. Raw provider snippets may be truncated and redacted.

## Acceptance Run: 2026-07-11

Status: **PARTIAL PASS — do not close yet**.

Deterministic gates run:

```powershell
node --test tests/tool-calling/managed-xml-parser-repair.test.ts tests/providers/deepseek-tool-calling.test.ts tests/tool-runtime/integration/deepseek-multi-turn.test.ts tests/services/contextManagement-order-preservation.test.ts tests/services/contextManagement-tool-definition-signatures.test.ts tests/services/contextManagement-session-catalog-rescue.test.ts tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/services/contextManagement-preserve-tool-def-guardrail.test.ts
```

Result: **PASS, 32/32** for the files that exist. However, `tests/tool-runtime/integration/deepseek-multi-turn.test.ts` is still missing, so Track A's requested integration coverage is not complete.

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: **PASS, 244/244**.

Real OpenCode probe gates run:

```powershell
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro" }
1..5 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max" }
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2" }
```

Result:

- DeepSeek: **PASS, 3/3**. No swallowed reply reproduced by the probe.
- Qwen: **PASS, 5/5**. No intermittent `malformed_tool_output` reproduced by the probe.
- GLM: **PASS, 3/3**. P1 v2 real-probe evidence remains green.

Invariant check:

- No provider adapter import of `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt` was found. The only adapter hits are comment text; `CherryStudioPromptAdapter` is under `src/main/proxy/adapters/prompt/`, which is explicitly outside the provider-adapter ban in the ToolCallingEngine ownership rule.

Blocking gaps before full acceptance:

1. Add the missing `tests/tool-runtime/integration/deepseek-multi-turn.test.ts`, or explicitly reject it with written rationale and equivalent coverage proof.
2. Add and run the long-conversation probe that forces at least one sliding-window compaction and one summary compaction in a real OpenCode session. Current evidence only proves compaction behavior through deterministic tests.

Acceptance conclusion: Track A and Track B probe gates are accepted for this run; Track C deterministic coverage is promising, but Track C is not fully accepted until the real long-conversation compaction probe exists and passes.

## Acceptance Run: 2026-07-11 Retry

Status: **FAILED — do not close yet**.

Deterministic gates run:

```powershell
node --test tests/tool-calling/managed-xml-parser-repair.test.ts tests/providers/deepseek-tool-calling.test.ts tests/tool-runtime/integration/deepseek-multi-turn.test.ts tests/services/contextManagement-order-preservation.test.ts tests/services/contextManagement-tool-definition-signatures.test.ts tests/services/contextManagement-session-catalog-rescue.test.ts tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/services/contextManagement-preserve-tool-def-guardrail.test.ts
```

Result: **PASS, 33/33**. The previously missing `tests/tool-runtime/integration/deepseek-multi-turn.test.ts` now exists and passes.

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: **PASS, 244/244**.

Real OpenCode probe gates run:

```powershell
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro" }
1..5 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max" }
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2" }
```

Result:

- DeepSeek: **PASS, 3/3**.
- Qwen: **PASS, 5/5**.
- GLM: **PASS, 3/3**.

Long-conversation compaction probe:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3.7-Max" -LogPath ".\dev.log"
```

Result: **FAIL**.

Observed failures:

1. Initial version failed before model execution because the script parsed `~\.chat2api\data.json` as plaintext JSON. The app uses `electron-store` with `encryptionKey: chat2api-fixed-encryption-key-v1`, so the file is encrypted/binary on this machine.
2. After adapting the script to read/write context management through `electron-store`, the probe reached OpenCode but failed with `Missing .agent-probe/long-step-1.txt`.
3. The captured event stream shows the model loaded `agent-capability-probe`, not the intended long-conversation instructions, because `.opencode/agent/capability-probe.md` hard-codes the first skill call as `name: agent-capability-probe`. The loaded skill then drove the standard short capability flow and wrote `.agent-probe/result.json`, not the long-session artifacts.

Follow-up harness repair attempted during acceptance:

- Added a dedicated `.opencode/agent/long-conversation-probe.md`.
- Added `.opencode/skills/long-conversation-probe/SKILL.md` with OpenCode skill frontmatter.
- Updated `verify-opencode-long-conversation.ps1` to use `--agent long-conversation-probe`.
- Updated the long probe to read `tests/agent-capability/long-conversation-prompt.md` instead of the old short `prompt.md`.
- Updated the script to read/write the encrypted app config through `electron-store` instead of parsing `data.json` directly.

After that repair, the long probe still failed:

- The event stream shows a successful `skill` call for `long-conversation-probe`.
- The model then called `read` for `tests/agent-capability/input.txt`.
- The model then called `bash` and successfully generated `.agent-probe/long-step-1.txt`.
- The model then called `read` for `tests/agent-capability/long-conversation-prompt.md`.
- After that read result, the model emitted ordinary explanatory text instead of the required next `bash` tool call, so `.agent-probe/long-step-2.txt` was missing.

Conclusion: Track A and Track B remain accepted for this retry, and Track C deterministic coverage is accepted. Track C real end-to-end evidence is still **not accepted**. The long-conversation probe harness now reaches the intended long-probe skill and begins the required sequence, but Qwen did not maintain the mandated multi-step tool sequence long enough to reach summary/sliding-window log assertions. The next implementation pass must harden the long-conversation probe and/or the managed tool-following path until this script proves both sliding-window and summary compaction from appended `dev.log` output.

## Acceptance Run: 2026-07-11 Final

Status: **ACCEPTED**.

Focused deterministic gate:

```powershell
node --test tests/tool-calling/managed-xml-parser-repair.test.ts tests/providers/deepseek-tool-calling.test.ts tests/tool-runtime/integration/deepseek-multi-turn.test.ts tests/services/contextManagement-order-preservation.test.ts tests/services/contextManagement-tool-definition-signatures.test.ts tests/services/contextManagement-session-catalog-rescue.test.ts tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/services/contextManagement-preserve-tool-def-guardrail.test.ts
```

Result: **PASS, 37/37**.

Full deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: **PASS, 244/244**.

Long-conversation compaction probe:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3.7-Max" -LogPath ".\dev.log"
```

Result: **PASS**.

Evidence:

- Probe artifacts were created.
- `long-result.json` is structurally valid.
- OpenCode event log is valid NDJSON.
- OpenCode event stream proves a long multi-turn tool session.
- Appended `dev.log` proves both sliding-window and summary compaction occurred.
- The probe restored the original context management config in `finally`.

Real OpenCode probe gates:

```powershell
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro" }
1..5 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max" }
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2" }
```

Result:

- DeepSeek: **PASS, 3/3**.
- Qwen: **PASS, 5/5**.
- GLM: **PASS, 3/3**.

Acceptance conclusion:

- Track A DeepSeek swallowed-reply regression: **ACCEPTED**.
- Track B Qwen intermittent malformed boundary: **ACCEPTED**.
- Track C context management compaction audit: **ACCEPTED**.

The reopened P0/P1 follow-up is accepted on this run.

## Handoff To Implementing AI

For each track above, the implementing AI receives:

- This follow-up plan.
- The relevant original writing plans (P0 main, P1 main, P1 v2).
- The parent spec for invariants.
- The acceptance dossier for the gates that must remain green.

The implementing AI is expected to:

- Land failing deterministic tests first (RED), then implement to green.
- Run the full deterministic gate before any real probe.
- Report deterministic and probe results back with exact test counts and probe verdicts.
- Not push to the remote. Not create commits until the plan owner accepts. Not modify unrelated files.
- Not weaken existing invariants to satisfy a new test.

The plan owner will re-run acceptance from this document plus the updated dossier and only close this follow-up when every track's acceptance criteria are met.

## Stop Conditions

Stop and write another follow-up if:

- Fixing DeepSeek requires a provider request format redesign beyond adapter finalization.
- Qwen's malformed output turns out to be a Chat2API-side parsing regression across multiple providers — that would upgrade Track B to a cross-provider defect and require broader coverage.
- Fixing compaction ordering breaks any existing accepted P0 / P1 / P1 v2 / P2 test — reopen those tracks explicitly rather than silently loosening them.
- A fix would require violating INV-001..INV-004.
