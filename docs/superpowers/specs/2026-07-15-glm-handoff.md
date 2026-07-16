# 2026-07-15 GLM Focus Handoff

## Current Priority

Stop expanding the provider matrix for now. Qwen / MiniMax / Mimo / Kimi / Z.ai migration evidence is useful background, but the active acceptance target is GLM (`glm/GLM-5.2`) short probe recovery.

The user's latest observation is decisive:

- GLM can still produce valid managed XML tool-call text in the ChatGLM web UI.
- The visible failure is concentrated around summarization / compact behavior.
- The old architecture did not fail the GLM short probe, so a recent session / compact / summary change likely broke GLM behavior.

## What Is Already Known

1. GLM is not completely unable to answer.
   The screenshot shows ChatGLM emitting:

   ```text
   <|CHAT2API|tool_calls><|CHAT2API|invoke name="bash">...
   ```

   This means the managed XML prompt contract can still influence GLM.

2. Summary attempts can create useless provider-side conversations.
   The screenshot shows the summary prompt:

   ```text
   Summarize the earlier conversation as procedural state...
   ```

   and GLM replying:

   ```text
   No conversation to summarize.
   ```

3. The local `SummaryStrategy` currently rejects no-op summaries such as `No conversation to summarize.` and uses local fallback summaries instead.
   That protects the parent request from ingesting the bad text, but it does not prove the provider website was not polluted by an unnecessary summary child conversation.

4. A later guard was added in `src/main/proxy/forwarder.ts` so `createSummaryGenerator()` skips provider summary calls if sanitized summary input has no real non-system history.
   This is directionally correct, but GLM still needs focused verification because screenshots show the provider was receiving bad summary requests before this guard.

## Do Not Spend Time On

- Parser-only fixes for GLM managed XML unless a deterministic parser test fails.
- Provider-matrix work for non-GLM models.
- Qwen-specific session economics unless the same primitive is directly reused by GLM.
- Broad refactors of all provider adapters.

## Files Most Relevant To GLM Recovery

- `src/main/proxy/forwarder.ts`
  - `createSummaryGenerator()`
  - `forwardChatCompletion()`
  - `forwardGLM()`
  - ProviderRuntime pilot gate.

- `src/main/proxy/services/contextManagementService.ts`
  - `SummaryStrategy`
  - `buildLocalFallbackSummary()`
  - `summaryGenerated` handling.

- `src/main/proxy/services/summarySanitizer.ts`
  - Sanitizes history before external summary generation.

- `src/main/proxy/adapters/glm.ts`
  - `GLMAdapter.chatCompletion()`
  - `GLMAdapter.chatCompletionWithAssembly()`
  - `messagesToPrompt()`
  - `GLMStreamHandler`.

- `src/main/proxy/plugins/GLMProviderPlugin.ts`
  - ProviderRuntime plugin path for GLM.

- `src/main/proxy/services/ProviderRuntime.ts`
  - Unified runtime session read/write.
  - `sessionBoundaryReason` handling.

- `tests/providers/glm-tool-calling.test.ts`
  - GLM adapter, stream, managed XML, and prompt-shape tests.

- `tests/services/contextManagement-summary-failure-diagnostic.test.ts`
  - Summary fallback tests.

- `tests/providers/provider-runtime-main-path.test.ts`
  - Runtime summary / session-boundary tests.

## Working Hypothesis

The breakage is in the summary / compact boundary rather than in GLM's ability to follow tools.

The strongest suspicious area is:

1. Context management decides a summary is needed.
2. External summary generation may be called with sanitized-empty or structurally wrong input.
3. GLM creates a provider-side summary child conversation and replies `No conversation to summarize.`
4. Local fallback may prevent that exact text from entering parent context, but the following `server_summary` request must still carry a useful local summary into a fresh GLM provider session.
5. If that fresh session is missing the summary text, using the wrong conversation id, or losing tool contract placement, the short probe fails even though GLM can answer ordinary turns.

## Acceptance Bar For GLM

The fix is not accepted until all of these are true:

1. Deterministic tests show GLM summary fallback creates a usable `server_summary` request with:
   - a fresh provider boundary,
   - local fallback summary text in the final provider prompt,
   - current tool manifest still present,
   - no old provider conversation id reused after compact.

2. Deterministic tests show sanitized-empty summary input does not call the provider.

3. A real short OpenCode probe passes with `glm/GLM-5.2`.

4. `dev.log` proves the actual GLM request path used by the probe:
   - old dedicated adapter path, or
   - ProviderRuntime plugin path.

5. The ChatGLM web UI should not show new useless `No conversation to summarize.` summary child conversations during the accepted probe.

