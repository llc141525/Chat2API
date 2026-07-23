# Tool Calling Resilience & Architecture Immunization - Master Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each module plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Qwen multi-turn tool context loss incident into systematic architectural immunity across fallback chains, integration tests, contract solidification, and CI enforcement.

**Architecture:** Four independent modules targeting distinct layers of the tool-calling stack. Each module produces working, testable software on its own and can be executed in any order, though Phase 1 → 2 → 3 → 4 is recommended.

**Tech Stack:** TypeScript, Node.js, ESLint custom rules, Vitest/Jest (match existing test runner), Electron main process

## Global Constraints

- INV-001 [Single Ownership]: `ToolCallingEngine` is the sole owner of tool prompt injection. Provider Adapters must never import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`.
- INV-002 [Stateless Fallback]: Any tool resolution logic depending on Session Store must have a stateless degradation path: `Session Store → Message History Extraction → Request Tools → Safe Empty`. Returning an empty tool list without fallback is forbidden.
- INV-003 [Delete = Risk]: Deleting any tool/message processing code during refactoring requires explicit declaration of original purpose and equivalent coverage proof in the PR description. Unprovable deletions must be retained with `// TODO: investigate why this exists`.
- INV-004 [Client Quirks Matrix]: All tool-calling changes must be verified against the known client behavior quirks list, not solely against OpenAI official documentation.

## Module Index

| # | Module Plan File | Spec Phase | Priority | Description |
|---|-----------------|------------|----------|-------------|
| 1 | [fix-catalog-fallback-chain.md](./fix-catalog-fallback-chain.md) | Phase 1 + INV-002 | P0 | Restore tool definition fallback chain; ensure prompt injection never loses tools |
| 2 | [add-adapter-integration-tests.md](./add-adapter-integration-tests.md) | Phase 2 + INV-004 | P0.5 | Permanent regression tests covering all 5 adapters end-to-end |
| 3 | [solidify-tool-injection-contract.md](./solidify-tool-injection-contract.md) | Phase 3 + INV-001 | P1 | Machine-readable + human-readable dual constraints in code and docs |
| 4 | [eslint-immunization.md](./eslint-immunization.md) | Phase 4 + INV-001 | P2 | ESLint custom rules + CI pipeline to block violating code at build time |

## Execution Order Recommendation



Each module is self-contained. Execute via subagent-driven-development (one fresh subagent per task within each module) or inline via executing-plans.

## Anti-Patterns (Explicitly Forbidden)

- Modifying `catalog.ts` core parsing logic without test protection
- Directly concatenating tool definition strings in Provider Adapters
- Assuming all clients carry complete tools arrays in every turn
- Removing legacy fallback code without providing equivalent replacement
- Introducing new stateful storage without designing a stateless degradation path