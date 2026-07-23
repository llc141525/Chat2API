/**
 * Session Manager Module
 * Manages conversation sessions for stateless single-turn dialogue
 */

import { storeManager } from '../store/store'
import { SessionRecord, SessionConfig, ChatMessage, DEFAULT_SESSION_CONFIG } from '../store/types'
import {
  createSessionRecoveryState,
  type RecoveryEvent,
  type SessionKind,
  type SessionRecoveryState,
} from './services/sessionRecoveryState.ts'

export interface CreateSessionOptions {
  providerId: string
  accountId: string
  model?: string
  sessionType?: 'chat' | 'agent'
}

export interface SessionContext {
  sessionId: string
  providerSessionId: string | undefined
  parentMessageId: string | undefined
  messages: ChatMessage[]
  isNew: boolean
}

export interface EnsureRecoverySessionOptions {
  sessionId: string
  sessionKind: SessionKind
  parentSessionId?: string
  toolCallId?: string
  providerSessionId?: string
  providerId?: string
  accountId?: string
  model?: string
}

class SessionManagerClass {
  private cleanupInterval: NodeJS.Timeout | null = null

  initialize(): void {
    this.startCleanupScheduler()
    console.log('[SessionManager] Initialized')
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    console.log('[SessionManager] Destroyed')
  }

  private startCleanupScheduler(): void {
    const CLEANUP_INTERVAL_MS = 60 * 1000
    
    this.cleanupInterval = setInterval(() => {
      this.cleanExpiredSessions()
    }, CLEANUP_INTERVAL_MS)
    
    console.log('[SessionManager] Cleanup scheduler started, interval: 1 minute')
  }

  getSessionConfig(): SessionConfig {
    return storeManager.getSessionConfig()
  }

  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    const newConfig = storeManager.updateSessionConfig(updates)
    console.log('[SessionManager] Session config updated:', newConfig)
    return newConfig
  }

  getOrCreateSession(options: CreateSessionOptions): SessionContext {
    const { providerId, accountId, model } = options
    
    const existingSession = this.getActiveSession(providerId, accountId)
    
    if (existingSession) {
      return {
        sessionId: existingSession.id,
        providerSessionId: undefined,
        parentMessageId: undefined,
        messages: existingSession.messages,
        isNew: false,
      }
    }
    
    const newSession = this.createSession({
      providerId,
      accountId,
      model,
    })
    
    return {
      sessionId: newSession.id,
      providerSessionId: undefined,
      parentMessageId: undefined,
      messages: newSession.messages,
      isNew: true,
    }
  }

  getActiveSession(providerId: string, accountId: string): SessionRecord | undefined {
    const sessions = storeManager.getSessionsByProviderId(providerId)
    const accountSessions = sessions.filter(s => s.accountId === accountId)
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    return accountSessions.find(s => 
      s.status === 'active' && 
      (now - s.lastActiveAt) < timeoutMs
    )
  }

  createSession(options: CreateSessionOptions): SessionRecord {
    const { providerId, accountId, model, sessionType = 'chat' } = options
    const now = Date.now()
    
    const session: SessionRecord = {
      id: this.generateSessionId(),
      providerId,
      accountId,
      sessionType,
      messages: [],
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      model,
    }
    session.recoveryState = createSessionRecoveryState({
      sessionId: session.id,
      sessionKind: 'main',
      now,
    })
    
    storeManager.addSession(session)
    return session
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return storeManager.getSessionById(sessionId)
  }

  getSessionRecoveryState(sessionId: string): SessionRecoveryState {
    const recoveryState = storeManager.getSessionRecoveryState(sessionId)
    if (!recoveryState) {
      throw new Error(`Session ${sessionId} has no recoveryState`)
    }
    return recoveryState
  }

  applyRecoveryEvent(sessionId: string, event: RecoveryEvent): SessionRecord {
    return storeManager.applyRecoveryEventToSession(sessionId, event)
  }

  applyRecoveryEventWithCurrentVersion(
    sessionId: string,
    event: Omit<RecoveryEvent, 'expectedStateVersion'>,
  ): SessionRecord {
    const recoveryState = this.getSessionRecoveryState(sessionId)
    return storeManager.applyRecoveryEventToSession(sessionId, {
      ...event,
      expectedStateVersion: recoveryState.stateVersion,
    } as RecoveryEvent)
  }

  ensureRecoverySession(options: EnsureRecoverySessionOptions): SessionRecord {
    return storeManager.ensureRecoverySessionRecord({
      ...options,
      now: Date.now(),
    })
  }

  getAllActiveSessions(): SessionRecord[] {
    return storeManager.getActiveSessions()
  }

  getAllSessions(): SessionRecord[] {
    return storeManager.getSessions()
  }

  deleteSession(sessionId: string): boolean {
    const result = storeManager.deleteSession(sessionId)
    if (result) {
      console.log('[SessionManager] Deleted session:', sessionId)
    }
    return result
  }

  cleanExpiredSessions(): number {
    const removedCount = storeManager.cleanExpiredSessions()
    if (removedCount > 0) {
      console.log('[SessionManager] Cleaned expired sessions:', removedCount)
    }
    return removedCount
  }

  clearAllSessions(): void {
    storeManager.clearAllSessions()
    console.log('[SessionManager] Cleared all sessions')
  }

  getSessionsByAccount(accountId: string): SessionRecord[] {
    return storeManager.getSessionsByAccountId(accountId)
  }

  getSessionsByProvider(providerId: string): SessionRecord[] {
    return storeManager.getSessionsByProviderId(providerId)
  }

  shouldDeleteAfterChat(): boolean {
    const config = this.getSessionConfig()
    return config.deleteAfterTimeout
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }
}

export const sessionManager = new SessionManagerClass()
export default sessionManager
