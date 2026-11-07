// Takes one item at a time off the talk queue: TTS, then playback.
// Never runs two plays at once. stop() aborts the current item.
// An item may carry settle(outcome): 'playing' when its sound starts, or 'failed' with the
// error, or 'dropped' (muted or stopped), so whoever queued it can tell whether it was heard.
export function createPlayer({ queue, engines, audio, getConfig, onError, boardSize, now, board, startPaused = false, onPlaying = () => {} }) {
  let paused = startPaused
  let running = false
  let current = null // AbortController of the item in flight
  let mutedUntil = 0

  async function playItem(item) {
    const settle = (outcome, error) => { try { item.settle?.(outcome, error) } catch { /* the caller is gone */ } }
    const cfg = getConfig()
    if (cfg.muted) { settle('dropped'); return }
    const ac = new AbortController()
    current = ac
    try {
      const row = board?.get(item.sessionId)
      const name = row?.name ?? item.name
      // The coordinator speaks for everyone, so it never announces itself.
      const text = boardSize() > 1 && name && row?.role !== 'coordinator' ? `${name}: ${item.text}` : item.text
      const mp3 = await engines.tts(text, cfg)
      if (ac.signal.aborted) { settle('dropped'); return }
      // The mic is deaf while audio plays: tell the person, from the first sound to the last.
      onPlaying(true)
      settle('playing')
      try {
        await audio.play(mp3, ac.signal)
      } finally {
        onPlaying(false)
      }
      if (ac.signal.aborted) return
      board?.setLastLine(item.sessionId, item.text, now())
    } catch (err) {
      if (ac.signal.aborted) settle('dropped')
      else { settle('failed', String(err?.message ?? err)); onError(err) }
    } finally {
      current = null
      mutedUntil = now() + 400
    }
  }

  async function run() {
    if (running || paused) return
    running = true
    try {
      let item
      while (!paused && (item = queue.next())) await playItem(item)
    } finally {
      running = false
    }
  }

  return {
    kick() { run() },
    resume() { paused = false; run() },
    stop() { current?.abort() },
    isPlaying: () => current !== null,
    mutedUntil: () => mutedUntil,
  }
}
