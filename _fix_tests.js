const fs = require('fs');
let t = fs.readFileSync('tests/providers/glm-tool-calling.test.ts','utf8');

// Fix 1: Remove dead-code assertions in test 24
t = t.replace(
  "  assert.match(qwenAiSource, /getProviderToolProfile\\('qwen-ai'\\)/)\n  assert.match(qwenAiSource, /formatAssistantToolCalls/)\n  assert.match(qwenAiSource, /formatToolResult/)",
  "  // These checks verified dead code (deleted chatCompletion methods) — removed in Phase 0a"
);

// Fix 2: Replace buildGLMPromptMessagesForTest with assembly version
t = t.replace(
  'buildGLMPromptMessagesForTest(messagesWithToolPrompt as any)',
  'buildGLMAssemblyPromptMessagesForTest({messages:messagesWithToolPrompt,summaryText:null,infrastructurePrompt:null,toolManifest:null} as any)'
);

fs.writeFileSync('tests/providers/glm-tool-calling.test.ts', t);
console.log('Done. Remaining refs:', (t.match(/buildGLMPromptMessagesForTest/g)||[]).length);
