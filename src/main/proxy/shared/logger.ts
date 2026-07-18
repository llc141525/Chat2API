/**
 * Unified Logger for Chat2API proxy module.
 *
 * Dual-output architecture:
 *   info/warn/error → stdout (human-readable) + NDJSON (dev.log)
 *   debug → NDJSON only
 *
 * Level filtering via CHAT2API_LOG_LEVEL env var (default: 'info').
 * Credential redaction: token, apiKey, cookie, authorization, sessionid.
 *
 * Legacy console.log calls are hijacked and routed through logger.debug('legacy:console', ...).
 */

import { appendFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export type LogEvent = {
  ts: string
  level: LogLevel
  tag: string
  msg: string
  sessionId?: string
  data?: unknown
  err?: { message: string; stack?: string }
}

/* ------------------------------------------------------------------ */
/*  Credential redaction                                              */
/* ------------------------------------------------------------------ */

const SENSITIVE_KEYS = new Set([
  'token', 'apiKey', 'api_key', 'apikey',
  'cookie', 'cookies',
  'authorization', 'auth',
  'sessionid', 'session_id',
  'secret', 'password', 'passwd',
  'access_token', 'refresh_token',
  'x-auth-token', 'x-api-key',
])

function redactCredentials(value: unknown, depth = 0): unknown {
  if (depth > 5) return value
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    // Redact common credential patterns in strings
    return value.replace(
      /(token|apiKey|api_key|apikey|cookie|authorization|secret|password|access_token)[=:]["']?[^\s&"'\]\)]+/gi,
      '$1=[REDACTED]',
    )
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactCredentials(v, depth + 1))
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = '[REDACTED]'
      } else {
        result[key] = redactCredentials(val, depth + 1)
      }
    }
    return result
  }
  return value
}

/* ------------------------------------------------------------------ */
/*  NDJSON log file path                                              */
/* ------------------------------------------------------------------ */

function getLogFilePath(): string {
  // Prefer explicit env var
  if (process.env.CHAT2API_LOG_PATH) return process.env.CHAT2API_LOG_PATH

  // Try import.meta.url (ESM) — walk up 4 levels from src/main/proxy/shared/
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const candidate = resolve(currentDir, '..', '..', '..', '..', 'dev.log')
    if (existsSync(candidate)) return candidate
    // If doesn't exist yet, check parent dir for package.json
    if (existsSync(resolve(currentDir, '..', '..', '..', '..', 'package.json'))) return candidate
  } catch { /* import.meta.url not available */ }

  // Try __dirname (CJS fallback)
  try {
    const candidate = resolve(__dirname, '..', '..', '..', '..', 'dev.log')
    if (existsSync(resolve(__dirname, '..', '..', '..', '..', 'package.json'))) return candidate
  } catch { /* __dirname not available */ }

  // Try process.cwd()
  const cwdCandidate = resolve(process.cwd(), 'dev.log')
  if (existsSync(resolve(process.cwd(), 'package.json'))) return cwdCandidate

  // Last resort hardcoded
  return 'E:\\Chat2API\\dev.log'
}

/* ------------------------------------------------------------------ */
/*  Logger class                                                      */
/* ------------------------------------------------------------------ */

let _ndjsonPath: string | undefined

function getNdjsonPath(): string {
  if (!_ndjsonPath) {
    _ndjsonPath = getLogFilePath()
  }
  return _ndjsonPath
}

function getEffectiveLevel(): LogLevel {
  const env = (process.env.CHAT2API_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
  if (env in LOG_LEVELS) return env
  return 'info'
}

function shouldLog(level: LogLevel, configuredLevel: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[configuredLevel]
}

function truncateData(data: unknown): unknown {
  if (typeof data === 'string' && data.length > 500) {
    return data.substring(0, 500) + '... [truncated]'
  }
  return data
}

/* ------------------------------------------------------------------ */
/*  Console hijacking (transitional)                                  */
/* ------------------------------------------------------------------ */

const _origConsoleLog = console.log.bind(console)
const _origConsoleWarn = console.warn.bind(console)
const _origConsoleError = console.error.bind(console)

let _hijackInstalled = false

export function installConsoleHijack(loggerInstance: Logger): void {
  if (_hijackInstalled) return
  _hijackInstalled = true

  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    loggerInstance.debug('legacy:console', msg)
  }

  console.warn = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    loggerInstance.warn('legacy:console', msg)
  }

  console.error = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    loggerInstance.error('legacy:console', msg)
  }
}

export function uninstallConsoleHijack(): void {
  if (!_hijackInstalled) return
  _hijackInstalled = false
  console.log = _origConsoleLog
  console.warn = _origConsoleWarn
  console.error = _origConsoleError
}

/* ------------------------------------------------------------------ */
/*  Logger interface & implementation                                 */
/* ------------------------------------------------------------------ */

export interface ILogger {
  debug(tag: string, msg: string, data?: unknown, err?: Error): void
  info(tag: string, msg: string, data?: unknown, err?: Error): void
  warn(tag: string, msg: string, data?: unknown, err?: Error): void
  error(tag: string, msg: string, data?: unknown, err?: Error): void
  child(sessionId: string): ILogger
}

export class Logger implements ILogger {
  private readonly configuredLevel: LogLevel
  private readonly baseSessionId?: string

  constructor(baseSessionId?: string) {
    this.configuredLevel = getEffectiveLevel()
    this.baseSessionId = baseSessionId
  }

  child(sessionId: string): ILogger {
    return new Logger(sessionId)
  }

  debug(tag: string, msg: string, data?: unknown, err?: Error): void {
    this.emit('debug', tag, msg, data, err)
  }

  info(tag: string, msg: string, data?: unknown, err?: Error): void {
    this.emit('info', tag, msg, data, err)
  }

  warn(tag: string, msg: string, data?: unknown, err?: Error): void {
    this.emit('warn', tag, msg, data, err)
  }

  error(tag: string, msg: string, data?: unknown, err?: Error): void {
    this.emit('error', tag, msg, data, err)
  }

  /* ---- internal ------------------------------------------------- */

  private emit(level: LogLevel, tag: string, msg: string, data?: unknown, err?: Error): void {
    const ts = new Date().toISOString()
    const safeData = data !== undefined ? redactCredentials(truncateData(data)) : undefined
    const errPayload = err
      ? { message: err.message, stack: err.stack }
      : undefined

    const event: LogEvent = {
      ts,
      level,
      tag,
      msg,
      sessionId: this.baseSessionId,
      data: safeData as Record<string, unknown> | undefined,
      err: errPayload,
    }

    // Human-readable line for stdout (filtered by level)
    if (shouldLog(level, this.configuredLevel) && level !== 'debug') {
      const parts: string[] = [ts]
      if (this.baseSessionId) parts.push(`[${this.baseSessionId}]`)
      parts.push(`[${level.toUpperCase()}] [${tag}] ${msg}`)
      const line = parts.join(' ')
      if (level === 'error') {
        _origConsoleError(line)
      } else if (level === 'warn') {
        _origConsoleWarn(line)
      } else {
        _origConsoleLog(line)
      }
    }

    // NDJSON to dev.log — ALL levels always written for post-hoc analysis
    try {
      appendFileSync(getNdjsonPath(), JSON.stringify(event) + '\n')
    } catch {
      // Silently ignore file write errors
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton instance                                                */
/* ------------------------------------------------------------------ */

export const logger = new Logger()

// Install console hijack by default
installConsoleHijack(logger)
