# ESLint Immunization - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build automated enforcement that prevents Provider Adapter files from importing forbidden tool injection symbols, integrated into CI as a mandatory gate.

**Architecture:** Create an ESLint custom rule (`no-adapter-tool-injection`) that statically detects forbidden imports in adapter files. Configure ESLint to apply this rule only to `src/main/proxy/adapters/**`. Add the lint command to CI pipeline configuration. Optionally add TypeScript path restrictions via tsconfig.

**Tech Stack:** ESLint (flat config or legacy), TypeScript, CI pipeline (GitHub Actions or equivalent)

## Global Constraints

- INV-001 [Single Ownership]: `ToolCallingEngine` is the sole owner of tool prompt injection. Provider Adapters must never import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`.
- INV-002 [Stateless Fallback]: Any tool resolution logic depending on Session Store must have a stateless degradation path: `Session Store → Message History Extraction → Request Tools → Safe Empty`. Returning an empty tool list without fallback is forbidden.
- INV-003 [Delete = Risk]: Deleting any tool/message processing code during refactoring requires explicit declaration of original purpose and equivalent coverage proof in the PR description. Unprovable deletions must be retained with `// TODO: investigate why this exists`.
- INV-004 [Client Quirks Matrix]: All tool-calling changes must be verified against the known client behavior quirks list, not solely against OpenAI official documentation.

---

### Task 1: Determine ESLint Configuration Format

**Files:**
- Read: Project root for ESLint config files

**Interfaces:**
- Consumes: Existing project lint setup
- Produces: Decision on flat config vs legacy config format

- [ ] **Step 1: Check existing ESLint setup**

Run: `Get-ChildItem -Path E:\Chat2API -Filter "eslint*" -Recurse -Depth 2 | Select-Object FullName`

Also check `package.json` for eslint-related dependencies and scripts.

- [ ] **Step 2: Determine config format**

If `eslint.config.*` exists → flat config format.
If `.eslintrc*` exists → legacy format.
If neither exists → create flat config (modern default).

- [ ] **Step 3: Document finding**

Note the config format and file path for subsequent tasks. No commit needed.

---

### Task 2: Create Custom ESLint Rule `no-adapter-tool-injection`

**Files:**
- Create: `eslint-rules/no-adapter-tool-injection.js`

**Interfaces:**
- Consumes: ESLint rule API
- Produces: Rule that reports errors when adapter files import forbidden symbols

- [ ] **Step 1: Create the rules directory**



- [ ] **Step 2: Write the custom rule**

Create `eslint-rules/no-adapter-tool-injection.js`:



- [ ] **Step 3: Commit**



---

### Task 3: Configure ESLint to Apply the Custom Rulele

**Files:** Modify or Create: ESLint config file (determined in Task 1)

**Interfaces:**
- Consumes: Custom rule from Task 2
- Produces: ESLint configuration that applies the rule to adapter files

- [ ] **Step 1: For flat config (eslint.config.js/mjs)**

Add to the config array:



- [ ] **Step 1 (alt): For legacy config (.eslintrc.js)**

Add to rules section:



- [ ] **Step 2: Verify rule works**

Run: `npx eslint src/main/proroxy/adapters/-rule '{"chat2api/no-adapter-tool-injection": "error"}'`

Expected: No errors (adapters should already be clean). If errors appear, fix the adapter imports first.

- [ ] **Step 3: Test with intentional violation**

Temporarily add `import { hasToolPromptInjected } from '../utils/tools'` to an adapter file, run eslint, confirm it catches the violation, then remove the test import.

- [ ] **Step 4: Commit**



---

### Task 4: Add Lint Command to Package Scripts

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: ESLint configuration from Task 3
- Produces: `npm run lint` script that includes the custom rule check

- [ ] **Step 1: Check existing lint script**

Read `package.json` scripts section.

- [ ] **Step 2: Add or update lint script**

If no lint script exists, add:



If lint script exists, ensure it covers `src/main/proxy/adapters/`.

- [ ] **Step 3: Verify lint passes**

Run: `npm run lint`
Expected: PASS with no errors.

- [ ] **Step 4: Commit**



---

### Task 5: Integrate into CI Pipeline

**Files:**
- Modify or Create: CI config (`.github/workflows/ci.yml` or equivalent)

**Interfaces:**
- Consumes: `npm run lint` from Task 4
- Produces: CI job that runs lint as a mandatory gate

- [ ] **Step 1: Find CI configuration**

Check for `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, or similar.

- [ ] **Step 2: Add lint job**

For GitHub Actions, add to existing workflow or create new one:



Ensure this job is listed as required in branch protection rules.

- [ ] **Step 3: Add adapter integration tests to CI**

Add test step to the same or separate job:



- [ ] **Step 4: Commit**



---

### Task 6: (Optional) TypeScript Path Restriction

**Files:**
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: TypeScript compiler options
- Produces: Path mapping restriction preventing adapter imports from utils/tools

- [ ] **Step 1: Evaluate feasibility**

TypeScript `paths` cannot directly forbid imports. Consider using `imports` field in `package.json` or a custom TS plugin instead. If neither is practical, skip this task and rely on ESLint enforcement.

- [ ] **Step 2: If feasiblele, add restriction

Document approach chosen and implement. If skipped, add a comment in AGENTS.md noting that ESLint is the primary enforcement mechanism.

- [ ] **Step 3: Commit (if applicable)**