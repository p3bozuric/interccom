// ensureHub: guarantee exactly one hub process, starting it detached if needed.
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const POLL_MS = 100
const LOCK_STALE_MS = 10_000
const sleep = ms => new Promise(r => setTimeout(r, ms))

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return false }
}

// Returns { port, token } when the hub named by hub.json is alive and proves
// it holds the token (HMAC of a fresh nonce, asked without the token), else null. A rejected hub.json is
// removed, but only if it still names the same pid.
async function probe(stateDir) {
  const file = path.join(stateDir, 'hub.json')
  let h
  try { h = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  const reject = () => {
    try {
      if (JSON.parse(readFileSync(file, 'utf8')).pid === h?.pid) unlinkSync(file)
    } catch { /* gone or replaced */ }
    return null
  }
  if (!h || !h.port || !h.token || !alive(h.pid)) return reject()
  try {
    const nonce = randomBytes(16).toString('hex')
    // No token here: it is sent only to a hub that has proved it already holds it.
    const res = await fetch(`http://127.0.0.1:${h.port}/health?nonce=${nonce}`, {
      signal: AbortSignal.timeout(1000),
    })
    const body = await res.json()
    const want = createHmac('sha256', h.token).update(nonce).digest()
    const got = Buffer.from(String(body?.proof ?? ''), 'hex')
    if (res.ok && got.length === want.length && timingSafeEqual(got, want)) {
      return { port: h.port, token: h.token }
    }
  } catch { /* unreachable */ }
  return reject()
}

// The hub outlives the session that starts it: it gets that session's env minus
// the API keys, which reach it only through POST /config.
const KEY_VARS = new Set(['INTERCCOM_API_KEY', 'ELEVENLABS_API_KEY'])
export function hubEnv(env = process.env) {
  // Case-insensitive: Windows env names are.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !KEY_VARS.has(k.toUpperCase())))
}

function tryLock(lockDir) {
  try {
    mkdirSync(lockDir)
    writeFileSync(path.join(lockDir, 'pid'), String(process.pid))
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    return false
  }
}

function releaseLock(lockDir) {
  try {
    if (Number(readFileSync(path.join(lockDir, 'pid'), 'utf8')) === process.pid) rmSync(lockDir, { recursive: true, force: true })
  } catch { /* already taken over */ }
}

function lockIsStale(lockDir) {
  try {
    if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) return true
    const pid = Number(readFileSync(path.join(lockDir, 'pid'), 'utf8'))
    return !pid || !alive(pid)
  } catch {
    // Lock vanished, or its owner has not written its pid yet; the age check covers a stuck one.
    return false
  }
}

export async function ensureHub({ stateDir, hubEntry, timeoutMs = 12_000 }) {
  stateDir = path.resolve(stateDir)
  mkdirSync(stateDir, { recursive: true })
  const lockDir = path.join(stateDir, 'launch.lock')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const found = await probe(stateDir)
    if (found) return found

    if (!tryLock(lockDir)) {
      if (lockIsStale(lockDir)) {
        // Atomic takeover: only one caller wins the rename; losers just retry.
        const aside = `${lockDir}.stale-${process.pid}-${Date.now()}`
        try { renameSync(lockDir, aside); rmSync(aside, { recursive: true, force: true }) } catch { /* lost the race */ }
      } else await sleep(POLL_MS)
      continue
    }
    try {
      const again = await probe(stateDir)
      if (again) return again
      // cwd is the state dir so Windows never searches an untrusted caller cwd.
      const child = spawn(process.execPath, [hubEntry, '--state-dir', stateDir], {
        detached: true, stdio: 'ignore', windowsHide: true, cwd: stateDir, env: hubEnv(),
      })
      let spawnError = null
      child.on('error', e => { spawnError = e })
      child.unref()
      while (Date.now() < deadline) {
        if (spawnError) throw new Error(`could not start interccom hub: ${spawnError.message}`)
        const up = await probe(stateDir)
        if (up) return up
        await sleep(POLL_MS)
      }
    } finally {
      releaseLock(lockDir)
    }
  }
  throw new Error('interccom hub did not start in time')
}
