const RANK = { question: 0, 'heads-up': 1, status: 2 }

export class TalkQueue {
  #items = []

  push(item) {
    this.#items.push(item)
  }

  next() {
    if (!this.#items.length) return undefined
    let best = 0
    for (let i = 1; i < this.#items.length; i++) {
      if (RANK[this.#items[i].priority] < RANK[this.#items[best].priority]) best = i
    }
    return this.#items.splice(best, 1)[0]
  }

  flush() {
    const before = this.#items.length
    const kept = []
    for (const i of this.#items) {
      if (i.priority === 'question') kept.push(i)
      else try { i.settle?.('dropped') } catch { /* the caller is gone */ }
    }
    this.#items = kept
    return before - this.#items.length
  }

  get size() {
    return this.#items.length
  }
}
