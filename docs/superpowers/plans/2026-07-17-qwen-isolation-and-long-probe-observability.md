# Qwen isolation and long-probe observability

## Evidence

- `05db0ca` is the last recorded Qwen long-task milestone.
- Qwen does **not** declare `requestThrottle`; the GLM account request gate cannot directly delay Qwen requests.
- The current Qwen assembly explicitly uses `dropRuntimeConfig: true`.
- A current Qwen long-run trace shows a post-compaction request with `messageCount: 1`, `systemMessageCount: 0`, and `promptRefreshMode: tool_ready`.
- The runtime identity supplied by OpenCode is commonly a configuration-shaped system message. Current infrastructure extraction ignores such a message entirely, so a compacted Qwen request can lose its workspace identity while correctly removing the large tool contract.

## Acceptance criteria

1. A compacted Qwen request retains a bounded, authoritative workspace anchor (working directory/root) while excluding raw runtime configuration and historical tool contracts.
2. Qwen never activates GLM-only request throttling. A runtime regression test proves this isolation.
3. The long probe exercises and verifies: workspace grounding, tool-chain continuity across compaction, no duplicate tool inputs, no malformed/XML user-visible output, bounded actual assembly size, and per-tool latency.
4. The log extractor consumes both proxy logs and OpenCode NDJSON, emits a provider-scoped audit, and exits non-zero in strict mode for any invariant breach.
5. Both `qwen/Qwen3.7-Max` and `glm/GLM-5.2` pass the redesigned real probe and their audited logs contain no flagged anomaly.

## Design

### Bounded execution-environment projection

Keep the current removal of tool catalog/history. Add a small projection built only from runtime configuration lines that state the execution root (for example `Working directory`, `Workspace`, `Project root`, `CWD`, or an absolute path associated with one of these labels). Render it separately as an authoritative execution-environment block. Never retain unbounded system instructions, skills, or contract text.

### Provider isolation

Keep rate limiting opt-in through each plugin capability. Qwen has no throttle capability; GLM continues to own its gate. Record the gate decision in structured runtime diagnostics so a log audit can prove which provider was gated.

### Probe phases

1. Establish workspace identity with a `bash` call that records `$PWD` and creates a sentinel under `.agent-probe`.
2. Read the sentinel by relative path and verify the model continues from the same root.
3. Force enough tool exchanges to cross compaction while requiring distinct read/bash inputs.
4. Require a final verification tool call to compare the recorded and current directories.
5. Require one exact final marker only after the verification result.

The probe writes a structured run manifest with timestamps and expected tool calls. Its verifier compares OpenCode NDJSON with the manifest instead of treating a final marker as sufficient.

### Audit output

Extend `extract-session-log.ps1` with `-EventsPath`, `-Provider`, and `-Strict`. Correlate proxy request traces, assembly traces, runtime gate traces, and NDJSON timestamps. Flag: missing workspace proof, cross-provider gate, duplicate tool input, tool-result without a matching call, raw protocol text, malformed output/retry, session action inconsistency, post-compact prompt growth, and latency above the observed per-run baseline.

## Verification order

1. Add failing focused regression tests for workspace projection and Qwen/GLM gate isolation.
2. Implement the bounded projection and diagnostics.
3. Run focused tests, core regression, lint, and build.
4. Run the redesigned real probe separately for Qwen and GLM.
5. Run strict log audit for each run. Any audit flag returns the work to step 1.
