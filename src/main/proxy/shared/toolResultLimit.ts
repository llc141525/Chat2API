/**
 * toolResultLimit.ts — Shared tool result length configuration
 *
 * Reads CHAT2API_MAX_TOOL_RESULT_LENGTH from environment.
 * Falls back to 2000 if not set or invalid.
 */

export function getMaxToolResultLength(): number {
  const env = process.env.CHAT2API_MAX_TOOL_RESULT_LENGTH
  if (env && /^\d+$/.test(env.trim())) {
    const n = Number(env.trim())
    if (!isNaN(n) && n > 0) return n
  }
  return 2000 // default
}
