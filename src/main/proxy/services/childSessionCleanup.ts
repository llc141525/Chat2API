/**
 * Child Session Cleanup Policy
 *
 * Decides whether a child provider session (tool_child / subagent_child)
 * should be deleted after its handoff has been consumed by the parent session.
 */

import type { ChildSessionHandoff } from '../sessionBoundary.ts'

/**
 * Determine whether a child session's Qwen web session should be deleted.
 *
 * Decision table:
 *   - status === 'ok'                          → always delete (handoff captured)
 *   - status === 'failed'                      → delete in normal mode; keep in debug mode
 *   - status === 'needs_parent_decision'       → never delete (parent hasn't decided yet)
 *   - default                                  → conservative: keep
 */
export function shouldDeleteChildSession(
  handoff: ChildSessionHandoff,
  debugMode: boolean,
): boolean {
  switch (handoff.status) {
    case 'ok':
      return true
    case 'failed':
      return !debugMode
    case 'needs_parent_decision':
      return false
    default:
      return false
  }
}

export async function cleanupChildProviderSession(input: {
  handoff: ChildSessionHandoff
  debugMode: boolean
  deleteSession: (sessionId: string) => Promise<void>
}): Promise<boolean> {
  if (!shouldDeleteChildSession(input.handoff, input.debugMode)) {
    return false
  }

  const childProviderSessionId = typeof input.handoff.childProviderSessionId === 'string'
    ? input.handoff.childProviderSessionId.trim()
    : ''
  if (!childProviderSessionId) {
    return false
  }

  await input.deleteSession(childProviderSessionId)
  return true
}
