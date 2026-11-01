import { randomUUID } from 'node:crypto'

export function normalizeName(raw) {
  const n = String(raw ?? '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/^-+|-+$/g, '')
  return n || 'session'
}

const MAX_DECISIONS = 20
export const ROLES = new Set(['worker', 'coordinator'])
// How heard speech reaches a session: push (its event stream, Claude Code), pull (an inbox
// its host's hooks drain, Codex), or none (an MCP-only host that can speak but not hear).
export const DELIVERIES = new Set(['push', 'pull', 'none'])
const PRIVATE = new Set(['tag', 'inbox'])

// A row as the outside sees it: never the session's secret tag or its pending inbox.
export function publicRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !PRIVATE.has(k)))
}

export class Board {
  #rows = new Map()
  #decisions = [] // { at, text }, newest last: what the coordinator decided on its own

  #uniqueName(raw, exceptId) {
    const base = normalizeName(raw)
    const taken = new Set()
    for (const r of this.#rows.values()) if (r.sessionId !== exceptId) taken.add(r.name)
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
    return name
  }

  register({ name, cwd, pid, host, delivery, hostSessionId, tag }, now) {
    const sessionId = randomUUID()
    const row = {
      sessionId,
      name: this.#uniqueName(name),
      cwd,
      pid,
      host: typeof host === 'string' && host ? host.slice(0, 40) : 'claude-code',
      delivery: DELIVERIES.has(delivery) ? delivery : 'push',
      hostSessionId: typeof hostSessionId === 'string' && hostSessionId ? hostSessionId.slice(0, 200) : '',
      tag: typeof tag === 'string' ? tag.slice(0, 200) : '',
      inbox: [],
      role: 'worker',
      busy: false,
      openQuestion: '',
      registeredAt: now,
      lastActiveAt: 0,
      lastLine: '',
      changedAt: now,
    }
    this.#rows.set(sessionId, row)
    return { sessionId, name: row.name }
  }

  remove(sessionId) {
    this.#rows.delete(sessionId)
  }

  rename(sessionId, name, now) {
    const row = this.#rows.get(sessionId)
    if (!row) return normalizeName(name)
    row.name = this.#uniqueName(name, sessionId)
    row.changedAt = now
    return row.name
  }

  #touch(sessionId, now, fn) {
    const row = this.#rows.get(sessionId)
    if (!row) return
    fn(row)
    row.changedAt = now
  }

  setBusy(sessionId, busy, now) {
    this.#touch(sessionId, now, r => { r.busy = busy })
  }

  markActive(sessionId, now) {
    this.#touch(sessionId, now, r => { r.lastActiveAt = now })
  }

  setLastLine(sessionId, text, now) {
    this.#touch(sessionId, now, r => { r.lastLine = text })
  }

  setRole(sessionId, role, now) {
    this.#touch(sessionId, now, r => { r.role = role })
  }

  // A worker's question stays open until a later update from it, or until the coordinator resolves it.
  setQuestion(sessionId, text, now) {
    this.#touch(sessionId, now, r => { r.openQuestion = text })
  }

  coordinator() {
    for (const r of this.#rows.values()) if (r.role === 'coordinator') return r
    return undefined
  }

  logDecision(text, now) {
    this.#decisions.push({ at: now, text })
    if (this.#decisions.length > MAX_DECISIONS) this.#decisions.shift()
  }

  decisions() {
    return this.#decisions.map(d => ({ ...d }))
  }

  get(sessionId) {
    return this.#rows.get(sessionId)
  }

  byName(name) {
    const n = normalizeName(name)
    for (const r of this.#rows.values()) if (r.name === n) return r
    return undefined
  }

  byHostSession(host, hostSessionId) {
    if (!hostSessionId) return undefined
    for (const r of this.#rows.values()) if (r.host === host && r.hostSessionId === hostSessionId) return r
    return undefined
  }

  // A host hook names its own session id; the first one from an unbound session in the same
  // folder claims the newest such row (two sessions of one host in one folder may swap: rare).
  bindHostSession(host, hostSessionId, cwd, samePath) {
    const known = this.byHostSession(host, hostSessionId)
    if (known) return known
    let best
    for (const r of this.#rows.values()) {
      if (r.host !== host || r.hostSessionId || !samePath(r.cwd, cwd)) continue
      if (!best || r.registeredAt >= best.registeredAt) best = r
    }
    if (best) best.hostSessionId = hostSessionId
    return best
  }

  defaultTarget() {
    let best
    for (const r of this.#rows.values()) {
      if (r.delivery === 'none') continue
      if (!best) { best = r; continue }
      if (r.lastActiveAt !== best.lastActiveAt
        ? r.lastActiveAt > best.lastActiveAt
        : r.registeredAt >= best.registeredAt) best = r
    }
    return best
  }

  list() {
    return [...this.#rows.values()]
  }

  get size() {
    return this.#rows.size
  }
}
