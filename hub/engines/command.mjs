// Local speech through any command-line program, e.g. Piper (TTS) or whisper.cpp's whisper-cli (STT).
//   tts_command: text arrives on stdin; the program writes audio to {out}, or to stdout without {out}.
//   stt_command: the utterance is a 16 kHz mono WAV at {in}; the program prints the transcript.
// No shell is involved: the command is split into argv here, with "double" or 'single' quotes
// grouping words and backslashes kept as-is, so Windows paths work unquoted.
import { spawn as realSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EngineError } from './elevenlabs.mjs'

const TIMEOUT_MS = 60_000

export function splitCommand(cmd) {
  const out = []
  let cur = ''
  let quote = ''
  let started = false
  for (const ch of String(cmd ?? '')) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false }
    } else {
      cur += ch
      started = true
    }
  }
  if (quote) throw new EngineError('config', `Unclosed quote in the command: ${cmd}`)
  if (started) out.push(cur)
  return out
}

// whisper-cli prints "[00:00:00.000 --> 00:00:02.000]  text" unless run with -nt.
export function cleanTranscript(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function run(argv, { input, spawn, cwd, timeoutMs, setting }) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd })
    const out = []
    let stderr = ''
    let done = false
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v) } }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new EngineError('network', `"${cmd}" took longer than ${Math.round(timeoutMs / 1000)} s; stopped it.`))
    }, timeoutMs)
    child.stdout?.on('data', d => out.push(d))
    child.stderr?.on('data', d => { stderr = (stderr + d).slice(-500) })
    child.on('error', err => finish(reject, err?.code === 'ENOENT'
      ? new EngineError('config', `Couldn't run "${cmd}". Install it, or put its full path in the ${setting} setting.`)
      : new EngineError('other', `Couldn't run "${cmd}": ${err?.message ?? err}`)))
    child.on('close', code => {
      if (code === 0) finish(resolve, Buffer.concat(out))
      else finish(reject, new EngineError('other', `"${cmd}" failed (exit ${code}): ${stderr.trim().slice(-200)}`))
    })
    child.stdin?.on('error', () => {}) // a program that ignores stdin may close it early
    child.stdin?.end(input ?? '')
  })
}

function argvFor(command, setting, placeholder, file) {
  const argv = splitCommand(command)
  if (!argv.length) throw new EngineError('config', `The ${setting} setting is empty.`)
  return { argv: argv.map(a => a.split(placeholder).join(file)), usesFile: argv.some(a => a.includes(placeholder)) }
}

async function tempFile(ext) {
  const dir = path.join(os.tmpdir(), 'interccom')
  await mkdir(dir, { recursive: true })
  return path.join(dir, `${randomUUID()}.${ext}`)
}

export async function tts(text, { command, spawn = realSpawn, cwd = process.cwd(), timeoutMs = TIMEOUT_MS }) {
  const file = await tempFile('wav')
  const { argv, usesFile } = argvFor(command, 'tts_command', '{out}', file)
  try {
    const stdout = await run(argv, { input: text, spawn, cwd, timeoutMs, setting: 'tts_command' })
    const audio = usesFile ? await readFile(file).catch(() => Buffer.alloc(0)) : stdout
    if (!audio.length) throw new EngineError('other', `"${argv[0]}" produced no audio${usesFile ? ' at {out}' : ' on stdout'}.`)
    return audio
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

export async function stt(wav, { command, spawn = realSpawn, cwd = process.cwd(), timeoutMs = TIMEOUT_MS }) {
  const file = await tempFile('wav')
  const { argv, usesFile } = argvFor(command, 'stt_command', '{in}', file)
  if (!usesFile) throw new EngineError('config', 'The stt_command setting must contain {in}, where the recording goes.')
  try {
    await writeFile(file, wav)
    return cleanTranscript(await run(argv, { spawn, cwd, timeoutMs, setting: 'stt_command' }))
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}
