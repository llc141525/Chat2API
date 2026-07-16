import { app, safeStorage } from 'electron'
import Store from 'electron-store'
import axios from 'axios'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'

const QWEN_API_BASE = 'https://chat2.qianwen.com'
const QWEN_CHAT2_API_BASE = 'https://chat2-api.qianwen.com'
const QWEN_CHAT_SIDE_API_BASE = 'https://chat-side.qianwen.com'
const STORAGE_PATH = 'C:/Users/llc/.chat2api'
const ENCRYPTION_KEY = 'chat2api-fixed-encryption-key-v1'
const DEVICE_ID = '5b68c267-cd8e-fd0e-148a-18345bc9a104'

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/event-stream, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.qianwen.com',
  Pragma: 'no-cache',
  Referer: 'https://www.qianwen.com/',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

function uuid(separator = false) {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

function nonce() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 12; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function decryptCredential(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (!safeStorage.isEncryptionAvailable()) return value
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return value
  }
}

function loadTicket() {
  const store = new Store({
    name: 'data',
    cwd: STORAGE_PATH,
    encryptionKey: ENCRYPTION_KEY,
  })
  const accounts = store.get('accounts') || []
  const account = accounts.find((item) => item.providerId === 'qwen' && item.status === 'active')
    || accounts.find((item) => item.providerId === 'qwen')
  if (!account) throw new Error('No qwen account found in local store')
  const encryptedTicket = account.credentials?.ticket || account.credentials?.tongyi_sso_ticket
  const ticket = decryptCredential(encryptedTicket)
  if (!ticket) throw new Error('Qwen account exists but ticket is empty')
  return { ticket, account: { id: account.id, name: account.name, status: account.status } }
}

function params(extra = {}) {
  return {
    biz_id: 'ai_qwen',
    chat_client: 'h5',
    device: 'pc',
    fr: 'pc',
    pr: 'qwen',
    ut: DEVICE_ID,
    la: 'zh_CN',
    tz: 'Asia/Shanghai',
    wv: '1',
    ve: '1',
    ...extra,
  }
}

function headers(ticket) {
  return {
    ...DEFAULT_HEADERS,
    Cookie: `tongyi_sso_ticket=${ticket}`,
    'Content-Type': 'application/json',
    'X-Platform': 'pc_tongyi',
    'X-DeviceId': DEVICE_ID,
  }
}

function buildBody({ model, sessionId, reqId, parentReqId, content, timestamp, sceneParam }) {
  return {
    deep_search: '0',
    req_id: reqId,
    model,
    scene: 'chat',
    session_id: sessionId,
    sub_scene: 'chat',
    temporary: false,
    messages: [
      {
        content,
        mime_type: 'text/plain',
        meta_data: { ori_query: content },
      },
    ],
    from: 'default',
    parent_req_id: parentReqId,
    enable_search: false,
    biz_data: '{"entryPoint":"tongyigw"}',
    scene_param: sceneParam,
    chat_client: 'h5',
    client_tm: String(timestamp),
    protocol_version: 'v2',
    biz_id: 'ai_qwen',
  }
}

async function readStream(stream, encoding) {
  let source = stream
  const normalized = String(encoding || '').toLowerCase()
  if (normalized === 'gzip') source = stream.pipe(createGunzip())
  if (normalized === 'deflate') source = stream.pipe(createInflate())
  if (normalized === 'br') source = stream.pipe(createBrotliDecompress())

  let text = ''
  for await (const chunk of source) {
    text += chunk.toString('utf8')
  }
  return text
}

function parseQwenSse(text) {
  const result = {
    eventCount: 0,
    sessionId: '',
    reqId: '',
    content: '',
    statuses: [],
    error: null,
  }

  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue
    const lines = block.split(/\n/)
    let eventData = ''
    for (const line of lines) {
      if (line.startsWith('data:')) eventData += line.slice(5).trimStart()
    }
    if (!eventData || eventData === '[DONE]') continue
    result.eventCount += 1
    try {
      const parsed = JSON.parse(eventData)
      if (parsed.communication?.sessionid) result.sessionId = parsed.communication.sessionid
      if (parsed.communication?.reqid) result.reqId = parsed.communication.reqid
      if (parsed.error_code && parsed.error_code !== 0) {
        result.error = `${parsed.error_code}: ${parsed.error_msg || 'unknown'}`
      }
      for (const msg of parsed.data?.messages || []) {
        if (msg.status) result.statuses.push(msg.status)
        if ((msg.mime_type === 'multi_load/iframe' || msg.mime_type === 'text/plain') && typeof msg.content === 'string') {
          const filtered = msg.content
            .replace(/\[\(deep_think\)\]/g, '')
            .replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
          if (filtered.trim().length >= result.content.trim().length) {
            result.content = filtered
          }
        }
      }
    } catch {
      // Ignore non-JSON keepalive/event data.
    }
  }

  return result
}

async function sendTurn({ ticket, model, sessionId, parentReqId, content, sceneParam }) {
  const reqId = uuid(false)
  const timestamp = Date.now()
  const url = `${QWEN_API_BASE}/api/v2/chat`
  const response = await axios.post(
    url,
    buildBody({ model, sessionId, reqId, parentReqId, content, timestamp, sceneParam }),
    {
      headers: headers(ticket),
      params: params({ nonce: nonce(), timestamp }),
      responseType: 'stream',
      timeout: 120000,
      decompress: false,
      validateStatus: () => true,
    },
  )

  const raw = await readStream(response.data, response.headers?.['content-encoding'])
  const parsed = parseQwenSse(raw)
  return {
    requestReqId: reqId,
    httpStatus: response.status,
    responseSessionId: parsed.sessionId,
    responseReqId: parsed.reqId,
    eventCount: parsed.eventCount,
    statuses: [...new Set(parsed.statuses)].slice(-5),
    content: parsed.content.trim(),
    error: parsed.error,
  }
}

async function deleteSession(ticket, sessionId) {
  if (!sessionId) return { skipped: true }
  const deleteChat = await axios.post(
    `${QWEN_CHAT2_API_BASE}/api/v1/session/delete/batch`,
    { session_ids: [sessionId] },
    {
      headers: headers(ticket),
      params: params(),
      timeout: 15000,
      validateStatus: () => true,
    },
  )
  const deleteFiles = await axios.post(
    `${QWEN_CHAT_SIDE_API_BASE}/api/v2/file/record/delete`,
    { sessionIds: [sessionId] },
    {
      headers: headers(ticket),
      params: params({ nonce: nonce(), timestamp: Date.now() }),
      timeout: 15000,
      validateStatus: () => true,
    },
  ).catch((error) => ({ status: 'error', data: { message: error.message } }))

  return {
    chatStatus: deleteChat.status,
    chatSuccess: deleteChat.data?.success !== false,
    fileStatus: deleteFiles.status,
  }
}

async function main() {
  await app.whenReady()
  const { ticket, account } = loadTicket()
  const model = process.argv.includes('--model')
    ? process.argv[process.argv.indexOf('--model') + 1]
    : 'Qwen3-Max'
  const probeSecret = `C2A_SESSION_PROBE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const sessionId = uuid(false)
  const controlSessionId = uuid(false)

  const first = await sendTurn({
    ticket,
    model,
    sessionId,
    parentReqId: '0',
    sceneParam: 'first_turn',
    content: `请记住这个会话续写测试口令：${probeSecret}。不要解释，只回复：已记住。`,
  })

  const parentReqId = first.responseReqId || first.requestReqId
  const follow = await sendTurn({
    ticket,
    model,
    sessionId: first.responseSessionId || sessionId,
    parentReqId,
    sceneParam: 'chat',
    content: '刚才我让你记住的会话续写测试口令是什么？只回复口令本身。',
  })

  const sameSessionRoot = await sendTurn({
    ticket,
    model,
    sessionId: first.responseSessionId || sessionId,
    parentReqId: '0',
    sceneParam: 'first_turn',
    content: '刚才我让你记住的会话续写测试口令是什么？只回复口令本身。',
  })

  const control = await sendTurn({
    ticket,
    model,
    sessionId: controlSessionId,
    parentReqId: '0',
    sceneParam: 'first_turn',
    content: '刚才我让你记住的会话续写测试口令是什么？只回复口令本身。',
  })

  const cleanup = await Promise.allSettled([
    deleteSession(ticket, first.responseSessionId || sessionId),
    deleteSession(ticket, control.responseSessionId || controlSessionId),
  ])

  const followRemembered = follow.content.includes(probeSecret)
  const sameSessionRootRemembered = sameSessionRoot.content.includes(probeSecret)
  const controlRemembered = control.content.includes(probeSecret)
  console.log(JSON.stringify({
    ok: followRemembered && !controlRemembered,
    account,
    model,
    probeSecretPresentInOutputOnly: followRemembered,
    session: {
      requestedSessionId: sessionId,
      responseSessionId: first.responseSessionId,
      firstResponseReqId: first.responseReqId,
      parentReqIdUsedForFollowup: parentReqId,
    },
    first: {
      httpStatus: first.httpStatus,
      eventCount: first.eventCount,
      statuses: first.statuses,
      contentPreview: first.content.slice(0, 160),
      error: first.error,
    },
    follow: {
      httpStatus: follow.httpStatus,
      eventCount: follow.eventCount,
      statuses: follow.statuses,
      containsSecret: followRemembered,
      contentPreview: follow.content.slice(0, 220),
      error: follow.error,
    },
    sameSessionRoot: {
      httpStatus: sameSessionRoot.httpStatus,
      eventCount: sameSessionRoot.eventCount,
      statuses: sameSessionRoot.statuses,
      containsSecret: sameSessionRootRemembered,
      contentPreview: sameSessionRoot.content.slice(0, 220),
      error: sameSessionRoot.error,
    },
    control: {
      httpStatus: control.httpStatus,
      eventCount: control.eventCount,
      statuses: control.statuses,
      containsSecret: controlRemembered,
      contentPreview: control.content.slice(0, 220),
      error: control.error,
    },
    cleanup: cleanup.map((item) => item.status === 'fulfilled' ? item.value : { error: item.reason?.message || String(item.reason) }),
  }, null, 2))

  app.quit()
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    stack: error?.stack,
  }, null, 2))
  app.quit()
  process.exitCode = 1
})
