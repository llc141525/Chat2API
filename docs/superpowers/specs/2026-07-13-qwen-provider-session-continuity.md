# Qwen Provider Session Continuity Spec

Date: 2026-07-13
Branch: codex/qwen-provider-session-continuity
Baseline commit: 3f16737 `milestone: qwen simple-context tool calling baseline`

## Problem

Qwen can execute simple managed-tool tasks, but Chat2API currently creates a fresh Qwen web session for each request. The Qwen web API live probe proved that reusing `session_id` lets Qwen remember prior turns, while a fresh `session_id` cannot.

Current Qwen request assembly still flattens all OpenAI messages into one web-chat `text/plain` message. That works for short contexts but forces Chat2API to carry all memory in prompt text, causing long-context degradation.

## Evidence

Probe: `scripts/probes/qwen-session-memory-probe.mjs`

Observed result:

- Turn 1: new `session_id`, model acknowledges a nonce.
- Turn 2: same `session_id`, previous `reqid` as `parent_req_id`, model recalls nonce.
- Variant: same `session_id`, `parent_req_id = "0"`, model still recalls nonce.
- Control: new `session_id`, model cannot recall nonce.

Conclusion: Qwen provider-side session memory is usable. `session_id` is the minimum continuity key; `parent_req_id` should still be preserved for message-tree correctness.

Proxy-level validation after Node 1/2:

- Local Chat2API proxy: `http://127.0.0.1:8081/v1/chat/completions`
- Turn 1 used a unique `user` and no prior history.
- Turn 2 used the same `user`, no prior history, and asked for the nonce.
- Result: Turn 2 recalled the nonce; a different `user` control did not.
- Response IDs for turn 1 and turn 2 matched the same Qwen provider session.
- Test Qwen sessions were deleted after the probe.

Default OpenAI-route validation gap found on 2026-07-13:

- The proxy-level validation above used a fixed OpenAI `user`.
- Real clients often omit `user`.
- In that default path, `buildProviderConversationStateKey()` falls back to the per-request `context.requestId`.
- Because `context.requestId` is regenerated on every `/v1/chat/completions` request, Qwen state is missed and the adapter starts a fresh provider session.
- Dev log evidence showed both modes:
  - reused mode: same Qwen `sessionId`, later turn has previous `reqId` as `parentReqId`
  - broken default mode: new Qwen `sessionId` with `parentReqId: undefined`

Conclusion: Node 1-3 implemented the lower provider-session reuse layer, but the OpenAI chat route still lacks a stable conversation identity. That makes the architecture incomplete for default clients.

## Goals

1. Reuse Qwen provider sessions across Chat2API turns.
2. Preserve the current simple-context baseline as fallback.
3. Keep tool-calling invariants intact: `ToolCallingEngine` remains sole prompt owner.
4. Add deterministic tests before relying on live probes.
5. Make each work node small enough to review and compact.

## Non-Goals

- No UI settings in the first implementation node.
- No immediate replacement of context management.
- No immediate prompt delta optimization for Qwen assembly path.
- No broad refactor of all provider adapters.

## Architecture

### State

Extend shared `ConversationState` to support Qwen:

- `qwenSessionId?: string`
- `qwenParentReqId?: string`

Use existing `getProviderConversationState` / `setProviderConversationState` and the same keying strategy as GLM/DeepSeek:

- primary: provider + account + model + user/session dimension
- fallback: tool catalog session key when managed tool history is present

### Request Shape

Change Qwen adapter request input to optionally accept:

- `sessionId?: string`
- `parentReqId?: string`

For a fresh turn:

- generate `session_id`
- use `parent_req_id = "0"`
- use `scene_param = "first_turn"`

For a continued provider session:

- reuse stored `session_id`
- use stored `qwenParentReqId` when available, otherwise `"0"`
- use `scene_param = "chat"`

The first implementation may still send the flattened current prompt history. That is deliberately redundant but safer; provider memory should help, while existing Chat2API history remains a fallback.

### Response Capture

`QwenStreamHandler` already captures:

- `communication.sessionid`
- `communication.reqid`

Expose both after stream/non-stream completion:

- `getSessionId()`
- `getResponseId()` or `getParentReqId()`

Forwarder stores them on stream end and after non-stream completion.

## Work Nodes

### Node 1: Minimal Session Continuity

Planning timebox: 15-20 minutes
Execution timebox: 25-40 minutes

Owner: worker subagent

Files:

- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/forwarder.ts`
- `tests/providers/qwen-session-continuity.test.ts` or nearby provider tests

Acceptance:

- Qwen adapter can build request bodies with caller-supplied `sessionId` and `parentReqId`.
- `parent_req_id` is no longer hardcoded in the continued-session path.
- `forwardQwen` reads and writes Qwen conversation state.
- Streaming path stores state when stream ends.
- Non-stream path stores state after parsing.
- Deterministic tests prove the request body and forwarder source/behavior.

Main-agent review checklist:

- `ConversationState` keeps Qwen fields separate from GLM `conversationId` and DeepSeek `parentMessageId`.
- `forwardQwen` computes `conversationStateKey` and `toolSessionKey` before creating the adapter.
- The adapter receives `convState?.qwenSessionId` and `convState?.qwenParentReqId` in both assembly and non-assembly paths.
- Stream path wraps/end-hooks the transformed stream and stores the handler's final `sessionId` + `responseId`.
- Non-stream path stores state after `handleNonStream()` and before returning success.
- Delete-after-chat behavior should not leave a known-deleted provider session as the preferred future state.
- Tests cover both fresh and continued request body shape.
- Tests include a guard that `parent_req_id: '0'` is not the only Qwen path.

Checkpoint compression:

- Worker final answer must include changed files, test commands, and a 10-line max state summary.
- Main agent summarizes accepted changes and next risks in 10 lines max before Node 2.

### Node 2: Assembly Summary and Prompt Safety

Planning timebox: 15 minutes
Execution timebox: 25-35 minutes

Owner: worker subagent after Node 1 review

Files:

- `src/main/proxy/RequestAssembly.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/adapters/qwen.ts`
- `tests/providers/qwen-request-routing.test.ts`

Acceptance:

- Qwen assembly path does not drop context summary system messages.
- Tool manifest remains authoritative and after summary.
- Tests fail if summary is omitted from assembly path.

Main-agent review checklist:

- `prepareRequest()` must not build an assembly from stale/original messages after context management has already compacted the request.
- `assembly.summaryText` must be populated either from the summary strategy output or by extracting the `[Prior conversation summary` system message from processed messages.
- Qwen should prefer `renderFinalPrompt({ template: 'prefix' })` over another hand-rolled prompt joiner.
- Prompt order for Qwen must be: base system -> non-authoritative summary -> authoritative tool contract -> conversation text.
- Tests must assert content presence and relative ordering, not just that `toolManifest` exists.
- No provider adapter may import prompt injection helpers forbidden by INV-001.

### Node 3: Qwen Delta Prompt Mode

Planning timebox: 20 minutes
Execution timebox: 40-60 minutes

Owner: worker subagent only after Node 1 live/proxy behavior is validated

Acceptance:

- When provider session exists, Qwen sends only the new user/tool delta needed since the previous assistant tool turn.
- Full-history prompt remains fallback when no provider session exists.
- Long tool results are not duplicated across provider memory and prompt history.

Preconditions:

- Node 1 deterministic tests pass.
- Node 2 summary/tool prompt ordering tests pass.
- A live or proxy-level probe confirms Chat2API actually reuses Qwen `session_id` across turns.

Main-agent review checklist:

- Delta mode must be guarded by an existing `qwenSessionId`; no provider session means full prompt.
- Delta mode must preserve the latest user request, any assistant tool call immediately awaiting tool results, and matching tool results.
- Delta mode must not drop system/tool contract for managed-tool turns until a replacement contract persistence strategy is proven.
- Delta mode should mirror GLM's conservative pattern: find the most recent assistant tool call, send from there forward, otherwise send full prompt.
- Tests must cover: no provider session -> full prompt, provider session + tool result suffix -> compact delta, provider session without tool suffix -> safe full prompt.
- Live probe must be rerun after enabling delta mode.

### Node 4: Live Probe and Regression Gate

Planning timebox: 10-15 minutes
Execution timebox: 20-30 minutes

Owner: main agent review plus optional worker verification

Acceptance:

- Deterministic tests pass.
- `qwen-session-memory-probe.mjs` still passes.
- A proxy-level two-turn request confirms Chat2API reuses Qwen session state.

Checkpoint result after Node 3:

- Deterministic layer passed with `node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts` (272 passing tests).
- Proxy-level two-turn memory probe passed after Node 1/2 and again after Node 3. Same OpenAI `user` with no resent prior messages reused the same Qwen provider session and recalled the nonce; a different `user` did not.
- Bare `opencode run --model Qwen3-Max` failed before reaching Chat2API because OpenCode did not select the intended provider in this environment. Use `qwen/Qwen3-Max` for the Qwen provider-specific gate.
- `verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"` generated `.agent-probe/result.json` matching local deterministic computation, proving at least the `read -> bash` tool chain executed through the proxy, but the wrapper timed out before producing a complete event log/final pass.
- A minimal manual OpenCode run showed a remaining risk: after a tool result, Qwen can emit managed tool XML for a valid tool name with missing required parameters; the stream parser correctly rejects it as schema-invalid, and OpenCode reports a malformed managed-tool turn.

Next checkpoint:

- Treat provider session continuity as proven at the Chat2API/Qwen web-session layer.
- Treat full OpenCode agent capability as not yet proven. The next node should focus on managed-tool retry/repair or stricter turn prompts for Qwen after tool results, then rerun the OpenCode gate.

### Node 5: OpenAI Route Session Identity Closure

Planning timebox: 20-30 minutes
Execution timebox: 35-55 minutes
Review/verification timebox: 25-40 minutes

Owner split:

- Main agent owns this written plan, acceptance, and review.
- Worker subagent (`gpt-5.4`, low reasoning) owns the code execution only after this node is documented.

Problem statement:

- `forwardQwen()` can reuse provider sessions only when its `conversationStateKey` is stable.
- `/v1/chat/completions` currently does not set `context.providerConversationSessionKey`.
- If the client omits OpenAI `user`, `buildProviderConversationStateKey()` uses `context.requestId`, which is unique per request.
- Result: multi-turn requests through the default OpenAI route can create one Qwen website conversation record per turn.
- Boundary: if a client sends neither a stable identity (`user`/header/metadata) nor any repeated history, Chat2API cannot safely infer conversation continuity. This node targets default OpenAI-style clients that omit `user` but resend stable conversation history.

Files for worker:

- `src/main/proxy/routes/chat.ts`
- new or existing route identity helper under `src/main/proxy/routes/`
- route tests under `tests/routes/`
- proxy probe script under `scripts/probes/`

Task plan for worker:

1. Add an OpenAI chat session identity helper, modeled after `anthropicSession.ts` but named for the OpenAI route.
2. Identity priority must be:
   - explicit request headers: `x-session-id`, `x-conversation-id`, `x-chat-session-id`, `x-client-session-id`
   - request body `user`
   - request body metadata fields if the type already permits or a safe `any` access is required: `session_id`, `sessionId`, `conversation_id`, `conversationId`, `thread_id`, `threadId`
   - derived hash from stable conversation prefix: client IP + provider id + model + earliest stable user/assistant text prefix from resent history
   - process fallback only if no stable prefix exists
3. In `chat.ts`, derive the identity after provider/account/model selection and pass it to both:
   - `toolCatalogSessionKey`
   - `providerConversationSessionKey`
4. Keep INV-001 intact: do not move tool prompt injection into any provider adapter.
5. Keep existing `request.user` support; this node must broaden the default path, not remove the explicit user path.
6. Add deterministic tests proving:
   - same message prefix without `user` derives the same key across two requests
   - different first user prefix derives a different key
   - explicit header wins over derived hash
   - `chat.ts` passes the derived key into `providerConversationSessionKey`
7. Add or update a proxy probe script that can validate the live route behavior without relying on source inspection.

Live validation command:

```powershell
# Terminal 1
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev-qwen-session.log

# Terminal 2, before Node 5 fix: expected to fail reuse when no user/header is sent,
# even though the second request resends stable OpenAI history
node .\scripts\probes\qwen-proxy-session-identity-probe.mjs --model "Qwen3.7-Max" --log .\dev-qwen-session.log --no-user

# Terminal 2, after Node 5 fix: expected to reuse one Qwen provider session
node .\scripts\probes\qwen-proxy-session-identity-probe.mjs --model "Qwen3.7-Max" --log .\dev-qwen-session.log --no-user
```

Live validation acceptance:

- Before the fix, the probe must show at least two Qwen `Session info` blocks with different `sessionId` values or a second block whose `parentReqId` is `undefined`.
- After the fix, the probe must show the second turn reusing the first Qwen `sessionId`.
- After the fix, the second turn must have `parentReqId` equal to the first turn response `reqId` or at least not be `undefined`.
- The probe must print the model answer preview, but the authoritative reuse evidence is the Qwen `Session info` sequence from the dev log.
- The no-user probe intentionally resends stable OpenAI history on turn 2. It is not proof that identity-free, history-free requests can be correlated.
- If cleanup is disabled, the probe must state that it may create website-side Qwen records. Do not run broad delete-all cleanup as part of this node.

Pre-fix live validation result on 2026-07-13:

Command:

```powershell
node .\scripts\probes\qwen-proxy-session-identity-probe.mjs --model "Qwen3.7-Max" --log .\dev-qwen-session.log --no-user --expect fresh
```

Observed:

- First turn Qwen `sessionId`: `ec22882a4f544cb281f242a2d6a4df69`
- First turn Qwen `reqId`: `853fc6c39b914c589f17b9a9422e21c7`
- Second turn Qwen `sessionId`: `0ec0880740624391932902e588ab5c84`
- Second turn Qwen `parentReqId`: `undefined`
- Probe result: `ok: true` for the expected pre-fix failure mode.

Control command:

```powershell
node .\scripts\probes\qwen-proxy-session-identity-probe.mjs --model "Qwen3.7-Max" --log .\dev-qwen-session.log --expect reuse
```

Observed:

- First turn Qwen `sessionId`: `2c529e583dd64199b70859986ecd9b08`
- First turn Qwen `reqId`: `2ce0b5d4428249e19836f91e96304491`
- Second turn Qwen `sessionId`: `2c529e583dd64199b70859986ecd9b08`
- Second turn Qwen `parentReqId`: `2ce0b5d4428249e19836f91e96304491`
- Probe result: `ok: true` for fixed-user reuse.

Interpretation:

- Qwen provider-session reuse works when the route supplies a stable identity.
- The default no-user OpenAI route still fails provider-session reuse even when the second request resends stable OpenAI history.

Post-fix live validation result on 2026-07-13:

Command:

```powershell
node .\scripts\probes\qwen-proxy-session-identity-probe.mjs --model "Qwen3.7-Max" --log .\dev-qwen-session.log --no-user --expect reuse
```

Observed:

- First turn Qwen `sessionId`: `2609690b43214712bc1e3b39c6a73ae6`
- First turn Qwen `reqId`: `6458a71003874d18a154c1ebce763c87`
- Second turn Qwen `sessionId`: `2609690b43214712bc1e3b39c6a73ae6`
- Second turn Qwen `parentReqId`: `6458a71003874d18a154c1ebce763c87`
- Probe result: `ok: true` for no-user, history-derived reuse.

Interpretation:

- The OpenAI chat route now supplies a stable provider conversation key for no-user clients that resend conversation history.
- This closes the route-level gap that caused one Qwen website conversation record per turn in that default client shape.
- Main-agent review caught and fixed one subagent gap before live acceptance: the first implementation derived the hash from the first three user/assistant messages, which would change between turn 1 and an appended-history turn 2. The accepted implementation derives from the first stable user/assistant text only.

Targeted deterministic result:

```powershell
node --test tests/routes/openai-session-identity.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/qwen-request-routing.test.ts
```

Observed: 17 passing tests.

Regression gate result:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Observed: 272 passing tests.

Deterministic verification:

```powershell
node --test tests/routes/openai-session-identity.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/qwen-request-routing.test.ts
```

Regression gate after worker returns:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Main-agent review checklist:

- The route identity helper is route-level code, not provider adapter code.
- Header/body explicit identity wins over derived hash.
- Derived hash uses stable early conversation content, not `requestId`.
- The same OpenAI conversation sent without `user` maps to the same `providerConversationSessionKey` across turns.
- A different conversation does not collide with the first conversation under ordinary use.
- The key is namespaced, for example `openai-chat:<hash>` or equivalent.
- Logs or tests make the failure mode visible if the route falls back to per-request identity.
- Existing Anthropic route behavior is not changed.

Subagent handoff requirements:

- Return a compact handoff with changed files, tests run, and any failed live probe output.
- Do not declare final acceptance.
- Do not broaden scope into managed-tool retry/repair; that remains a later node.

## Risks

- Qwen may keep memory by `session_id` but still use `parent_req_id` for branching; preserve both.
- Delete-after-chat config can erase provider state; state saving must respect deletion behavior.
- Assembly path currently flattens history; session continuity should not be used as an excuse to remove prompt fallback too early.
- Existing `.claude/worktrees/tool-contract-refactor` has internal untracked `.agent-probe/`; do not delete it without user approval.

## Delegation Rules

- Main agent owns spec, review, integration decisions, and checkpoint summaries.
- Worker owns only assigned code files for each node.
- Worker must use model `gpt-5.4` and low reasoning.
- Worker must not revert unrelated changes.
- Worker must compress final state after each node.
