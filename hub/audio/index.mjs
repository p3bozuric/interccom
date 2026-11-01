// The audio module for this platform: Windows (dshow), macOS (avfoundation) or Linux (pulse/alsa).
import * as windows from './windows.mjs'
import * as macos from './macos.mjs'
import * as linux from './linux.mjs'

export function platformAudio(platform = process.platform) {
  if (platform === 'win32') return windows
  if (platform === 'darwin') return macos
  return linux // Linux and other Unix-likes: best effort
}

export const { listMics, captureArgv, playArgv, playOutcome, FFMPEG_HINT } = platformAudio()
