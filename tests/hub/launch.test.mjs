import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureHub, hubEnv } from '../../hub/launch.mjs'

const hubEntry = fileURLToPath(new URL('../../hub/main.mjs', import.meta.url))
const connectEntry = fileURLToPath(new URL('../../hub/connect.mjs', import.meta.url))
const pids = new Set()
const dirs = []

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'interccom-launch-'))
  dirs.push(d)
  return d
}
const readHub = dir => JSON.parse(fs.readFileSync(path.join(dir, 'hub.json'), 'utf8'))
async function health(h) {
  const r = await fetch(`http://127.0.0.1:${h.port}/health`, { headers: { 'x-interccom-token': h.token } })
  return r.json()
}

after(() => {
  for (const d of dirs) { try { pids.add(readHub(d).pid) } catch { /* no hub */ } }
  for (const pid of pids) { try { process.kill(pid) } catch { /* gone */ } }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* in use */ } }
})

test('starts a hub and reuses it', async () => {
  const stateDir = tmp()
  const a = await ensureHub({ stateDir, hubEntry })
  pids.add(readHub(stateDir).pid)
  const b = await ensureHub({ stateDir, hubEntry })
  assert.equal(a.port, b.port)
  assert.equal(a.token, b.token)
  assert.equal((await health(b)).ok, true)
})

test('concurrent ensureHub calls start one hub', async () => {
  const stateDir = tmp()
  const log = path.join(stateDir, 'starts.log')
  process.env.INTERCCOM_TEST_LOG = log
  let rs
  try {
    rs = await Promise.all([1, 2, 3].map(() => ensureHub({ stateDir, hubEntry })))
  } finally { delete process.env.INTERCCOM_TEST_LOG }
  for (const l of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) pids.add(Number(l))
  assert.equal(new Set(rs.map(r => r.port)).size, 1)
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 1)
})

test('relaunches after the hub is killed', async () => {
  const stateDir = tmp()
  await ensureHub({ stateDir, hubEntry })
  const first = readHub(stateDir).pid
  pids.add(first)
  process.kill(first)
  // SIGTERM is asynchronous: until the old hub has exited it may still (rightly) answer the probe.
  for (let i = 0; i < 200; i++) {
    try { process.kill(first, 0) } catch { break }
    await new Promise(r => setTimeout(r, 10))
  }
  const h = await ensureHub({ stateDir, hubEntry })
  const second = readHub(stateDir).pid
  pids.add(second)
  assert.notEqual(second, first)
  assert.equal((await health(h)).ok, true)
})

test('connect.mjs links, streams events, and the hub drops the session on exit', async () => {
  const stateDir = tmp()
  const env = { ...process.env, INTERCCOM_STATE_DIR: stateDir, ELEVENLABS_API_KEY: '', INTERCCOM_NO_KEY_FALLBACK: '1' }
  delete env.INTERCCOM_API_KEY
  const child = spawn(process.execPath, [connectEntry, '--name', 'tester', '--cwd', stateDir, '--pid', String(process.pid)],
    { env, cwd: stateDir, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  let buf = ''
  const lines = []
  const waiters = []
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
    waiters.splice(0).forEach(w => w())
  })
  const until = async n => {
    const deadline = Date.now() + 10_000
    while (lines.length < n) {
      if (Date.now() > deadline) throw new Error('timeout waiting for lines: ' + JSON.stringify(lines))
      await new Promise(r => { waiters.push(r); setTimeout(r, 100) })
    }
  }
  try {
    await until(2)
    const hub = readHub(stateDir)
    pids.add(hub.pid)
    const [link, hello] = lines
    assert.equal(link.type, 'link')
    assert.equal(link.port, hub.port)
    assert.equal(link.token, hub.token)
    assert.equal(link.name, 'tester')
    assert.ok(link.sessionId)
    assert.deepEqual(hello, { type: 'hello', sessionId: link.sessionId, name: 'tester' })
    assert.equal((await health(hub)).sessions, 1)
    child.kill()
    const deadline = Date.now() + 5000
    let n = 1
    while (Date.now() < deadline && (n = (await health(hub)).sessions) !== 0) await new Promise(r => setTimeout(r, 100))
    assert.equal(n, 0)
  } finally { child.kill() }
})

test('takes over a stale lock and still starts exactly one hub', async () => {
  const stateDir = tmp()
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
  await new Promise(r => dead.on('exit', r))
  fs.mkdirSync(path.join(stateDir, 'launch.lock'))
  fs.writeFileSync(path.join(stateDir, 'launch.lock', 'pid'), String(dead.pid))
  const log = path.join(stateDir, 'starts.log')
  process.env.INTERCCOM_TEST_LOG = log
  try {
    await Promise.all([1, 2].map(() => ensureHub({ stateDir, hubEntry })))
  } finally { delete process.env.INTERCCOM_TEST_LOG }
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 1)
})

test('ignores an impostor on the recorded port and never sends it a POST', async () => {
  const stateDir = tmp()
  const methods = []
  const tokens = []
  const fake = http.createServer((req, res) => {
    methods.push(req.method)
    if (req.headers['x-interccom-token'] !== undefined) tokens.push(req.headers['x-interccom-token'])
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, sessions: 0 }))
  })
  await new Promise(r => fake.listen(0, '127.0.0.1', r))
  try {
    fs.writeFileSync(path.join(stateDir, 'hub.json'),
      JSON.stringify({ port: fake.address().port, token: 'x', pid: process.pid }))
    const h = await ensureHub({ stateDir, hubEntry })
    assert.notEqual(h.port, fake.address().port)
    assert.equal(readHub(stateDir).port, h.port)
    assert.ok(!methods.includes('POST'))
    assert.ok(methods.length > 0)
    assert.deepEqual(tokens, [])
  } finally { fake.close() }
})

test('connect.mjs ends quietly with exit 0 when the event stream breaks after linking', async () => {
  const stateDir = tmp()
  const env = { ...process.env, INTERCCOM_STATE_DIR: stateDir, ELEVENLABS_API_KEY: '', INTERCCOM_NO_KEY_FALLBACK: '1' }
  delete env.INTERCCOM_API_KEY
  const child = spawn(process.execPath, [connectEntry, '--name', 'tester', '--cwd', stateDir, '--pid', String(process.pid)],
    { env, cwd: stateDir, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  const exited = new Promise(r => child.on('exit', code => r(code)))
  try {
    const deadline = Date.now() + 10_000
    while (out.split('\n').filter(Boolean).length < 2) {
      if (Date.now() > deadline) throw new Error('timeout waiting for link and hello: ' + out)
      await new Promise(r => setTimeout(r, 50))
    }
    const hub = readHub(stateDir)
    pids.add(hub.pid)
    process.kill(hub.pid)
    assert.equal(await exited, 0)
    const types = out.split('\n').filter(Boolean).map(l => JSON.parse(l).type)
    assert.ok(!types.includes('error'), out)
  } finally { child.kill() }
})

test('hubEnv copies the environment without the API keys', () => {
  const src = { PATH: '/bin', INTERCCOM_API_KEY: 'a', ELEVENLABS_API_KEY: 'b', INTERCCOM_TEST_LOG: 'l' }
  assert.deepEqual(hubEnv(src), { PATH: '/bin', INTERCCOM_TEST_LOG: 'l' })
  assert.deepEqual(hubEnv({ Elevenlabs_Api_Key: 'c', Path: 'p' }), { Path: 'p' })
  assert.equal(src.ELEVENLABS_API_KEY, 'b')
})

import { resolveNode } from '../../hub/launch.mjs'

test('resolveNode: real node as is; inside Bun or a packaged CLI, node from PATH; override; clear error', () => {
  assert.equal(resolveNode({ env: {}, execPath: '/usr/bin/node', versions: {} }), '/usr/bin/node')
  assert.equal(resolveNode({ env: {}, execPath: 'C:\\Program Files\\nodejs\\node.exe', versions: {}, platform: 'win32' }), 'C:\\Program Files\\nodejs\\node.exe')
  const exists = f => f === '/opt/n/bin/node' || f === 'C:\\n\\node.exe'
  assert.equal(resolveNode({ env: { PATH: '/x:/opt/n/bin' }, execPath: '/usr/local/bin/opencode', versions: { bun: '1.2' }, exists }), '/opt/n/bin/node')
  assert.equal(resolveNode({ env: { PATH: '/opt/n/bin' }, execPath: '/usr/bin/node', versions: { bun: '1.2' }, exists }), '/opt/n/bin/node')
  assert.equal(resolveNode({ env: { Path: 'C:\\x;C:\\n' }, execPath: 'C:\\copilot\\copilot.exe', versions: {}, platform: 'win32', exists }), 'C:\\n\\node.exe')
  assert.equal(resolveNode({ env: { INTERCCOM_NODE: '/my/node' }, execPath: '/opencode', versions: { bun: '1' } }), '/my/node')
  assert.throws(() => resolveNode({ env: { PATH: '/x' }, execPath: '/opencode', versions: {}, exists: () => false }), /INTERCCOM_NODE/)
})
