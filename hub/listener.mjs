// Mic listener: ffmpeg capture -> 30 ms frames -> VAD -> utterance callback.
// createListenerManager decides when the listener runs and routes utterances
// through STT to hub.hear.
import { spawn as realSpawn } from 'node:child_process'
import { captureArgv } from './audio/windows.mjs'

const FRAME_BYTES = 960 // 480 samples * 2 bytes = 30 ms at 16 kHz mono s16le
const MAX_IN_FLIGHT = 3
const NO_MIC_CACHE_MS = 30_000
const HEALTHY_MS = 5_000
const DROPPED = 'Speech is arriving faster than it can be transcribed; dropped some audio.'
const NO_MIC = 'No microphone found. Plug one in, or set INTERCCOM_MIC to its name.'

export function startListener({
  mic, spawn = realSpawn, vad, isMuted, onUtterance, onError, backoffMs = [2000, 30000],
}) {
  const [minBackoff, maxBackoff] = backoffMs
  let child = null
  let timer = null
  let stopped = false
  let delay = minBackoff
  let pending = Buffer.alloc(0)
  let wasMuted = false
  let firstDataAt = 0

  function onData(chunk) {
    // Only a mic that has kept producing audio for a while counts as healthy.
    const t = Date.now()
    if (!firstDataAt) firstDataAt = t
    else if (t - firstDataAt >= HEALTHY_MS) delay = minBackoff
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let off = 0
    while (pending.length - off >= FRAME_BYTES) {
      const frame = Buffer.from(pending.subarray(off, off + FRAME_BYTES)) // a copy, never a view
      off += FRAME_BYTES
      if (isMuted()) {
        if (!wasMuted) { wasMuted = true; vad.reset() }
        continue
      }
      wasMuted = false
      const pcm = vad.push(frame)
      if (pcm) onUtterance(pcm)
    }
    pending = Buffer.from(pending.subarray(off))
  }

  function fail(message) {
    if (stopped) return
    onError(message)
    timer = setTimeout(() => { timer = null; launch() }, delay)
    timer.unref?.()
    delay = Math.min(delay * 2, maxBackoff)
  }

  function launch() {
    if (stopped) return
    pending = Buffer.alloc(0)
    wasMuted = false
    firstDataAt = 0
    let stderr = ''
    let done = false
    const c = spawn('ffmpeg', captureArgv(mic), {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: process.cwd(),
    })
    child = c
    c.stdout?.on('data', onData)
    c.stderr?.on('data', d => { stderr = (stderr + d).slice(-300) })
    c.on('error', err => {
      if (done) return
      done = true
      fail(err?.code === 'ENOENT'
        ? "Couldn't start ffmpeg for the microphone. Install FFmpeg and make sure ffmpeg is on PATH."
        : `Microphone capture failed to start: ${err?.message ?? err}`)
    })
    c.on('close', code => {
      if (done) return
      done = true
      const detail = stderr.trim() ? ` (${stderr.trim()})` : ''
      fail(`Microphone capture stopped (ffmpeg exit code ${code}). Retrying${detail}`)
    })
  }

  launch()

  return {
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      child?.kill()
      child = null
    },
  }
}

// Owns the listener's lifecycle. It runs only when listenMode is not 'off',
// an API key is configured and a mic is found. Call start() once to subscribe
// to config changes; sync() re-evaluates immediately.
export function createListenerManager({
  hub, env = process.env, listMics, startListener: start = startListener, stt, pcmToWav, createVad,
}) {
  let running = null // { stop }
  let closed = false
  let generation = 0 // bumped whenever the listener stops; stale transcripts are discarded
  let inFlight = 0
  let chain = Promise.resolve() // delivers transcripts to hub.hear in utterance order
  let noMicUntil = 0

  async function transcribe(pcm) {
    const cfg = hub.getConfig()
    const text = await stt(pcmToWav(pcm, 16000), { apiKey: cfg.apiKey, model: cfg.sttModel, language: cfg.sttLanguage })
    return String(text ?? '').trim()
  }

  // STT requests start immediately (in parallel); results are delivered in order.
  function onUtterance(pcm) {
    if (inFlight >= MAX_IN_FLIGHT) { hub.reportError(DROPPED); return }
    inFlight++
    const gen = generation
    const result = transcribe(pcm).then(text => ({ text }), error => ({ error }))
    chain = chain.then(async () => {
      const { text, error } = await result
      inFlight--
      if (gen !== generation) return
      try {
        if (error) hub.reportError(error)
        else if (text) await hub.hear(text)
      } catch (err) {
        hub.reportError(err)
      }
    })
  }

  function halt() {
    generation++
    running?.stop()
    running = null
  }

  function sync() {
    if (closed) return
    const cfg = hub.getConfig()
    const want = cfg.listenMode !== 'off' && Boolean(cfg.apiKey)
    if (!want) {
      if (running) {
        halt()
        hub.broadcast({ type: 'mic', state: 'off' })
      }
      return
    }
    if (running) return
    let mic = env.INTERCCOM_MIC
    if (!mic) {
      if (Date.now() < noMicUntil) return // probed recently; don't block on spawnSync again
      mic = listMics()[0]
      if (!mic) { noMicUntil = Date.now() + NO_MIC_CACHE_MS; hub.reportError(NO_MIC); return }
    }
    running = start({
      mic,
      vad: createVad(),
      // Echo guard: deaf while audio plays (by design for v1), so spoken "stop" works only between utterances.
      isMuted: () => hub.isPlaying() || Date.now() < hub.mutedUntil(),
      onUtterance,
      onError: msg => hub.reportError(msg),
    })
    hub.broadcast({ type: 'mic', state: 'listening' })
  }

  return {
    sync,
    start() { hub.onConfigChange(sync); sync() },
    stop() { closed = true; halt() },
  }
}
