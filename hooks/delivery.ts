// Where what the person said goes: idle, it becomes the next prompt; mid-turn it
// waits and rides along with the next tool result, or is sent when the turn ends.
// No imports: tests load this file straight into Node.

export type Delivery = {
  setBusy(b: boolean): void
  isBusy(): boolean
  heard(text: string): 'submit' | 'queued'
  takeForToolResult(): string | undefined
  takeAtTurnEnd(): string | undefined
}

// A per-session secret that marks voice notes as really coming from the person, so
// tool output (a web page, a file) can't pose as them by copying the wording.
export function makeTag(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function createDelivery(tag: string): Delivery {
  let busy = false
  let queued: string[] = []
  const take = (): string[] => {
    const out = queued
    queued = []
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
    takeForToolResult() {
      if (!queued.length) return undefined
      // JSON keeps quotes and newlines in what was heard from breaking out of the note.
      return `Voice note [interccom:${tag}] — the person said (by voice, while you were working): ${JSON.stringify(take())}`
    },
    takeAtTurnEnd() {
      if (!queued.length) return undefined
      return take().join(' ')
    },
  }
}
