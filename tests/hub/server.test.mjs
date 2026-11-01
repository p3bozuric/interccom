import { createHmac } from 'node:crypto'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '../../hub/server.mjs'
import { EngineError } from '../../hub/engines/elevenlabs.mjs'

const TOKEN = 'test-token'
const hubs = []
const streams = []

afterEach(async () => {
  for (const s of streams.splice(0)) s.abort()
  for (const h of hubs.splice(0)) await h.close()
})

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

function gate() {
  let open
  const p = new Promise(r => { open = r })
  return { p, open }
}

// Fake audio: records what was played; each play waits for the gate (or an abort).
function fakeAudio(g) {
  const a = { played: [], signals: [], active: 0, peak: 0 }
  a.play = async (mp3, signal) => {
    a.active++
    a.peak = Math.max(a.peak, a.active)
    a.signals.push(signal)
    try {
      await Promise.race([
        g ? g.p : Promise.resolve(),
        new Promise(r => signal.addEventListener('abort', r, { once: true })),
      ])
      a.played.push(mp3.toString())
    } finally {
      a.active--
    }
  }
  return a
}

const fakeEngines = () => ({
  tts: async text => Buffer.from(text),
  stt: async () => '',
})

async function start(opts = {}) {
  const hub = createHub({ token: TOKEN, engines: fakeEngines(), audio: fakeAudio(), ...opts })
  hubs.push(hub)
  const { port } = await hub.listen(0)
  const base = `http://127.0.0.1:${port}`
  const call = async (method, path, body, headers = { 'x-interccom-token': TOKEN }) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, json: await res.json() }
  }
  const register = async name => (await call('POST', '/sessions', { name, cwd: '/x', pid: 1 })).json
  const open = async sessionId => {
    const ac = new AbortController()
    const res = await fetch(`${base}/events?session=${sessionId}`, {
      headers: { 'x-interccom-token': TOKEN },
      signal: ac.signal,
    })
    // raw: every line. lines: without keepalive and mic-state lines, so tests can count events.
    const s = { raw: [], lines: [], waiters: [], abort: () => ac.abort() }
    streams.push(s)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    ;(async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (line.trim()) {
              const msg = JSON.parse(line)
              s.raw.push(msg)
              if (msg.type !== 'ping' && msg.type !== 'mic') s.lines.push(msg)
            }
            s.waiters.splice(0).forEach(w => w())
          }
        }
      } catch { /* aborted */ }
    })()
    s.rawLine = async n => {
      while (s.raw.length <= n) await new Promise(r => s.waiters.push(r))
      return s.raw[n]
    }
    s.line = async n => {
      while (s.lines.length <= n) await new Promise(r => s.waiters.push(r))
      return s.lines[n]
    }
    await s.line(0)
    return s
  }
  return { hub, base, call, register, open }
}

const waitFor = async (cond, ms = 1000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await tick(5)
  }
}

test('rejects requests without token', async () => {
  const { call } = await start()
  assert.equal((await call('GET', '/health', null, {})).status, 401)
  assert.equal((await call('GET', '/health', null, { 'x-interccom-token': 'nope' })).status, 401)
  const ok = await call('GET', '/health')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { ok: true, sessions: 0 })
})

test('health proves identity with an HMAC of the nonce, without the token and nothing else', async () => {
  const { call, register } = await start()
  await register('api')
  const r = await call('GET', '/health?nonce=ab', null, {})
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { proof: createHmac('sha256', TOKEN).update('ab').digest('hex') })
  assert.equal((await call('GET', '/health?nonce=not-hex', null, {})).status, 400)
})

test('register, stream hello, deregister on close', async () => {
  const { call, register, open } = await start()
  const { sessionId, name } = await register('My Api')
  assert.equal(name, 'my-api')
  const s = await open(sessionId)
  assert.deepEqual(s.lines[0], { type: 'hello', sessionId, name: 'my-api' })
  assert.equal((await call('GET', '/health')).json.sessions, 1)
  s.abort()
  await tick()
  assert.equal((await call('GET', '/health')).json.sessions, 0)
})

test('session endpoints: rename, state, active, delete, board', async () => {
  const { call, register } = await start()
  const { sessionId } = await register('api')
  await register('web')
  assert.deepEqual((await call('POST', `/sessions/${sessionId}/name`, { name: 'web' })).json, { name: 'web-2' })
  assert.deepEqual((await call('POST', `/sessions/${sessionId}/state`, { busy: true })).json, {})
  assert.deepEqual((await call('POST', `/sessions/${sessionId}/active`)).json, {})
  const board = (await call('GET', '/board')).json
  assert.equal(board.mode, 'wake')
  assert.equal(board.playing, false)
  const row = board.sessions.find(r => r.sessionId === sessionId)
  assert.equal(row.name, 'web-2')
  assert.equal(row.busy, true)
  assert.ok(row.lastActiveAt > 0)
  assert.deepEqual((await call('DELETE', `/sessions/${sessionId}`)).json, {})
  assert.equal((await call('GET', '/health')).json.sessions, 1)
  assert.equal((await call('POST', `/sessions/${sessionId}/active`)).status, 404)
})

test('plays one item at a time in priority order', async () => {
  const g = gate()
  const audio = fakeAudio(g)
  const { call, register } = await start({ audio })
  const { sessionId } = await register('api')
  await call('POST', '/speak', { sessionId, text: 'a', priority: 'status' })
  await call('POST', '/speak', { sessionId, text: 'b', priority: 'question' })
  await call('POST', '/speak', { sessionId, text: 'c', priority: 'heads-up' })
  g.open()
  await waitFor(() => audio.played.length === 3)
  assert.deepEqual(audio.played, ['a', 'b', 'c'])
  assert.equal(audio.peak, 1)
})

test('paused player takes items in priority order once resumed', async () => {
  const g = gate()
  const audio = fakeAudio(g)
  const { hub, call, register } = await start({ audio, startPaused: true })
  const { sessionId } = await register('api')
  await call('POST', '/speak', { sessionId, text: 'a', priority: 'status' })
  await call('POST', '/speak', { sessionId, text: 'b', priority: 'question' })
  await call('POST', '/speak', { sessionId, text: 'c', priority: 'heads-up' })
  await tick()
  assert.equal(audio.signals.length, 0)
  g.open()
  hub.resumePlayer()
  await waitFor(() => audio.played.length === 3)
  assert.deepEqual(audio.played, ['b', 'c', 'a'])
  assert.equal(audio.peak, 1)
})

test('speak returns spoken text, or queued:false when empty', async () => {
  const { call, register } = await start()
  const { sessionId } = await register('api')
  assert.deepEqual((await call('POST', '/speak', { sessionId, text: '**done**', priority: 'status' })).json,
    { queued: true, spoken: 'done' })
  assert.deepEqual((await call('POST', '/speak', { sessionId, text: '```x```', priority: 'status' })).json,
    { queued: false })
})

test('prefixes the name when more than one session', async () => {
  const audio = fakeAudio()
  const { call, register } = await start({ audio })
  const api = await register('api')
  await call('POST', '/speak', { sessionId: api.sessionId, text: 'done', priority: 'status' })
  await waitFor(() => audio.played.length === 1)
  await register('web')
  await call('POST', '/speak', { sessionId: api.sessionId, text: 'done', priority: 'status' })
  await waitFor(() => audio.played.length === 2)
  assert.deepEqual(audio.played, ['done', 'api: done'])
  const row = (await call('GET', '/board')).json.sessions.find(r => r.sessionId === api.sessionId)
  assert.equal(row.lastLine, 'done')
})

test('muted drops items without playing', async () => {
  const audio = fakeAudio()
  const { call, register } = await start({ audio })
  const { sessionId } = await register('api')
  await call('POST', '/config', { muted: true })
  await call('POST', '/speak', { sessionId, text: 'hidden', priority: 'status' })
  await tick()
  await call('POST', '/config', { muted: false })
  await call('POST', '/speak', { sessionId, text: 'shown', priority: 'status' })
  await waitFor(() => audio.played.length === 1)
  assert.deepEqual(audio.played, ['shown'])
})

test('config merges and passes to engines; listen mode is sticky', async () => {
  const seen = []
  const engines = { tts: async (text, cfg) => { seen.push({ ...cfg }); return Buffer.from(text) }, stt: async () => '' }
  const audio = fakeAudio()
  const { call, register } = await start({ engines, audio })
  const { sessionId } = await register('api')
  await call('POST', '/config', { apiKey: 'k1', voiceId: 'v1', listenMode: 'always' })
  await call('POST', '/config', { apiKey: '', ttsModel: 'm2' })
  assert.equal((await call('GET', '/board')).json.mode, 'always')
  assert.deepEqual((await call('POST', '/listen', { mode: 'off' })).json, { mode: 'off' })
  await call('POST', '/config', { listenMode: 'wake' })
  assert.equal((await call('GET', '/board')).json.mode, 'off')
  assert.equal((await call('POST', '/listen', { mode: 'loud' })).status, 400)
  await call('POST', '/speak', { sessionId, text: 'x', priority: 'status' })
  await waitFor(() => audio.played.length === 1)
  assert.equal(seen[0].apiKey, 'k1')
  assert.equal(seen[0].voiceId, 'v1')
  assert.equal(seen[0].ttsModel, 'm2')
  assert.equal(seen[0].sttLanguage, 'en')
})

test('routes by deduped name', async () => {
  const { hub, register, open } = await start()
  const a = await register('api')
  const b = await register('api')
  assert.equal(b.name, 'api-2')
  const s1 = await open(a.sessionId)
  const s2 = await open(b.sessionId)
  await hub.hear('Hey Claude, api-2: hello')
  assert.deepEqual(await s2.line(1), { type: 'heard', text: 'hello' })
  await hub.hear('Hey Claude, api: ping')
  assert.deepEqual(await s1.line(1), { type: 'heard', text: 'ping' })
  assert.equal(s2.lines.length, 2)
})

test('routes to last active without a name', async () => {
  const { hub, call, register, open } = await start()
  const a = await register('api')
  const b = await register('web')
  const s1 = await open(a.sessionId)
  await open(b.sessionId)
  await call('POST', `/sessions/${a.sessionId}/active`)
  await hub.hear('hey claude go')
  assert.deepEqual(await s1.line(1), { type: 'heard', text: 'go' })
})

test('bare wake word arms the next utterance', async () => {
  const { hub, register, open } = await start()
  const a = await register('api')
  const s = await open(a.sessionId)
  await hub.hear('hey claude')
  await hub.hear('do the thing')
  assert.deepEqual(await s.line(1), { type: 'heard', text: 'do the thing' })
  await hub.hear('not for you')
  await tick()
  assert.equal(s.lines.length, 2)
})

test('stop flushes non-questions and aborts playback', async () => {
  const g = gate()
  const audio = fakeAudio(g)
  const { call, register } = await start({ audio })
  const { sessionId } = await register('api')
  await call('POST', '/speak', { sessionId, text: 'a', priority: 'status' })
  await waitFor(() => audio.signals.length === 1)
  await call('POST', '/speak', { sessionId, text: 'b', priority: 'status' })
  await call('POST', '/speak', { sessionId, text: 'c', priority: 'heads-up' })
  await call('POST', '/speak', { sessionId, text: 'd', priority: 'question' })
  assert.deepEqual((await call('POST', '/stop')).json, { flushed: 2 })
  assert.equal(audio.signals[0].aborted, true)
  g.open()
  await waitFor(() => audio.played.length === 2)
  assert.deepEqual(audio.played, ['a', 'd'])
})

test('voice stop works like POST /stop', async () => {
  const g = gate()
  const audio = fakeAudio(g)
  const { hub, call, register } = await start({ audio })
  const { sessionId } = await register('api')
  await call('POST', '/speak', { sessionId, text: 'a', priority: 'status' })
  await waitFor(() => audio.signals.length === 1)
  await hub.hear('hey claude stop')
  assert.equal(audio.signals[0].aborted, true)
})

test('isPlaying and mutedUntil track playback', async () => {
  let t = 1000
  const g = gate()
  const audio = fakeAudio(g)
  const { hub, call, register } = await start({ audio, now: () => t })
  const { sessionId } = await register('api')
  assert.equal(hub.isPlaying(), false)
  await call('POST', '/speak', { sessionId, text: 'a', priority: 'status' })
  await waitFor(() => audio.signals.length === 1)
  assert.equal(hub.isPlaying(), true)
  t = 5000
  g.open()
  await waitFor(() => !hub.isPlaying())
  assert.equal(hub.mutedUntil(), 5400)
})

test('tts errors are reported to streams', async () => {
  const engines = { tts: async () => { throw new EngineError('auth', 'bad key') }, stt: async () => '' }
  const { call, register, open } = await start({ engines })
  const { sessionId } = await register('api')
  const s = await open(sessionId)
  await call('POST', '/speak', { sessionId, text: 'x', priority: 'status' })
  assert.deepEqual(await s.line(1), { type: 'error', message: 'bad key' })
})

test('rate-limits identical errors', async () => {
  let t = 0
  const { hub, register, open } = await start({ now: () => t })
  const s1 = await open((await register('api')).sessionId)
  const s2 = await open((await register('web')).sessionId)
  const err = new EngineError('permission', 'X')
  hub.reportError(err)
  t = 59_999
  hub.reportError(err)
  hub.reportError(new EngineError('other', 'Y'))
  for (const s of [s1, s2]) {
    assert.deepEqual(await s.line(2), { type: 'error', message: 'Y' })
    assert.deepEqual(s.lines.slice(1), [{ type: 'error', message: 'X' }, { type: 'error', message: 'Y' }])
  }
  t = 60_000
  hub.reportError(err)
  assert.deepEqual(await s1.line(3), { type: 'error', message: 'X' })
})

test('newest stream for a session replaces the older one', async () => {
  const { hub, call, register, open } = await start()
  const { sessionId } = await register('api')
  const old = await open(sessionId)
  const fresh = await open(sessionId)
  await tick()
  assert.equal((await call('GET', '/health')).json.sessions, 1)
  await hub.hear('hey claude hi')
  assert.deepEqual(await fresh.line(1), { type: 'heard', text: 'hi' })
  assert.equal(old.lines.length, 1)
})

test('idle exit after last stream closes', async () => {
  let exits = 0
  const { register, open } = await start({ idleExitMs: 50, onIdleExit: () => { exits++ } })
  const s = await open((await register('api')).sessionId)
  s.abort()
  await tick(200)
  assert.equal(exits, 1)
})

test('opening a stream before idle exit fires cancels it', async () => {
  let exits = 0
  const { register, open } = await start({ idleExitMs: 50, onIdleExit: () => { exits++ } })
  const s = await open((await register('api')).sessionId)
  s.abort()
  await tick(5)
  await open((await register('api')).sessionId)
  await tick(150)
  assert.equal(exits, 0)
})

test('events without token is rejected', async () => {
  const { base, register } = await start()
  const { sessionId } = await register('api')
  const res = await fetch(`${base}/events?session=${sessionId}`)
  assert.equal(res.status, 401)
  await res.body?.cancel()
})

test('aborted playback does not record lastLine', async () => {
  const g = gate()
  const audio = fakeAudio(g)
  const { call, register } = await start({ audio })
  const { sessionId } = await register('api')
  await call('POST', '/speak', { sessionId, text: 'cut off', priority: 'status' })
  await waitFor(() => audio.signals.length === 1)
  await call('POST', '/stop')
  await waitFor(() => audio.active === 0)
  await tick()
  const row = (await call('GET', '/board')).json.sessions.find(r => r.sessionId === sessionId)
  assert.equal(row.lastLine, '')
})

test('a session that never opens its stream is removed after the grace period', async () => {
  let exits = 0
  const { call, register, open } = await start({ streamGraceMs: 50, idleExitMs: 50, onIdleExit: () => { exits++ } })
  const kept = await register('api')
  await open(kept.sessionId)
  await register('ghost')
  assert.equal((await call('GET', '/health')).json.sessions, 2)
  await tick(150)
  const board = (await call('GET', '/board')).json
  assert.deepEqual(board.sessions.map(r => r.name), ['api'])
  assert.equal(exits, 0)
})

test('lone stale session removal starts the idle timer', async () => {
  let exits = 0
  const { call, register } = await start({ streamGraceMs: 30, idleExitMs: 30, onIdleExit: () => { exits++ } })
  await register('ghost')
  await tick(200)
  assert.equal((await call('GET', '/health')).json.sessions, 0)
  assert.equal(exits, 1)
})

test('malformed percent-encoding in a session id is a 400', async () => {
  const { call } = await start()
  assert.equal((await call('POST', '/sessions/%E0%A4%A/active')).status, 400)
  assert.equal((await call('DELETE', '/sessions/%ZZ')).status, 400)
})

test('onConfigChange fires after /config and /listen with the new config', async () => {
  const { hub, call } = await start()
  const seen = []
  hub.onConfigChange(c => seen.push({ apiKey: c.apiKey, listenMode: c.listenMode }))
  await call('POST', '/config', { apiKey: 'k9' })
  await call('POST', '/listen', { mode: 'off' })
  assert.deepEqual(seen, [{ apiKey: 'k9', listenMode: 'wake' }, { apiKey: 'k9', listenMode: 'off' }])
})

test('open event streams get a keepalive ping', async () => {
  const { register, open } = await start({ pingMs: 20 })
  const s = await open((await register('api')).sessionId)
  await waitFor(() => s.raw.some(m => m.type === 'ping'))
  assert.deepEqual(s.raw.find(m => m.type === 'ping'), { type: 'ping' })
})

test('speaking to a session by name makes it the default target', async () => {
  let t = 1000
  const { hub, register, open } = await start({ now: () => t })
  const front = await register('frontend')
  t = 2000
  const api = await register('api')
  const sFront = await open(front.sessionId)
  const sApi = await open(api.sessionId)
  t = 3000
  await hub.hear('hey claude, frontend: x')
  t = 4000
  await hub.hear('hey claude y')
  await waitFor(() => sFront.lines.length + sApi.lines.length >= 4)
  assert.deepEqual(sFront.lines.slice(1), [{ type: 'heard', text: 'x' }, { type: 'heard', text: 'y' }])
  assert.equal(sApi.lines.length, 1)
})

test('a newly opened stream gets the current mic state right after hello', async () => {
  const { hub, register, open } = await start()
  const first = await open((await register('api')).sessionId)
  assert.deepEqual(await first.rawLine(1), { type: 'mic', state: 'off' })
  hub.broadcast({ type: 'mic', state: 'listening' })
  const late = await open((await register('web')).sessionId)
  assert.equal(late.raw[0].type, 'hello')
  assert.deepEqual(await late.rawLine(1), { type: 'mic', state: 'listening' })
})

// --- Coordinator (Plan 2) ---

async function withCoordinator(opts) {
  const h = await start(opts)
  const coord = await h.register('boss')
  const worker = await h.register('api')
  const cs = await h.open(coord.sessionId)
  const ws = await h.open(worker.sessionId)
  const r = await h.call('POST', `/sessions/${coord.sessionId}/role`, { role: 'coordinator' })
  assert.deepEqual(r, { status: 200, json: { role: 'coordinator', name: 'boss' } })
  return { ...h, coord, worker, cs, ws }
}

test('coordinator: only one per machine; a second is refused unless it takes over', async () => {
  const { call, register, open, coord, cs } = await withCoordinator()
  const other = await register('ops')
  await open(other.sessionId)
  const refused = await call('POST', `/sessions/${other.sessionId}/role`, { role: 'coordinator' })
  assert.equal(refused.status, 409)
  assert.match(refused.json.error, /boss is already the coordinator/)
  const took = await call('POST', `/sessions/${other.sessionId}/role`, { role: 'coordinator', takeover: true })
  assert.equal(took.status, 200)
  assert.deepEqual(await cs.line(1), { type: 'role', role: 'worker', reason: 'ops took over as coordinator' })
  const board = (await call('GET', '/board')).json
  assert.equal(board.coordinator, 'ops')
  assert.equal(board.sessions.find(r => r.sessionId === coord.sessionId).role, 'worker')
  assert.equal((await call('POST', `/sessions/${other.sessionId}/role`, { role: 'boss' })).status, 400)
})

test('coordinator: hears every transcript, with the addressed name as a hint', async () => {
  const { hub, cs, ws } = await withCoordinator()
  await hub.hear('Hey Claude, api: run the tests')
  assert.deepEqual(await cs.line(1), { type: 'heard', text: 'run the tests', addressed: 'api' })
  await hub.hear('Hey Claude, where are we?')
  assert.deepEqual(await cs.line(2), { type: 'heard', text: 'where are we?' })
  assert.equal(ws.lines.length, 1) // hello only
})

test('coordinator: worker speech becomes a report, not audio; questions stay open', async () => {
  const audio = fakeAudio()
  const { call, cs, worker } = await withCoordinator({ audio })
  const r = await call('POST', '/speak', { sessionId: worker.sessionId, text: 'Should I **drop** the table?', priority: 'question' })
  assert.deepEqual(r.json, { queued: true, spoken: 'Should I drop the table?', relayed: true })
  assert.deepEqual(await cs.line(1), { type: 'report', from: 'api', priority: 'question', text: 'Should I drop the table?' })
  await tick()
  assert.deepEqual(audio.played, [])
  let row = (await call('GET', '/board')).json.sessions.find(s => s.name === 'api')
  assert.equal(row.openQuestion, 'Should I drop the table?')
  assert.equal(row.lastLine, 'Should I drop the table?')
  // A later non-question update from the worker means it moved on.
  await call('POST', '/speak', { sessionId: worker.sessionId, text: 'Done.', priority: 'status' })
  row = (await call('GET', '/board')).json.sessions.find(s => s.name === 'api')
  assert.equal(row.openQuestion, '')
})

test('coordinator: its own speech plays without a name prefix', async () => {
  const audio = fakeAudio()
  const { call, coord } = await withCoordinator({ audio })
  await call('POST', '/speak', { sessionId: coord.sessionId, text: 'API finished.' })
  await waitFor(() => audio.played.length === 1)
  assert.deepEqual(audio.played, ['API finished.'])
})

test('coordinator: resolve clears an open question and decisions are logged; workers may not', async () => {
  const { call, coord, worker } = await withCoordinator()
  await call('POST', '/speak', { sessionId: worker.sessionId, text: 'Which port?', priority: 'question' })
  assert.deepEqual((await call('POST', '/board/resolve', { sessionId: coord.sessionId, name: 'api' })).json, { resolved: 'api' })
  assert.equal((await call('POST', '/board/resolve', { sessionId: coord.sessionId, name: 'nope' })).status, 404)
  assert.deepEqual((await call('POST', '/board/decision', { sessionId: coord.sessionId, text: 'Told api to use port 8080.' })).json, { logged: true })
  assert.equal((await call('POST', '/board/decision', { sessionId: worker.sessionId, text: 'x' })).status, 403)
  const board = (await call('GET', '/board')).json
  assert.equal(board.sessions.find(s => s.name === 'api').openQuestion, '')
  assert.deepEqual(board.decisions.map(d => d.text), ['Told api to use port 8080.'])
})

test('coordinator gone: workers play and hear directly again', async () => {
  const audio = fakeAudio()
  const { hub, call, cs, ws, worker } = await withCoordinator({ audio })
  cs.abort()
  await tick(50)
  assert.equal((await call('GET', '/board')).json.coordinator, null)
  await call('POST', '/speak', { sessionId: worker.sessionId, text: 'Back on my own.' })
  await waitFor(() => audio.played.length === 1)
  assert.deepEqual(audio.played, ['Back on my own.'])
  await hub.hear('Hey Claude, hello')
  assert.deepEqual(await ws.line(1), { type: 'heard', text: 'hello' })
})

test('a coordinator without an open stream does not swallow speech', async () => {
  const audio = fakeAudio()
  const { call, register, open } = await start({ audio })
  const c = await register('boss')
  const w = await register('api')
  await open(w.sessionId)
  await call('POST', `/sessions/${c.sessionId}/role`, { role: 'coordinator' })
  await call('POST', '/speak', { sessionId: w.sessionId, text: 'Plays anyway.' })
  await waitFor(() => audio.played.length === 1)
  assert.deepEqual(audio.played, ['api: Plays anyway.'])
})

test('config: engine settings merge; an unknown engine name is ignored', async () => {
  const { hub, call } = await start()
  assert.equal(hub.getConfig().ttsEngine, 'elevenlabs')
  await call('POST', '/config', { ttsEngine: 'local', sttEngine: 'whisperish', sttCommand: 'whisper-cli -f {in}', localTtsVoice: 'bf_emma' })
  const c = hub.getConfig()
  assert.equal(c.ttsEngine, 'local')
  assert.equal(c.sttEngine, 'elevenlabs')
  assert.equal(c.sttCommand, 'whisper-cli -f {in}')
  assert.equal(c.localTtsVoice, 'bf_emma')
})

test('debug hear is a 404 unless enabled, then routes like a transcript', async () => {
  const off = await start()
  assert.equal((await off.call('POST', '/debug/hear', { text: 'hey claude hi' })).status, 404)
  const { call, register, open } = await start({ debugHear: true })
  const a = await register('api')
  const s = await open(a.sessionId)
  assert.equal((await call('POST', '/debug/hear', { text: 'Hey Claude, run it' })).status, 200)
  assert.deepEqual(await s.line(1), { type: 'heard', text: 'run it' })
})
