// Text views of the hub's status board. No imports: tests load this file straight into Node.

export type BoardRow = {
  name?: unknown; cwd?: unknown; role?: unknown; busy?: unknown
  lastLine?: unknown; openQuestion?: unknown; changedAt?: unknown
}
export type BoardData = {
  sessions?: BoardRow[]; coordinator?: unknown; mode?: unknown
  decisions?: { at?: unknown; text?: unknown }[]
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

// Open questions first, then idle (most recently changed first), then busy.
function rank(r: BoardRow): number {
  if (r.openQuestion) return 0
  return r.busy ? 2 : 1
}

export function sortRows(rows: BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => rank(a) - rank(b) || Number(b.changedAt ?? 0) - Number(a.changedAt ?? 0))
}

export function boardText(board: BoardData, now: number): string {
  const rows = sortRows(board.sessions ?? [])
  if (!rows.length) return 'No sessions are connected.'
  const lines = rows.map((r) => {
    const parts = [
      `${String(r.name)}${r.role === 'coordinator' ? ' (coordinator)' : ''}`,
      r.busy ? 'busy' : 'idle',
      `folder ${JSON.stringify(String(r.cwd ?? ''))}`,
    ]
    if (r.openQuestion) parts.push(`OPEN QUESTION ${JSON.stringify(String(r.openQuestion))}`)
    if (r.lastLine && r.lastLine !== r.openQuestion) parts.push(`last said ${JSON.stringify(String(r.lastLine))}`)
    parts.push(`changed ${ago(now - Number(r.changedAt ?? now))}`)
    return `- ${parts.join(' — ')}`
  })
  const out = [`Coordinator: ${board.coordinator ? String(board.coordinator) : 'none'}. Listening: ${String(board.mode ?? '?')}.`, ...lines]
  const decisions = (board.decisions ?? []).slice(-5)
  if (decisions.length) {
    out.push('Decisions made without the person (newest last):')
    for (const d of decisions) out.push(`- ${ago(now - Number(d.at ?? now))}: ${JSON.stringify(String(d.text ?? ''))}`)
  }
  return out.join('\n')
}
