// Pure loudness VAD over 30 ms frames (16 kHz mono s16le, 960 bytes each).
// Feed frames to push(); it returns a finished utterance's PCM or null.
// Echo muting is the caller's job: call reset() when muting begins.
const DEFAULTS = { startFrames: 3, endFrames: 54, preroll: 10, minLoud: 12, maxFrames: 1000, minThreshold: 350 }
const INITIAL_FLOOR = 200

function rms(buf) {
  let s = 0
  for (let i = 0; i < buf.length; i += 2) { const v = buf.readInt16LE(i); s += v * v }
  return Math.sqrt(s / (buf.length / 2))
}

export function createVad(opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  let floor = INITIAL_FLOOR
  let preroll = []
  let segment = null // { frames, loud, quiet }
  let loudRun = 0

  function reset() {
    // The learned noise floor survives: it describes the room, not the utterance.
    preroll = []
    segment = null
    loudRun = 0
  }

  function push(frame) {
    const level = rms(frame)
    const loud = level > Math.max(floor * 3, o.minThreshold)

    if (!segment) {
      if (!loud) floor = floor * 0.98 + level * 0.02
      preroll.push(frame)
      if (preroll.length > o.preroll) preroll.shift()
      loudRun = loud ? loudRun + 1 : 0
      if (loudRun >= o.startFrames) { segment = { frames: [...preroll], loud: loudRun, quiet: 0 }; preroll = [] }
      return null
    }
    segment.frames.push(frame)
    if (loud) { segment.loud++; segment.quiet = 0 } else segment.quiet++
    if (segment.quiet >= o.endFrames || segment.frames.length >= o.maxFrames) {
      const done = segment
      segment = null
      loudRun = 0
      if (done.loud >= o.minLoud) return Buffer.concat(done.frames)
    }
    return null
  }

  return { push, reset }
}
