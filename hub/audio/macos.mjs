// macOS audio: capture through FFmpeg's avfoundation input, playback through the built-in afplay.
import { spawnSync as realSpawnSync } from 'node:child_process'
import { PCM_OUT, createPlayOutcome } from './common.mjs'

export const FFMPEG_HINT = 'Install FFmpeg (brew install ffmpeg) and make sure ffmpeg is on PATH.'

// `ffmpeg -f avfoundation -list_devices true -i ""` prints video devices, then audio devices:
//   [AVFoundation indev @ 0x7f8] AVFoundation audio devices:
//   [AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone
export function parseAvfoundationDevices(text) {
  const out = []
  let audio = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/AVFoundation audio devices:/.test(line)) { audio = true; continue }
    if (/AVFoundation video devices:/.test(line)) { audio = false; continue }
    const m = audio && /\]\s*\[(\d+)\]\s+(.+?)\s*$/.exec(line)
    if (m) out.push(m[2])
  }
  return out
}

export function listMics({ spawnSync = realSpawnSync } = {}) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8', cwd: process.cwd(), timeout: 10_000,
  })
  if (!r || r.error) return []
  return parseAvfoundationDevices(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)
}

// ":<name>" picks an audio-only device by name (an index such as ":0" works too).
export function captureArgv(mic) {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', `:${mic}`, ...PCM_OUT]
}

export function playArgv(file) {
  return ['afplay', [file]]
}

export const playOutcome = createPlayOutcome({
  player: 'afplay',
  missing: 'afplay not found. It ships with macOS; check that /usr/bin is on PATH.',
})
