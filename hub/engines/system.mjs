// The operating system's own voice: no key, no server, nothing to install on Windows or macOS.
//   Windows: System.Speech through Windows PowerShell 5.1 (on every Windows 10 and 11).
//   macOS:   say.
//   Linux:   espeak-ng (sudo apt install espeak-ng).
// Plainer than the other engines, so it is mostly the fallback when the chosen engine fails,
// and the voice a fresh install can use before any key is set. Talking only.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn as realSpawn } from 'node:child_process'
import { run } from './command.mjs'
import { EngineError } from './elevenlabs.mjs'

const TIMEOUT_MS = 30_000

// The text arrives on stdin and the file name and voice in the environment, so nothing the
// model wrote is ever part of a command line.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:INTERCCOM_SYSTEM_VOICE) { $s.SelectVoice($env:INTERCCOM_SYSTEM_VOICE) }',
  '$s.SetOutputToWaveFile($env:INTERCCOM_SYSTEM_OUT)',
  '$s.Speak([Console]::In.ReadToEnd())',
  '$s.Dispose()',
].join('; ')

// The program for this platform: its argv, whether the audio lands in `file` or on stdout,
// the environment it needs, and what to tell a person who doesn't have it.
export function systemCommand({ platform = process.platform, voice = '', file }) {
  if (platform === 'win32') {
    return {
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
      toFile: true,
      env: { INTERCCOM_SYSTEM_OUT: file, INTERCCOM_SYSTEM_VOICE: voice },
      missing: "Windows PowerShell wasn't found, so the system voice can't speak.",
    }
  }
  if (platform === 'darwin') {
    return {
      argv: ['say', ...(voice ? ['-v', voice] : []), '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050'],
      toFile: true,
      env: {},
      missing: "macOS's say wasn't found, so the system voice can't speak.",
    }
  }
  return {
    argv: ['espeak-ng', '--stdin', '--stdout', ...(voice ? ['-v', voice] : [])],
    toFile: false,
    env: {},
    missing: 'The system voice needs espeak-ng: sudo apt install espeak-ng (or your distribution\'s package).',
  }
}

export async function tts(text, { voice = '', platform = process.platform, spawn = realSpawn, cwd = process.cwd(), timeoutMs = TIMEOUT_MS } = {}) {
  const dir = path.join(os.tmpdir(), 'interccom')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.wav`)
  const cmd = systemCommand({ platform, voice, file })
  try {
    const stdout = await run(cmd.argv, {
      input: text, spawn, cwd, timeoutMs, setting: 'tts_engine', env: { ...process.env, ...cmd.env },
    }).catch(err => {
      if (err instanceof EngineError && err.code === 'config') throw new EngineError('config', cmd.missing)
      throw err
    })
    const audio = cmd.toFile ? await readFile(file).catch(() => Buffer.alloc(0)) : stdout
    if (!audio.length) throw new EngineError('other', 'The system voice produced no audio.')
    return audio
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}
