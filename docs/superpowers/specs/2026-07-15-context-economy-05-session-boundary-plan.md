# Context Economy 05: Provider Session Boundary Plan

## Objective

Make provider web-session reuse/freshness explicit and enforce it in `ProviderRuntime` and plugins.

## Current Problem

Internal keys can fork via `forkProviderConversationContext()`, but acceptance has relied mostly on internal key shape. Browser exports show provider-visible sessions can still receive growing context. We need request-shape proof that `sessionId` / `conversationId` is reused or reset correctly.

## Implementation

Create:

```text
src/main/proxy/services/sessionBoundaryPlan.ts
```

Export:

```ts
export interface SessionBoundaryPlan {
  boundary: 'normal' | 'client_compact' | 'server_summary' | 'summary_generator' | 'tool_child' | 'subagent_child'
  providerSessionAction: 'reuse_parent' | 'start_fresh' | 'start_child' | 'consume_child_handoff'
  parentProviderSessionKey?: string
  childProviderSessionKey?: string
  expectedProviderSessionIdReuse: boolean
}

export function buildSessionBoundaryPlan(input: {
  context: ProxyContext
  priorState?: ConversationState
  request: ChatCompletionRequest
}): SessionBoundaryPlan
```

Extend plugin input type with:

```ts
sessionBoundaryPlan?: SessionBoundaryPlan
```

## Provider Rules

Qwen:

- `normal`: reuse `qwenSessionId` when available.
- `server_summary`: fresh `sessionId`.
- `client_compact`: fresh `sessionId`.
- `summary_generator`: fresh `sessionId`.
- `tool_child` / `subagent_child`: fresh child `sessionId`.

GLM:

- `normal`: reuse `conversationId` when available.
- `server_summary`: fresh `conversation_id`.
- `client_compact`: fresh `conversation_id`.
- `summary_generator`: fresh `conversation_id`.
- `tool_child` / `subagent_child`: fresh child `conversation_id`.

Other providers follow the same default unless a provider doc/test proves a different session model.

## Dedicated GLM Path

If `forwardGLM()` remains supported outside ProviderRuntime, it must obey the same plan. In particular:

- pass `convState?.conversationId` only for `normal`;
- pass no conversation id for compact/summary/child boundaries.

## Tests

Add:

- `Qwen normal reuses parent sessionId`
- `Qwen server_summary starts fresh sessionId`
- `Qwen client_compact starts fresh sessionId`
- `Qwen tool_child starts fresh child sessionId`
- `GLM normal reuses conversationId`
- `GLM server_summary starts fresh conversationId`
- `GLM dedicated path follows SessionBoundaryPlan`

## Acceptance

- Tests assert actual provider request body/session fields, not only internal keys.
- `dev.log` diagnostics include `providerSessionAction` and `providerSessionIdSource`.

