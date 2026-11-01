// Windows audio commands. Capture and playback go through FFmpeg (ffmpeg, ffplay).
import { spawnSync as realSpawnSync } from 'node:child_process'
import { PCM_OUT, createPlayOutcome } from './common.mjs'

// Audio devices from `ffmpeg -list_devices true -f dshow -i dummy` output.
// Each device line looks like: [dshow @ 000...] "Name" (audio)
export function parseDshowDevices(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /"([^"]+)"\s+\(audio\)\s*$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

// ffmpeg exits non-zero for -list_devices and prints the list on stderr,
// so parse both streams and ignore the exit code.
// cwd is the process cwd, which main.mjs has moved into the state dir, so a
// planted ffmpeg.exe in an untrusted project folder is never picked up.
export function listMics({ spawnSync = realSpawnSync } = {}) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    encoding: 'utf8', windowsHide: true, cwd: process.cwd(), timeout: 10_000,
  })
  if (!r || r.error) return []
  return parseDshowDevices(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)
}

export function captureArgv(mic) {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${mic}`, ...PCM_OUT]
}

export function playArgv(file) {
  return ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', file]]
}

export const FFMPEG_HINT = 'Install FFmpeg (winget install Gyan.FFmpeg) and make sure ffmpeg is on PATH.'

export const playOutcome = createPlayOutcome({
  player: 'ffplay',
  missing: "ffplay not found. Install ffmpeg (Windows: winget install Gyan.FFmpeg) and make sure it's on PATH.",
})
