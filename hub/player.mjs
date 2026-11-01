// Takes one item at a time off the talk queue: TTS, then playback.
// Never runs two plays at once. stop() aborts the current item.
export function createPlayer({ queue, engines, audio, getConfig, onError, boardSize, now, board, startPaused = false }) {
  let paused = startPaused
  let running = false
  let current = null // AbortController of the item in flight
  let mutedUntil = 0

  async function playItem(item) {
    const cfg = getConfig()
    if (cfg.muted) return
    const ac = new AbortController()
    current = ac
    try {
      const row = board?.get(item.sessionId)
      const name = row?.name ?? item.name
      // The coordinator speaks for everyone, so it never announces itself.
      const text = boardSize() > 1 && name && row?.role !== 'coordinator' ? `${name}: ${item.text}` : item.text
      const mp3 = await engines.tts(text, cfg)
      if (ac.signal.aborted) return
      await audio.play(mp3, ac.signal)
      if (ac.signal.aborted) return
      board?.setLastLine(item.sessionId, item.text, now())
    } catch (err) {
      if (!ac.signal.aborted) onError(err)
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
