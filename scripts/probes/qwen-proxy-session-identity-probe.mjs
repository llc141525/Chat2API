import { readFileSync, statSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1:8081/v1/chat/completions',
    model: 'Qwen3.7-Max',
    logPath: 'dev-qwen-session.log',
    includeUser: true,
    expect: 'any',
  }

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base-url') args.baseUrl = argv[++index]
    else if (arg === '--model') args.model = argv[++index]
    else if (arg === '--log') args.logPath = argv[++index]
    else if (arg === '--no-user') args.includeUser = false
    else if (arg === '--expect') args.expect = argv[++index]
  }

  if (!['any', 'reuse', 'fresh'].includes(args.expect)) {
    throw new Error('--expect must be one of: any, reuse, fresh')
  }
  return args
}

function logSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function readLogSince(path, offset) {
  const text = readFileSync(path, 'utf8')
  return text.slice(Math.min(offset, text.length))
}

function parseQwenSessionInfos(logText) {
  const infos = []
  const pattern = /\[Qwen\] Session info: \{\s+sessionId: '([^']+)',\s+reqId: '([^']+)',\s+parentReqId: ([^\r\n]+)\s+\}/g
  let match
  while ((match = pattern.exec(logText))) {
    infos.push({
      sessionId: match[1],
      reqId: match[2],
      parentReqId: match[3].trim().replace(/^'|'$/g, ''),
    })
  }
  return infos
}

async function postChat(args, body) {
  const response = await fetch(args.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // Keep raw preview for diagnostics.
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
  }

  return {
    status: response.status,
    id: parsed?.id || '',
    content: parsed?.choices?.[0]?.message?.content || '',
    rawPreview: text.slice(0, 500),
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const startOffset = logSize(args.logPath)
  const secret = `C2A_PROXY_ID_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const user = `probe-${secret}`

  const firstMessages = [
    {
      role: 'user',
      content: `Remember this proxy session identity token exactly: ${secret}. Reply with ACK only.`,
    },
  ]

  const firstBody = {
    model: args.model,
    messages: firstMessages,
    stream: false,
  }
  if (args.includeUser) firstBody.user = user

  const first = await postChat(args, firstBody)

  const secondMessages = [
    ...firstMessages,
    {
      role: 'assistant',
      content: first.content || 'ACK',
    },
    {
      role: 'user',
      content: 'What is the proxy session identity token? Reply with the token only.',
    },
  ]

  const secondBody = {
    model: args.model,
    messages: secondMessages,
    stream: false,
  }
  if (args.includeUser) secondBody.user = user

  const second = await postChat(args, secondBody)
  await sleep(500)

  const newLog = readLogSince(args.logPath, startOffset)
  const sessionInfos = parseQwenSessionInfos(newLog)
  const firstInfo = sessionInfos[0]
  const secondInfo = sessionInfos[1]
  const reused = Boolean(firstInfo && secondInfo && firstInfo.sessionId === secondInfo.sessionId)
  const secondHasParent = Boolean(secondInfo && secondInfo.parentReqId && secondInfo.parentReqId !== 'undefined')
  const secondParentMatchesFirst = Boolean(firstInfo && secondInfo && secondInfo.parentReqId === firstInfo.reqId)
  const containsSecret = second.content.includes(secret)

  const ok = args.expect === 'any'
    || (args.expect === 'reuse' && reused && secondHasParent)
    || (args.expect === 'fresh' && (!reused || !secondHasParent))

  const result = {
    ok,
    expectation: args.expect,
    mode: args.includeUser ? 'fixed-user' : 'no-user-history-derived',
    authoritativeEvidence: {
      reused,
      secondHasParent,
      secondParentMatchesFirst,
      sessionInfos,
    },
    modelAnswerEvidence: {
      containsSecret,
      firstResponsePreview: first.content.slice(0, 160),
      secondResponsePreview: second.content.slice(0, 220),
    },
    note: args.includeUser
      ? 'Fixed user should already reuse provider state on the current branch.'
      : 'No-user mode relies on stable resent OpenAI history; requests with neither identity nor history cannot be safely correlated.',
  }

  console.log(JSON.stringify(result, null, 2))
  if (!ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
  }, null, 2))
  process.exitCode = 1
})
