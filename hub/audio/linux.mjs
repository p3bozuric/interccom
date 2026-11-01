// Linux audio: capture through FFmpeg's PulseAudio input (PipeWire serves it too),
// or ALSA when INTERCCOM_MIC is "alsa:<device>"; playback through ffplay.
import { spawnSync as realSpawnSync } from 'node:child_process'
import { PCM_OUT, createPlayOutcome } from './common.mjs'

export const FFMPEG_HINT = "Install FFmpeg with your distribution's package manager (e.g. sudo apt install ffmpeg) and make sure ffmpeg is on PATH."

// `pactl list short sources`: index <tab> name <tab> driver <tab> format <tab> state.
// Monitors capture what's playing, not a microphone: skip them.
export function parsePactlSources(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const name = line.split('\t')[1]?.trim()
    if (name && !name.endsWith('.monitor')) out.push(name)
  }
  return out
}

// Without pactl (plain ALSA, or a minimal system), fall back to Pulse's "default" source.
export function listMics({ spawnSync = realSpawnSync } = {}) {
  const r = spawnSync('pactl', ['list', 'short', 'sources'], { encoding: 'utf8', cwd: process.cwd(), timeout: 10_000 })
  if (!r || r.error || r.status !== 0) return ['default']
  const found = parsePactlSources(r.stdout)
  return found.length ? found : ['default']
}

export function captureArgv(mic) {
  const m = /^alsa:(.+)$/.exec(String(mic))
  const input = m ? ['-f', 'alsa', '-i', m[1]] : ['-f', 'pulse', '-i', String(mic)]
  return ['-hide_banner', '-loglevel', 'error', ...input, ...PCM_OUT]
}

export function playArgv(file) {
  return ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', file]]
}

export const playOutcome = createPlayOutcome({
  player: 'ffplay',
  missing: `ffplay not found. ${FFMPEG_HINT.replace('ffmpeg is', 'ffplay is')}`,
})
