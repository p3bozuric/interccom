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

export class Board {
  #rows = new Map()

  #uniqueName(raw, exceptId) {
    const base = normalizeName(raw)
    const taken = new Set()
    for (const r of this.#rows.values()) if (r.sessionId !== exceptId) taken.add(r.name)
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
    return name
  }

  register({ name, cwd, pid }, now) {
    const sessionId = randomUUID()
    const row = {
      sessionId,
      name: this.#uniqueName(name),
      cwd,
      pid,
      busy: false,
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

  get(sessionId) {
    return this.#rows.get(sessionId)
  }

  byName(name) {
    const n = normalizeName(name)
    for (const r of this.#rows.values()) if (r.name === n) return r
    return undefined
  }

  defaultTarget() {
    let best
    for (const r of this.#rows.values()) {
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
