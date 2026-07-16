# Step 02: Qwen System Message Preservation

Status: Accepted
Owner: main-session acceptance

## Goal

Prevent Qwen request assembly from dropping the authoritative managed tool contract when more than one `system` message exists.

## Root-Cause Hypothesis

Context management can insert a summary as a `system` message. `ToolCallingEngine` can also inject the managed tool catalog as a `system` message. If the Qwen adapter keeps only one `system` message, either the summary or the tool contract can be lost depending on order.

The observed regression is consistent with the tool contract being dropped after enough turns trigger context management.

## Files In Scope

- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `tests/providers/qwen-request-routing.test.ts`

## Required Behavior

- Qwen request assembly preserves all string `system` messages by concatenating them in order.
- The managed tool contract is placed after non-authoritative summary text when both exist.
- Low-threshold deterministic context processing still produces a final Qwen request containing:
  - prior conversation summary marker
  - managed tool contract
  - catalog fingerprint
  - allowed tool names
  - latest user query

## Acceptance

- `node --test tests/providers/qwen-request-routing.test.ts` passes.
- The full deterministic tool-calling gate passes:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

- No provider adapter imports prompt-injection helper APIs forbidden by INV-001.

## Round Notes

Round 0 reported the deterministic gate passing `260/260`.

Main acceptance:
- Re-ran the full deterministic gate; result `260/260` pass.
- Confirmed adapter forbidden-helper search did not find new INV-001 violations.
