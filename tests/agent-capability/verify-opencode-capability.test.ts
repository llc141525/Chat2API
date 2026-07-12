import test from 'node:test'
import assert from 'node:assert/strict'

function toStableJson(value: unknown): string {
  return JSON.stringify(value)
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.toLowerCase().includes(needle.toLowerCase()))
}

function inspectProbeEvents(events: unknown[]) {
  const skillNeedles = ['agent-capability-probe', '"skill"']
  const toolCallNeedles = ['tool_use', 'tool_call', 'toolcall', 'tool_call_delta', 'call_tool', 'tool.start', 'tool.starting', 'tool:call', 'function_call']
  const toolResultNeedles = ['tool_result', 'toolresult', 'observation', 'tool.finish', 'tool.finished', 'tool:result', '"status":"completed"', '"state":{"status":"completed"']
  const nonSkillToolNames = ['read', 'bash', 'grep', 'glob', 'list', 'edit', 'write', 'read_file', 'Get-Content', 'Get-FileHash']

  let skillCallSeen = false
  let nonSkillToolCallCount = 0
  let toolResultSeen = false
  let nonSkillToolAfterResultSeen = false
  let finalDoneSeen = false

  for (const event of events) {
    const text = toStableJson(event)

    if (text.includes('CAPABILITY_PROBE_DONE')) {
      finalDoneSeen = true
    }

    if (containsAny(text, skillNeedles) && containsAny(text, toolCallNeedles)) {
      skillCallSeen = true
    }

    const looksLikeToolCall = containsAny(text, toolCallNeedles)
    const looksLikeToolResult = containsAny(text, toolResultNeedles)
    const looksLikeNonSkillTool =
      containsAny(text, nonSkillToolNames) &&
      !(text.includes('agent-capability-probe') && text.includes('"skill"'))

    if (looksLikeToolResult) {
      toolResultSeen = true
    }

    if (looksLikeToolCall && looksLikeNonSkillTool) {
      nonSkillToolCallCount += 1
      if (toolResultSeen) {
        nonSkillToolAfterResultSeen = true
      }
    }
  }

  return {
    skillCallSeen,
    nonSkillToolCallCount,
    nonSkillToolAfterResultSeen,
    finalDoneSeen
  }
}

test('probe event inspection recognizes OpenCode tool_use events', () => {
  const events = [
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'skill',
        state: {
          status: 'completed',
          input: { name: 'agent-capability-probe' }
        }
      }
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: 'E:\\Chat2API\\tests\\agent-capability\\input.txt' }
        }
      }
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'node tests/agent-capability/compute-result.mjs tests/agent-capability/input.txt > .agent-probe/result.json' }
        }
      }
    },
    {
      type: 'text',
      part: {
        type: 'text',
        text: 'CAPABILITY_PROBE_DONE'
      }
    }
  ]

  const inspection = inspectProbeEvents(events)

  assert.equal(inspection.skillCallSeen, true)
  assert.equal(inspection.nonSkillToolCallCount, 2)
  assert.equal(inspection.nonSkillToolAfterResultSeen, true)
  assert.equal(inspection.finalDoneSeen, true)
})
