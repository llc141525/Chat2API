import test from 'node:test'
import assert from 'node:assert/strict'

import { extractPromptEmbeddedTools } from '../../src/main/proxy/toolCalling/clientAdapters/promptEmbeddedToolExtractor.ts'

const OPENCODE_SYSTEM_PROMPT = `You are a coding assistant.

## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
The tool list in this section is authoritative for the current turn.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.
Include ALL required parameters listed in the JSON schema for each tool.
Do not claim that a listed tool is unavailable. If a listed tool is needed, call it directly.

Tool \`read\`: Read a file from disk. Required parameters: file_path
  JSON schema: {"type":"object","properties":{"file_path":{"type":"string","description":"The absolute path to the file to read"}},"required":["file_path"]}
Tool \`bash\`: Execute a shell command. Required parameters: command
  JSON schema: {"type":"object","properties":{"command":{"type":"string","description":"The bash command to run"}},"required":["command"]}
Tool \`mcp_filesystem__list_dir\`: List directory contents.
  JSON schema: {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="argument"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`

const CHERRY_STUDIO_SYSTEM_PROMPT = `You are a helpful assistant.

In this environment you have access to a set of tools you can use to answer the user's question.

<tools>
<tool name="read_file">
<description>Read a file from the filesystem</description>
<parameters>{"type":"object","properties":{"path":{"type":"string","description":"File path"}},"required":["path"]}</parameters>
</tool>
<tool name="write_file">
<description>Write content to a file</description>
<parameters>{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}</parameters>
</tool>
</tools>`

const HEADER_ONLY_PROMPT = `You are a coding assistant.

## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.

Tool \`open_url\`: Open a URL in the browser.
Tool \`search\`: Search the web.

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"></|CHAT2API|invoke></|CHAT2API|tool_calls>`

const NO_TOOL_PROMPT = `You are a helpful assistant. Answer the user's questions.`

test('extracts tools from OpenCode-style ## Available Tools block', () => {
  const messages = [{ role: 'system' as const, content: OPENCODE_SYSTEM_PROMPT }]
  const result = extractPromptEmbeddedTools(messages)

  assert.equal(result.tools.length, 3)

  const names = result.tools.map((t) => t.name)
  assert.ok(names.includes('read'), `Expected 'read' in ${names}`)
  assert.ok(names.includes('bash'), `Expected 'bash' in ${names}`)
  assert.ok(names.includes('mcp_filesystem__list_dir'), `Expected 'mcp_filesystem__list_dir' in ${names}`)

  assert.equal(result.source, 'prompt_embedded')
  assert.equal(result.markers.availableToolsHeader, true)
  assert.equal(result.markers.managedProtocolHeader, true)
  assert.ok(result.rawFingerprint.length > 0)
})

test('extracted tools have correct source label', () => {
  const messages = [{ role: 'system' as const, content: OPENCODE_SYSTEM_PROMPT }]
  const result = extractPromptEmbeddedTools(messages)

  for (const tool of result.tools) {
    assert.equal(tool.source, 'prompt_embedded')
  }
})

test('extracted tools include parsed JSON schemas when present', () => {
  const messages = [{ role: 'system' as const, content: OPENCODE_SYSTEM_PROMPT }]
  const result = extractPromptEmbeddedTools(messages)

  const readTool = result.tools.find((t) => t.name === 'read')
  assert.ok(readTool, 'read tool not found')
  assert.ok(readTool.parameters && typeof readTool.parameters === 'object', 'read tool should have parameters')
  const params = readTool.parameters as Record<string, unknown>
  assert.equal(params.type, 'object')
  assert.ok((params.properties as any)?.file_path, 'should have file_path property')
})

test('extracts tools from Cherry Studio <tools> XML block', () => {
  const messages = [{ role: 'system' as const, content: CHERRY_STUDIO_SYSTEM_PROMPT }]
  const result = extractPromptEmbeddedTools(messages)

  assert.equal(result.tools.length, 2)
  const names = result.tools.map((t) => t.name)
  assert.ok(names.includes('read_file'), `Expected 'read_file' in ${names}`)
  assert.ok(names.includes('write_file'), `Expected 'write_file' in ${names}`)

  assert.equal(result.source, 'prompt_embedded')
  assert.equal(result.markers.mcpServerBlock, true)
})

test('Cherry Studio tools have parsed schemas', () => {
  const messages = [{ role: 'system' as const, content: CHERRY_STUDIO_SYSTEM_PROMPT }]
  const result = extractPromptEmbeddedTools(messages)

  const readTool = result.tools.find((t) => t.name === 'read_file')
  assert.ok(readTool, 'read_file tool not found')
  const params = readTool.parameters as Record<string, unknown>
  assert.equal(params.type, 'object')
})

test('tools without schema blocks get additionalProperties:true stub', () => {
  const messages = [{ role: 'system' as const, content: HEADER_ONLY_PROMPT }]
  const result = extractPromptEmbeddedTools(messages)

  assert.ok(result.tools.length >= 2, `Expected at least 2 tools, got ${result.tools.length}`)
  assert.ok(result.driftKinds.includes('schema_degraded_from_prompt'))

  for (const tool of result.tools) {
    const params = tool.parameters as Record<string, unknown>
    assert.equal(params.type, 'object')
    assert.equal(params.additionalProperties, true)
  }
})

test('returns empty result when no tool signatures present', () => {
  const messages = [{ role: 'system' as const, content: NO_TOOL_PROMPT }]
  const result = extractPromptEmbeddedTools(messages)

  assert.equal(result.tools.length, 0)
  assert.equal(result.markers.availableToolsHeader, false)
  assert.equal(result.markers.managedProtocolHeader, false)
  assert.equal(result.markers.mcpServerBlock, false)
})

test('extractor never mutates input messages', () => {
  const original = OPENCODE_SYSTEM_PROMPT
  const messages = [{ role: 'system' as const, content: original }]
  extractPromptEmbeddedTools(messages)

  assert.equal(messages[0].content, original)
  assert.equal(messages.length, 1)
})

test('deduplicates tools with the same name', () => {
  const duplicatePrompt = `## Available Tools
Tool \`bash\`: Run commands.
  JSON schema: {"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}
Tool \`bash\`: Another bash entry (duplicate).
  JSON schema: {"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}

<|CHAT2API|tool_calls><|CHAT2API|invoke name="x"></|CHAT2API|invoke></|CHAT2API|tool_calls>`

  const messages = [{ role: 'system' as const, content: duplicatePrompt }]
  const result = extractPromptEmbeddedTools(messages)

  const bashTools = result.tools.filter((t) => t.name === 'bash')
  assert.equal(bashTools.length, 1, 'Duplicate tool names should be deduped')
})

test('rawFingerprint is stable for the same input', () => {
  const messages = [{ role: 'system' as const, content: OPENCODE_SYSTEM_PROMPT }]
  const r1 = extractPromptEmbeddedTools(messages)
  const r2 = extractPromptEmbeddedTools(messages)

  assert.equal(r1.rawFingerprint, r2.rawFingerprint)
})

test('rawFingerprint differs when tool list changes', () => {
  const msg1 = [{ role: 'system' as const, content: OPENCODE_SYSTEM_PROMPT }]
  const msg2 = [{ role: 'system' as const, content: HEADER_ONLY_PROMPT }]

  const r1 = extractPromptEmbeddedTools(msg1)
  const r2 = extractPromptEmbeddedTools(msg2)

  assert.notEqual(r1.rawFingerprint, r2.rawFingerprint)
})

test('inspects user messages as well as system messages', () => {
  const messages = [
    { role: 'user' as const, content: OPENCODE_SYSTEM_PROMPT },
  ]
  const result = extractPromptEmbeddedTools(messages)
  assert.ok(result.tools.length > 0, 'Should extract tools from user messages too')
})
