// Hub entry point: node hub/main.mjs [--state-dir <dir>]
// Writes <stateDir>/hub.json { port, token, pid } once listening.
// The API key arrives only via POST /config from sessions. Speech engines: hub/engines/index.mjs.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createHub } from './server.mjs'
import { createEngines, audioExt } from './engines/index.mjs'
import { playArgv, playOutcome, listMics, FFMPEG_HINT } from './audio/index.mjs'
import { createListenerManager } from './listener.mjs'
import { createVad } from './vad.mjs'
import { pcmToWav } from './wav.mjs'
import { resolveCodexArgv, queueArgv } from './hosts/codex.mjs'

const { values } = parseArgs({ options: { 'state-dir': { type: 'string' } } })
const stateDir = values['state-dir'] || path.join(os.homedir(), '.interccom')
const hubFile = path.join(stateDir, 'hub.json')
const token = randomBytes(24).toString('hex')

// Security: on Windows a bare-name spawn ('ffplay') searches the current
// directory before PATH, and this detached hub may inherit an untrusted
// project folder as its cwd. Move into our own state dir so a planted
// ffplay.exe in a project can never run; spawns also pass cwd explicitly.
mkdirSync(stateDir, { recursive: true })
process.chdir(stateDir)
if (process.env.INTERCCOM_TEST_LOG) appendFileSync(process.env.INTERCCOM_TEST_LOG, `${process.pid}\n`)

// Command engines run with the state dir as cwd, for the same reason as ffplay below.
const engines = createEngines({ cwd: stateDir })

const audio = {
  async play(audioBuf, signal) {
    if (signal.aborted) return
    const dir = path.join(os.tmpdir(), 'interccom')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${randomUUID()}.${audioExt(audioBuf)}`)
    await writeFile(file, audioBuf)
    try {
      // A /stop may have landed while we were writing the file.
      if (signal.aborted) return
      await new Promise((resolve, reject) => {
        const [cmd, args] = playArgv(file)
        const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, cwd: stateDir })
        let stderr = ''
        let settled = false
        child.stderr?.on('data', d => { stderr = (stderr + d).slice(-1000) })
        const kill = () => child.kill()
        signal.addEventListener('abort', kill, { once: true })
        if (signal.aborted) kill()
        // A failure rejects, so the player's onError reports it to every session.
        const finish = outcome => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', kill)
          const err = playOutcome({ ...outcome, aborted: signal.aborted, stderr })
          if (err) reject(err)
          else resolve()
        }
        child.on('error', error => finish({ error }))
        child.on('close', code => finish({ code }))
      })
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  },
}

// Speech for an idle Codex session becomes its next message through `codex queue`. No shell:
// the transcript is one argv entry, never parsed as a command line.
const NO_CODEX = "Couldn't find Codex to pass your speech to. Set INTERCCOM_CODEX_BIN to its full path."
function hostSubmit({ host, hostSessionId, cwd, text }) {
  if (host !== 'codex') return Promise.reject(new Error(`interccom can't start a turn in ${host} sessions`))
  const base = resolveCodexArgv()
  if (!base) return Promise.reject(new Error(NO_CODEX))
  const [cmd, ...args] = queueArgv(base, { hostSessionId, text, cwd })
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, cwd: stateDir })
    let stderr = ''
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stderr?.on('data', d => { stderr = (stderr + d).slice(-500) })
    child.on('error', err => { clearTimeout(timer); reject(err?.code === 'ENOENT' ? new Error(NO_CODEX) : err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Couldn't pass your speech to Codex (codex queue exit ${code}): ${stderr.trim().slice(-200)}`))
    })
  })
}

// For the setup check: are the audio programs there? (No shell; cwd is the state dir.)
function runs(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, cwd: stateDir, timeout: 5000 })
  return !r.error
}
async function checkMachine() {
  const [player] = playArgv('x')
  const playerArgs = player === 'afplay' ? ['-h'] : ['-version']
  return {
    ffmpeg: runs('ffmpeg', ['-version']),
    ffmpegHint: FFMPEG_HINT,
    player: { name: player, ok: runs(player, playerArgs), hint: playOutcome({ error: Object.assign(new Error(''), { code: 'ENOENT' }) })?.message },
  }
}

function removeHubFile() {
  try {
    if (JSON.parse(readFileSync(hubFile, 'utf8')).pid === process.pid) unlinkSync(hubFile)
  } catch { /* gone or unreadable */ }
}

async function shutdown() {
  removeHubFile()
  listener.stop()
  await hub.close().catch(() => {})
  process.exit(0)
}

const hub = createHub({ token, engines, audio, onIdleExit: shutdown, hostSubmit, checkMachine, debugHear: process.env.INTERCCOM_DEBUG_HEAR === '1' })
const listener = createListenerManager({ hub, listMics, stt: engines.stt, sttReady: engines.sttReady, pcmToWav, createVad })
listener.start() // follows /config and /listen changes from here on
const { port } = await hub.listen(0)
// Atomic write: readers never see a half-written hub.json.
const tmpFile = path.join(stateDir, `hub.json.${process.pid}.tmp`)
writeFileSync(tmpFile, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 })
renameSync(tmpFile, hubFile)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
