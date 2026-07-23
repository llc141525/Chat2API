# Solidify Tool Injection Contract - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode Single Ownership and tool injection rules as both machine-readable ADR comments in source files and human-readable documentation in AGENTS.md, making contract violations detectable in code review and CI.

**Architecture:** Update AGENTS.md with a dedicated Tool Injection Rule section; add ADR header comments to ToolCallingEngine.ts and each provider adapter; mark legacy functions in tools.ts as @deprecated with safety annotations; restrict hasToolPromptInjected usage in PromptAdapters to formatting-only with safety comments.

**Tech Stack:** Markdown, TypeScript JSDoc/ADR comments

## Global Constraints

- INV-001 [Single Ownership]: `ToolCallingEngine` is the sole owner of tool prompt injection. Provider Adapters must never import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`.
- INV-002 [Stateless Fallback]: Any tool resolution logic depending on Session Store must have a stateless degradation path: `Session Store → Message History Extraction → Request Tools → Safe Empty`. Returning an empty tool list without fallback is forbidden.
- INV-003 [Delete = Risk]: Deleting any tool/message processing code during refactoring requires explicit declaration of original purpose and equivalent coverage proof in the PR description. Unprovable deletions must be retained with `// TODO: investigate why this exists`.
- INV-004 [Client Quirks Matrix]: All tool-calling changes must be verified against the known client behavior quirks list, not solely against OpenAI official documentation.

---

### Task 1: Add Tool Injection Rule Section to AGENTS.md

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: INV-001 through INV-004 from master spec
- Produces: New "Tool Injection Rules" section in AGENTS.md that agents and reviewers reference

- [ ] **Step 1: Read current AGENTS.md**

Read `E:\Chat2API\AGENTS.md` to find the insertion point after the existing "Tool Calling Requirements" section.

- [ ] **Step 2: Add Tool Injection Rules section**

Insert after the existing "Tool Calling Requirements" section:

typescript
// SAFETY: Used only for formatting decision; never for injection control.
// Tool injection is owned exclusively by ToolCallingEngine.
if (hasToolPromptInjected(messages)) { ... }


- [ ] **Step 3: Commit**



---

### Task 2: Add ADR Comments to ToolCallingEngine.ts

**Files:**
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`

**Interfaces:**
- Consumes: INV-001 definition
- Produces: Machine-readable ADR header comment at file top

- [ ] **Step 1: Read ToolCallingEngine.ts header**

Read the first 30 lines of `src/main/proxy/toolCalling/ToolCallingEngine.ts`.

- [ ] **Step 2: Add ADR header comment**

Insert at the very top of the file (before imports):



- [ ] **Step 3: Commit**



---

### Task 3: Add ADR Comments to Each Provider Adapter

**Files:**
- Modify: `src/main/proxy/adapters/glm.ts` (or equivalent GLM adapter file)
- Modify: `src/main/proxy/adapters/qwen.ts`
- Modify: `src/main/proxy/adapters/minimax.ts`
- Modify: `src/main/proxy/adapters/kimi.ts`
- Modify: `src/main/proxy/adapters/deepseek.ts`

**Interfaces:**
- Consumes: INV-001 definition
- Produces: ADR header comment in each adapter file declaring non-ownership of tool injection

-- [ ] **Step1: Add ADR header to each adapter file**

Insert at the top of each adapter file (before imports):



- [ ] **Step 2: Verify no forbidden imports exist**

Run grep to confirm none of the adapter files currently import forbidden symbols:



Expected: No matches. If matches found, they must be removed or moved to PromptAdapter layer before committing.

- [ ] **Step 3: Commit**



---

### Task 4: Mark Legacy Functions as @deprecated in tools.ts

**Files:**
- Modify: `src/main/proxy/utils/tools.ts`

**Interfaces:**
- Consumes: Current function signatures at lines 20-31, 45-64, 108-182, 184-196
- Produces: @deprecated JSDoc tags with safety guidance on each legacy function

- [ ] **Step 1: Add @deprecated to hasToolPromptInjected**

At line 20, add before the function:



- [ ] **Step 2: Add @deprecated to shouldInjectToolPrompt**

At line 45, add before the function:



- [ ] **Step 3: Add @deprecated to toolsToSystemPrompt**

At line 108, add before the function:



- [ ] **Step 4: Add @deprecated to TOOL_WRAP_HINT**

At line 184, add before the constant:



- [ ] **Step 5: Commit**



---

### Task 6: Audit and Annotate PromptAdapter hasToolPromptInjected Usage

**Files:**
- Modify: PromptAdapter files that use `hasToolPromptInjected` (check `src/main/proxy/promptAdapters/`)

**Interfaces:**
- Consumes: `hasToolPromptInjected` from `tools.ts`
- Produces: Safety comment on every usage site

- [ ] **Step 1: Find all hasToolPromptInjected usages in PromptAdapters**

Run: `rg "hasToolPromptInjected" src/main/proxy/promptAdapters/`

- [ ] **Step 2: Add safety comment to each usage**

For each match, add immediately above the usage:



- [ ] **Step 3: Verify no Provider Adapter usages remain**

Run: `rg "hasToolPromptInjected" src/main/proxy/adapters/`
Expected: No matches.

- [ ] **Step 4: Commit**