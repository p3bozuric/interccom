// Where what the person said goes: idle, it becomes the next prompt; mid-turn it
// waits and rides along with the next tool result, or is sent when the turn ends.
// Worker reports (coordinator role only) travel the same two ways, tagged separately.
// No imports: tests load this file straight into Node.

export type Report = { from: string; priority: string; text: string }

export type Delivery = {
  setBusy(b: boolean): void
  isBusy(): boolean
  heard(text: string): 'submit' | 'queued'
  report(r: Report): 'submit' | 'queued'
  takeForToolResult(): string | undefined
  takeAtTurnEnd(): string | undefined
  takeReportsAtTurnEnd(): string | undefined
  formatOne(r: Report): string
}

// A per-session secret that marks voice notes as really coming from the person, so
// tool output (a web page, a file) can't pose as them by copying the wording.
export function makeTag(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// The coordinator hears "hey Claude, api: run the tests" as "(to api) run the tests".
export function heardText(text: string, addressed?: string): string {
  return addressed ? `(to ${addressed}) ${text}` : text
}

// JSON keeps quotes and newlines in what a worker said from breaking out of the note.
export function formatReports(tag: string, reports: Report[]): string {
  const rows = reports.map((r) => ({ from: r.from, priority: r.priority, text: r.text }))
  return `Session reports [interccom:${tag}] — worker sessions want the person to know: ${JSON.stringify(rows)}`
}

export function createDelivery(tag: string): Delivery {
  let busy = false
  let queued: string[] = []
  let reports: Report[] = []
  const take = (): string[] => {
    const out = queued
    queued = []
    return out
  }
  const takeReports = (): Report[] => {
    const out = reports
    reports = []
    return out
  }
  return {
    setBusy(b) { busy = b },
    isBusy() { return busy },
    heard(text) {
      if (!busy) return 'submit'
      queued.push(text)
      return 'queued'
    },
    report(r) {
      if (!busy) return 'submit'
      reports.push(r)
      return 'queued'
    },
    takeForToolResult() {
      const notes: string[] = []
      // JSON keeps quotes and newlines in what was heard from breaking out of the note.
      if (queued.length) notes.push(`Voice note [interccom:${tag}] — the person said (by voice, while you were working): ${JSON.stringify(take())}`)
      if (reports.length) notes.push(formatReports(tag, takeReports()))
      return notes.length ? notes.join('\n') : undefined
    },
    takeAtTurnEnd() {
      if (!queued.length) return undefined
      return take().join(' ')
    },
    formatOne(r) { return formatReports(tag, [r]) },
    takeReportsAtTurnEnd() {
      if (!reports.length) return undefined
      return formatReports(tag, takeReports())
    },
  }
}
