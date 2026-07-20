---
name: white-ui-audit-probe
description: Analyze project white-themed UI design, discuss findings, and produce a concrete audit spec document. Proves multi-turn knowledge accumulation through context compaction.
---

# White-UI Audit Probe — Skill Definition
# Invoked by the agent via `skill` tool: skill_view(name="white-ui-audit-probe")

## Task
Analyze the Chat2API project's white-themed UI design system, then produce a concrete audit spec.

## Step-by-step workflow (follow EXACTLY)

### Phase 1: Discovery
1. Read `E:\Chat2API\tailwind.config.js` — extract color tokens only (skip non-color config)
2. Read `E:\Chat2API\src\renderer\src\index.css` — extract CSS variables only
3. Glob `E:\Chat2API\src\renderer\src\**\*.tsx` to find component files
4. Read EXACTLY 2 component files from the glob results — pick the first 2 non-index files
5. Write findings to `.agent-probe/white-ui-notes.txt` — format as bullet points

### Phase 2: After compaction (context may be summarized)
6. Re-read `.agent-probe/white-ui-notes.txt` to recover your findings
7. Read EXACTLY 2 MORE component files (different from Phase 1)
8. Append new findings to `.agent-probe/white-ui-notes.txt`

### Phase 3: Decision
9. Write `.agent-probe/white-ui-decision.txt` with:
   - 1-sentence consistency verdict (yes/no)
   - 2 file path + line content examples
   - 1 recommendation

### Phase 4: Final spec
10. Read `.agent-probe/white-ui-notes.txt` and `.agent-probe/white-ui-decision.txt`
11. Write `.agent-probe/white-ui-audit.md` with 4 sections:

```
## Section 1: Color Tokens
(token name → value from files read)

## Section 2: Findings
(specific file paths + concrete observations)

## Section 3: Coverage
(files analyzed count, component types touched)

## Section 4: Recommendations
(2-3 numbered, specific, actionable items)

WHITE_UI_AUDIT_DONE
```

## Pitfalls
- Read EXACTLY 2 files in Phase 1, EXACTLY 2 in Phase 2 — not more
- Do NOT re-read tailwind.config.js or index.css after Phase 1
- The marker `WHITE_UI_AUDIT_DONE` MUST be the last line of white-ui-audit.md
- Keep notes.txt under 30 lines total
