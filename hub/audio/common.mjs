// Shared by the per-platform audio modules.

// 16 kHz mono s16le on stdout: what the VAD expects, whatever the capture device.
export const PCM_OUT = ['-ac', '1', '-ar', '16000', '-f', 's16le', '-']

// How one player run ended: null when it played (or was stopped on purpose), else the Error to report.
export function createPlayOutcome({ player, missing }) {
  return function playOutcome({ error, code, aborted, stderr = '' }) {
    if (aborted) return null
    if (error) return error.code === 'ENOENT' ? new Error(missing) : error
    if (code === 0) return null
    return new Error(`Couldn't play audio (${player} exit ${code}): ${String(stderr).trim().slice(-200)}`)
  }
}
