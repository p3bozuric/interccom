// Mic listener: ffmpeg capture -> 30 ms frames -> VAD -> utterance callback.
// createListenerManager decides when the listener runs and routes utterances
// through STT to hub.hear.
import { spawn as realSpawn } from 'node:child_process'
import { captureArgv as platformCapture, FFMPEG_HINT } from './audio/index.mjs'

const FRAME_BYTES = 960 // 480 samples * 2 bytes = 30 ms at 16 kHz mono s16le
const MAX_IN_FLIGHT = 3
const NO_MIC_CACHE_MS = 30_000
const HEALTHY_MS = 5_000
const DROPPED = 'Speech is arriving faster than it can be transcribed; dropped some audio.'
const NO_MIC = 'No microphone found. Plug one in, or set INTERCCOM_MIC to its name.'

export function startListener({
  mic, spawn = realSpawn, vad, isMuted, onUtterance, onError, backoffMs = [2000, 30000],
  captureArgv = platformCapture, onSpeaking = () => {}, onLive = () => {},
}) {
  const [minBackoff, maxBackoff] = backoffMs
  let child = null
  let timer = null
  let stopped = false
  let delay = minBackoff
  let pending = Buffer.alloc(0)
  let wasMuted = false
  let firstDataAt = 0
  let speaking = false

  function setSpeaking(on) {
    if (on === speaking) return
    speaking = on
    onSpeaking(on)
  }

  function onData(chunk) {
    // Only a mic that has kept producing audio for a while counts as healthy.
    const t = Date.now()
    if (!firstDataAt) { firstDataAt = t; onLive() }
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
    setSpeaking(Boolean(vad.active?.()))
    pending = Buffer.from(pending.subarray(off))
  }

  function fail(message) {
    if (stopped) return
    setSpeaking(false)
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
        ? `Couldn't start ffmpeg for the microphone. ${FFMPEG_HINT}`
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
      setSpeaking(false)
      if (timer) { clearTimeout(timer); timer = null }
      child?.kill()
      child = null
    },
  }
}

// Owns the listener's lifecycle. It runs only when listenMode is not 'off',
// the speech-to-text engine is usable (e.g. an API key is set) and a mic is found. Call start() once to subscribe
// to config changes; sync() re-evaluates immediately.
export function createListenerManager({
  hub, env = process.env, listMics, startListener: start = startListener, stt, pcmToWav, createVad,
  sttReady = cfg => Boolean(cfg.apiKey),
}) {
  let running = null // { stop }
  let closed = false
  let generation = 0 // bumped whenever the listener stops; stale transcripts are discarded
  let inFlight = 0
  let chain = Promise.resolve() // delivers transcripts to hub.hear in utterance order
  let noMicUntil = 0

  async function transcribe(pcm) {
    const cfg = hub.getConfig()
    const text = await stt(pcmToWav(pcm, 16000), cfg)
    return String(text ?? '').trim()
  }

  // STT requests start immediately (in parallel); results are delivered in order.
  function onUtterance(pcm) {
    if (inFlight >= MAX_IN_FLIGHT) { hub.reportError(DROPPED); return }
    inFlight++
    hub.transcribing?.(1)
    const gen = generation
    const result = transcribe(pcm).then(text => ({ text }), error => ({ error }))
    chain = chain.then(async () => {
      const { text, error } = await result
      inFlight--
      try {
        if (gen !== generation) return
        if (error) hub.reportError(error)
        else if (text) await hub.hear(text)
      } catch (err) {
        hub.reportError(err)
      } finally {
        hub.transcribing?.(-1)
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
    const want = cfg.listenMode !== 'off' && sttReady(cfg)
    if (!want) {
      if (running) {
        halt()
        // Off on purpose (/listen off) reads differently from a mic that doesn't work.
        hub.broadcast({ type: 'mic', state: 'off', ...(cfg.listenMode === 'off' ? { reason: 'paused' } : {}) })
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
      onError: msg => { hub.broadcast({ type: 'mic', state: 'off' }); hub.reportError(msg) },
      onSpeaking: on => hub.speaking?.(on),
      // Listening only once audio actually arrives: a mic that fails to start is "not connected".
      onLive: () => hub.broadcast({ type: 'mic', state: 'listening', name: mic }),
    })
  }

  return {
    sync,
    start() { hub.onConfigChange(sync); sync() },
    stop() { closed = true; halt() },
  }
}
