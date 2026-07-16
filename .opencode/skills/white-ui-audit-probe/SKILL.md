---
name: white-ui-audit-probe
description: Analyze project white-themed UI design, discuss findings, and produce a concrete audit spec document. Proves multi-turn knowledge accumulation through context compaction.
---

# White-UI Audit Probe — Skill Definition
# Invoked by the agent via `skill` tool: skill_view(name="white-ui-audit-probe")

## Task
Analyze the Chat2API project's white-themed UI design system, then produce a concrete audit spec.

## Step-by-step workflow (follow EXACTLY)

### Phase 1: Discovery (must execute sequentially)
1. Read `E:\Chat2API\tailwind.config.js` to understand color tokens and theme configuration
2. Read `E:\Chat2API\src\renderer\src\index.css` for base styles and CSS variables
3. Glob `E:\Chat2API\src\renderer\src\**/*.tsx` to find component files
4. Pick 3-5 representative TSX component files and read them, noting how colors/spacing are used
5. Write your findings to `.agent-probe/white-ui-notes.txt` — list every white/light color token you found,
   which files use them, and any inconsistency you notice

### Phase 2: After compaction (context may be summarized)
6. Re-read `.agent-probe/white-ui-notes.txt` to recover your findings
7. Read 3-5 MORE component files (different from Phase 1) to expand coverage
8. Update `.agent-probe/white-ui-notes.txt` with additional findings

### Phase 3: Discussion (probe interactive continuity)
9. Write a decision summary to `.agent-probe/white-ui-decision.txt` with:
   - Whether the white theme is consistent across all components you checked
   - At least 2 specific examples from actual files (file path + line content)
   - At least 1 recommendation for improvement

### Phase 4: Final spec
10. Read both `.agent-probe/white-ui-notes.txt` and `.agent-probe/white-ui-decision.txt`
11. Write the final audit spec to `.agent-probe/white-ui-audit.md` with:
    - Section 1: Color tokens inventory (token name → value → usage count)
    - Section 2: Inconsistency findings (specific file paths + concrete examples)
    - Section 3: Component coverage (files analyzed, patterns found)
    - Section 4: Recommendations (numbered, specific, actionable)
    - Section 5: A truth marker: `WHITE_UI_AUDIT_DONE`

## Pitfalls
- Do not skip Phase 1 steps — you MUST read actual files before writing notes
- In Phase 2, read files you have NOT read before — don't re-read the same ones
- Use exact file paths in your output
- The final marker `WHITE_UI_AUDIT_DONE` must appear in `.agent-probe/white-ui-audit.md`
