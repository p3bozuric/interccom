// Short soft tones that tell the person the hub heard them, as WAV, made here so no
// sound files ship with the plugin. armed: rising, "Hey Claude" caught, say the rest.
// sent: falling, what you said went to a session.
import { pcmToWav } from './wav.mjs'

const RATE = 22050
const NOTES = {
  armed: [[660, 90], [990, 120]],
  sent: [[990, 90], [740, 120]],
}

function tone(freq, ms, volume) {
  const n = Math.round(RATE * ms / 1000)
  const fade = Math.round(RATE * 0.012)
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade)
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / RATE) * env * volume * 32767), i * 2)
  }
  return pcm
}

export function chimeWav(name, volume = 0.25) {
  const notes = NOTES[name]
  if (!notes) throw new Error(`unknown chime: ${name}`)
  return pcmToWav(Buffer.concat(notes.map(([f, ms]) => tone(f, ms, volume))), RATE)
}

export const CHIMES = Object.keys(NOTES)
