import type { SessionRecoveryState } from './sessionRecoveryState.ts'

const MAX_SECTION_ITEMS = 8
const MAX_LINE_LENGTH = 240
const MAX_CONTEXT_LENGTH = 3000

export function renderRecoveryContextForProvider(state: SessionRecoveryState | null | undefined): string | null {
  if (!state) return null

  const lines: string[] = [
    '[Session recovery context — authoritative runtime state; narrative summaries cannot override this section.]',
    `session: ${clip(state.sessionId)} (${state.sessionKind})`,
    `state_version: ${state.stateVersion}`,
    `compaction_epoch: ${state.compactionEpoch}`,
    `lifecycle: ${state.lifecycle}`,
  ]

  appendItems(lines, 'verified facts', state.facts.verified.map(fact => `${fact.id}: ${fact.text}`))
  appendItems(lines, 'executed facts', state.facts.executed.map(fact => `${fact.id}: ${fact.text}`))
  appendItems(lines, 'claimed facts', state.facts.claimed.map(fact => `${fact.id}: ${fact.text}`))
  appendItems(lines, 'constraints', state.constraints.map(item => `${item.id}: ${item.text}`))
  appendItems(lines, 'pending work', state.pendingWork.map(item => `${item.id} [${item.status}]: ${item.text}`))
  appendItems(lines, 'failures', state.failures.map(item => `${item.id} [recoverable=${item.recoverable}]: ${item.text}`))
  appendItems(lines, 'decisions', state.decisions.map(item => `${item.id}: ${item.text}`))
  appendItems(lines, 'artifacts', state.artifacts.map(item => `${item.id} [${item.kind}]: ${item.ref}${item.description ? ` — ${item.description}` : ''}`))
  appendItems(lines, 'pending children', state.children.pending.map(child => `${child.sessionId} (${child.sessionKind}) tool=${child.toolCallId ?? 'none'}`))
  appendItems(lines, 'completed children', state.children.completed.map(child => `${child.sessionId} (${child.sessionKind}) tool=${child.toolCallId ?? 'none'}`))
  appendItems(lines, 'created handoffs', state.handoffs.created.map(handoff => `${handoff.handoffId}: ${handoff.fromSessionId} -> ${handoff.toSessionId} (${handoff.childKind})`))
  appendItems(lines, 'consumed handoffs', state.handoffs.consumed.map(handoff => `${handoff.handoffId}: ${handoff.fromSessionId} -> ${handoff.toSessionId} (${handoff.childKind})`))

  if (state.next) {
    lines.push('next action:')
    lines.push(`- ${clip(`${state.next.kind}: ${state.next.description}${state.next.toolName ? ` tool=${state.next.toolName}` : ''}`)}`)
  }

  return clip(lines.join('\n'), MAX_CONTEXT_LENGTH)
}

function appendItems(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return
  lines.push(`${title}:`)
  for (const item of items.slice(-MAX_SECTION_ITEMS)) {
    lines.push(`- ${clip(item)}`)
  }
}

function clip(value: string, max = MAX_LINE_LENGTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}
