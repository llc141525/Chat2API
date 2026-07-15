# Context Economy 06: Prompt Budget And Acceptance Tests

## Objective

Enforce context economy and define deterministic plus real-provider acceptance.

## Prompt Budget Rules

`promptBudgetPolicy` should make repeated full refresh exceptional:

- `full`: first request, repair, or explicit boundary requiring current full contract.
- `tool_ready`: active tool continuation requiring exact next tool call.
- `digest`: compacted session with workflow digest and known catalog fingerprint.
- `minimal`: stable session with no tool change and no active tool continuation.

Full prompt refresh must be measured and logged.

## Deterministic Fixture Tests

Use the exported JSON shapes as fixtures or derived reduced fixtures:

- main session: 52-turn / repeated OpenCode + tool contract shape;
- tool session: two-message 103KB tool-call shape;
- summary session: contaminated summary input with `superpowers` / `SUBAGENT-STOP`.

Add tests:

1. main-session fixture compacts to bounded provider prompt;
2. provider prompt after compact has `You are opencode` count `0` unless in current user task;
3. provider prompt after compact has `## Available Tools` count at most `1`;
4. summary input excludes `superpowers`, `SUBAGENT-STOP`, and raw `## Available Tools`;
5. tool definitions survive compact through re-derivation;
6. OpenAI tool call metadata survives compact.

## Regression Gate

Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
node --test tests/services/contextPayloadClassifier.test.ts tests/services/summaryInputQuality.test.ts tests/providers/context-economy-diagnostics.test.ts
node --test tests/providers/provider-runtime-main-path.test.ts tests/providers/qwen-session-continuity.test.ts tests/routes/openai-session-identity.test.ts
npm run build
```

## Qwen Real Acceptance

Run long compact probe.

Collect:

- `.agent-probe/result.json`
- `.agent-probe/opencode-events.ndjson`
- `dev.log` context economy diagnostics
- Qianwen exported main session
- Qianwen exported summary session
- Qianwen exported tool child session

Accept only if:

- final assistant contains `CAPABILITY_PROBE_DONE`;
- event stream contains tool call after tool result;
- main exported session no longer repeats full OpenCode/tool/skill config every turn;
- compact creates fresh provider session or documented native compact equivalent;
- provider prompt diagnostics remain bounded after compact.

## GLM Real Acceptance

Run GLM short probe first.

Accept only if:

- no provider summary call is made for placeholder-only/skill-doc-only input;
- GLM emits managed XML and Chat2API converts it to OpenAI `tool_calls`;
- summary fallback/digest is injected when external summary is skipped or unusable;
- no new `No conversation to summarize.` summary child conversation appears for rejected inputs.

Then run GLM compact probe.

## Final Acceptance

- Qwen long probe passes.
- GLM short probe passes.
- GLM compact probe passes or has a documented provider-side blocker.
- Tool definition loss regression suite passes.
- Build passes.

