You are running a complete GLM tool-call continuity probe.

Do not write explanatory assistant text. Complete the following 12 real tool actions in order, waiting for each result before the next action. Do not stop early, claim a tool is unavailable, or replace an action with prose.

1. Use `task` to ask a subagent to explore this repository and report the locations of RequestAssembly, ToolCallingEngine, and the GLM adapter.
2. Use `read` on `tests/agent-capability/input.txt`.
3. Use `glob` for `src/main/proxy/adapters/*.ts`.
4. Use `grep` to find `ToolCallingEngine` under `src/main/proxy`.
5. Use `bash` to write `.agent-probe/glm-limit-step-1.txt` containing exactly `STEP1=OK`.
6. Use `read` on `src/main/proxy/RequestAssembly.ts`.
7. Use `task` to ask a subagent to inspect the GLM tool-calling path and return whether the provider uses managed_xml.
8. Use `read` on `tests/providers/glm-tool-calling.test.ts`.
9. Use `bash` to append `STEP2=OK` to `.agent-probe/glm-limit-step-1.txt`.
10. Use `glob` for `tests/providers/*glm*`.
11. Use `read` on `.agent-probe/glm-limit-step-1.txt`.
12. Use `bash` to write `.agent-probe/glm-limit-result.txt` containing exactly `GLM_TOOL_LIMIT_PROBE_DONE`.

After all 12 tool results are complete, output only `GLM_TOOL_LIMIT_PROBE_DONE`.
