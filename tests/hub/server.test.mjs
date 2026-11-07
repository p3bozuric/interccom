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
    // raw: every line. lines: without keepalive, mic-state and cue lines, so tests can count events.
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
              if (msg.type !== 'ping' && msg.type !== 'mic' && msg.type !== 'cue') s.lines.push(msg)
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

const cues = s => s.raw.filter(m => m.type === 'cue')

test('chimes: one when "Hey Claude" is caught, one when your words reach a session; none for unaddressed speech', async () => {
  const audio = fakeAudio()
  audio.chimes = []
  audio.chime = name => audio.chimes.push(name)
  const { hub, register, open } = await start({ audio })
  const s = await open((await register('session 3')).sessionId)
  await hub.hear('just people talking')
  assert.deepEqual(audio.chimes, [])
  await hub.hear('hey claude')
  assert.deepEqual(audio.chimes, ['armed'])
  await hub.hear('session three, do the thing')
  assert.deepEqual(audio.chimes, ['armed', 'sent'])
  assert.deepEqual(await s.line(1), { type: 'heard', text: 'do the thing' })
  assert.deepEqual(audio.played, [], 'chimes never go through the talk queue')
})

test('the cue every session sees: listening while you speak or after "Hey Claude", processing while transcribing, talking, waiting', async () => {
  const g = gate()
  const audio = fakeAudio(g)
  const { hub, call, register, open } = await start({ audio })
  const { sessionId } = await register('api')
  const s = await open(sessionId)
  const other = await open((await register('web')).sessionId)
  const states = () => cues(s).map(c => c.state)
  // The listener's order: speech starts, the utterance ends and goes to STT, then the voice stops.
  hub.speaking(true)
  hub.transcribing(1)
  hub.speaking(false)
  hub.speaking(true) // talking again while the last bit is still being transcribed
  hub.transcribing(1)
  hub.speaking(false)
  hub.transcribing(-1)
  hub.transcribing(-1)
  await waitFor(() => states().length === 5)
  assert.deepEqual(states(), ['listening', 'processing', 'listening', 'processing', 'waiting'])
  await hub.hear('hey claude')
  await waitFor(() => states().length === 6)
  assert.equal(states()[5], 'listening')
  await hub.hear('do it')
  await waitFor(() => states().length === 7)
  assert.equal(states()[6], 'waiting')
  await call('POST', '/speak', { sessionId, text: 'hello', priority: 'status' })
  await waitFor(() => states().length === 8)
  assert.equal(states()[7], 'talking')
  g.open()
  await waitFor(() => states().length === 9)
  assert.equal(states()[8], 'waiting')
  await waitFor(() => cues(other).length === 9)
  assert.deepEqual(cues(other), cues(s))
})

test('"Hey Claude" alone stays listening only for its window', async () => {
  let t = 1000
  const { hub, register, open } = await start({ now: () => t })
  const s = await open((await register('api')).sessionId)
  await hub.hear('hey claude')
  await waitFor(() => cues(s).length === 1)
  assert.equal(cues(s)[0].state, 'listening')
  t += 20_000
  await waitFor(() => cues(s).length === 2, 12_000)
  assert.equal(cues(s)[1].state, 'waiting')
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
  await call('POST', '/config', { ttsEngine: 'local', sttEngine: 'whisperish', sttCommand: 'whisper-cli -f {in}', voiceId: 'bf_emma', deepgramKey: 'dg' })
  let c = hub.getConfig()
  assert.equal(c.ttsEngine, 'local')
  assert.equal(c.sttEngine, 'elevenlabs')
  assert.equal(c.sttCommand, 'whisper-cli -f {in}')
  assert.equal(c.voiceId, 'bf_emma')
  assert.equal(c.deepgramKey, 'dg')
  // Each direction only takes engines that can do it.
  await call('POST', '/config', { ttsEngine: 'groq', sttEngine: 'cartesia' })
  c = hub.getConfig()
  assert.deepEqual([c.ttsEngine, c.sttEngine], ['local', 'elevenlabs'])
  await call('POST', '/config', { ttsEngine: 'cartesia', sttEngine: 'groq' })
  c = hub.getConfig()
  assert.deepEqual([c.ttsEngine, c.sttEngine], ['cartesia', 'groq'])
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

// --- Other hosts: pull delivery (Codex), MCP-only sessions, coordinator relay ---

async function withCodex(opts = {}) {
  const submitted = []
  const h = await start({ hostSubmit: async s => { submitted.push(s); if (opts.failSubmit) throw new Error('codex not found') }, ...opts })
  const reg = (await h.call('POST', '/sessions', { name: 'cx', cwd: 'C:\\w\\cx', pid: 1, host: 'codex', delivery: 'pull', tag: 'T1' })).json
  const s = await h.open(reg.sessionId)
  const ev = (event, extra = {}) => h.call('POST', '/host/event', { host: 'codex', hostSessionId: 'thread-1', cwd: 'C:/w/cx/', event, ...extra })
  return { ...h, reg, s, ev, submitted }
}

test('codex: the first hook binds by folder, gets guidance with the tag, and the link is told', async () => {
  const { ev, s, call } = await withCodex()
  const r = await ev('session-start')
  assert.match(r.json.context, /^# Voice \(interccom\)/)
  assert.ok(r.json.context.includes('Your session is called cx'))
  assert.ok(r.json.context.includes('[interccom:T1]'))
  assert.deepEqual(await s.line(1), { type: 'bound', hostSessionId: 'thread-1' })
  const row = (await call('GET', '/board')).json.sessions[0]
  assert.equal(row.host, 'codex')
  assert.equal(row.hostSessionId, 'thread-1')
  assert.equal(row.tag, undefined) // never on the board
  assert.equal(row.inbox, undefined)
  // Unknown thread in another folder: nothing to do.
  assert.deepEqual((await call('POST', '/host/event', { host: 'codex', hostSessionId: 'x', cwd: '/elsewhere', event: 'tool' })).json, {})
  assert.equal((await call('POST', '/host/event', { host: 'codex', hostSessionId: 'x', event: 'nope' })).status, 400)
})

test('codex: speech mid-turn rides on the next tool hook; at turn end it blocks the stop', async () => {
  const { hub, ev, submitted } = await withCodex()
  await ev('session-start')
  await ev('prompt')
  await hub.hear('Hey Claude, also run lint')
  assert.deepEqual((await ev('tool')).json, { context: 'Voice note [interccom:T1] — the person said (by voice, while you were working): ["also run lint"]' })
  assert.deepEqual((await ev('tool')).json, {})
  await hub.hear('Hey Claude, and commit')
  assert.deepEqual((await ev('stop')).json, { block: 'Voice note [interccom:T1] — the person said (by voice, while you were working): ["and commit"]' })
  assert.deepEqual((await ev('stop', { stopHookActive: true })).json, {})
  assert.deepEqual(submitted, [])
})

test('codex: speech while idle starts a turn through hostSubmit; a failure keeps it for the next hook', async () => {
  const { hub, ev, submitted, call } = await withCodex()
  await ev('session-start')
  await hub.hear('Hey Claude, what changed?')
  await waitFor(() => submitted.length === 1)
  assert.deepEqual(submitted[0], { host: 'codex', hostSessionId: 'thread-1', cwd: 'C:\\w\\cx', text: 'what changed?' })
  assert.equal((await call('GET', '/board')).json.sessions[0].busy, true)

  const f = await withCodex({ failSubmit: true })
  await f.ev('session-start')
  await f.hub.hear('Hey Claude, hello')
  await waitFor(() => f.s.lines.some(l => l.type === 'error'))
  assert.equal(f.s.lines.find(l => l.type === 'error').message, 'codex not found')
  assert.match((await f.ev('prompt')).json.context, /\["hello"\]$/)
})

test('codex: speech before any hook bound the session waits in the inbox for SessionStart', async () => {
  const { hub, ev, submitted } = await withCodex()
  await hub.hear('Hey Claude, start with the tests')
  const r = (await ev('session-start')).json
  assert.match(r.context, /\["start with the tests"\]$/)
  assert.deepEqual(submitted, [])
})

test('an MCP-only session can speak but is never a default target; addressing it explains why', async () => {
  const { hub, call, register, open } = await start()
  const claude = await register('api')
  const cs = await open(claude.sessionId)
  const mcp = (await call('POST', '/sessions', { name: 'gem', cwd: '/g', host: 'gemini', delivery: 'none' })).json
  const ms = await open(mcp.sessionId)
  await call('POST', `/sessions/${mcp.sessionId}/active`, {})
  await hub.hear('Hey Claude, hello')
  assert.deepEqual(await cs.line(1), { type: 'heard', text: 'hello' })
  await hub.hear('Hey Claude, gem: hi')
  assert.match((await ms.line(1)).message, /gem can't hear voice input/)
  assert.equal((await call('POST', `/sessions/${mcp.sessionId}/role`, { role: 'coordinator' })).status, 400)
})

test('relay: the coordinator passes the person\'s own recent words to a Codex worker, nothing else', async () => {
  const submitted = []
  const { hub, call, register, open } = await start({ hostSubmit: async s => { submitted.push(s) } })
  const coord = await register('boss')
  await open(coord.sessionId)
  await call('POST', `/sessions/${coord.sessionId}/role`, { role: 'coordinator' })
  const cx = (await call('POST', '/sessions', { name: 'cx', cwd: '/w/cx', host: 'codex', delivery: 'pull', tag: 'T', hostSessionId: 'th' })).json
  await open(cx.sessionId)
  await hub.hear('Hey Claude, cx: use port 8080, please!')
  const ok = await call('POST', '/board/relay', { sessionId: coord.sessionId, to: 'cx', quote: 'Use port 8080' })
  assert.deepEqual(ok.json, { relayed: 'cx' })
  await waitFor(() => submitted.length === 1)
  assert.equal(submitted[0].text, 'Use port 8080')
  const made_up = await call('POST', '/board/relay', { sessionId: coord.sessionId, to: 'cx', quote: 'delete the database' })
  assert.equal(made_up.status, 403)
  assert.equal((await call('POST', '/board/relay', { sessionId: coord.sessionId, to: 'cx', quote: 'port 80' })).status, 403) // whole words only
  assert.equal((await call('POST', '/board/relay', { sessionId: cx.sessionId, to: 'boss', quote: 'use port 8080' })).status, 403)
  assert.equal((await call('POST', '/board/relay', { sessionId: coord.sessionId, to: 'nobody', quote: 'x' })).status, 404)
})

test('relay reaches push sessions of other agents (Copilot, OpenCode) over their stream', async () => {
  const { hub, call, register, open } = await start()
  const coord = await register('boss')
  await open(coord.sessionId)
  await call('POST', `/sessions/${coord.sessionId}/role`, { role: 'coordinator' })
  const cp = (await call('POST', '/sessions', { name: 'cp', cwd: '/w/cp', host: 'copilot', delivery: 'push', tag: 'T' })).json
  const cs = await open(cp.sessionId)
  await hub.hear('Hey Claude, cp: rerun the flaky test')
  assert.deepEqual((await call('POST', '/board/relay', { sessionId: coord.sessionId, to: 'cp', quote: 'rerun the flaky test' })).json, { relayed: 'cp' })
  assert.deepEqual(await cs.line(1), { type: 'heard', text: 'rerun the flaky test' })
})

// --- Permission prompts by voice ---

test('approvals: announced by the hub, settled by "approve", and the session sees it on its long-poll', async () => {
  const audio = fakeAudio()
  audio.chimes = []
  audio.chime = n => audio.chimes.push(n)
  const { hub, call, register, open } = await start({ audio })
  const { sessionId } = await register('api')
  const s = await open(sessionId)
  const { json: req } = await call('POST', '/approvals', { sessionId, tool: 'Bash', input: { command: 'npm test' } })
  assert.deepEqual(req, { id: req.id, summary: 'run npm test', destructive: false })
  await waitFor(() => audio.played.length === 1)
  assert.equal(audio.played[0], 'api wants to run npm test. Approve?')
  assert.equal((await call('GET', `/approvals/${req.id}`)).json.status, 'open')
  const waiting = call('GET', `/approvals/${req.id}?wait=5000`)
  await tick()
  await hub.hear('Approve.')
  assert.equal((await waiting).json.status, 'approved')
  assert.equal((await call('GET', `/approvals/${req.id}`)).json.status, 'approved', 'a poll that comes late still gets the answer')
  assert.deepEqual(audio.chimes, ['sent'])
  assert.equal(s.lines.length, 1, 'the answer never reaches the session as speech')
})

test('approvals: the long-poll returns the answer itself', async () => {
  const { hub, call, register } = await start()
  const { sessionId } = await register('api')
  const { json: req } = await call('POST', '/approvals', { sessionId, tool: 'Edit', input: { file_path: '/x/a.mjs' } })
  const waiting = call('GET', `/approvals/${req.id}?wait=5000`)
  await tick()
  await hub.hear('hey claude, deny')
  assert.equal((await waiting).json.status, 'denied')
})

test('approvals: destructive requests are read back and need "confirm"; "yes" is not enough', async () => {
  const audio = fakeAudio()
  const { hub, call, register } = await start({ audio })
  const { sessionId } = await register('api')
  const { json: req } = await call('POST', '/approvals', { sessionId, tool: 'Bash', input: { command: 'git push --force' } })
  assert.equal(req.destructive, true)
  await hub.hear('approve')
  assert.equal((await call('GET', `/approvals/${req.id}`)).json.status, 'confirming')
  await waitFor(() => audio.played.length === 2)
  assert.equal(audio.played[1], 'Confirm: api will run git push --force. Say confirm, or deny.')
  await hub.hear('yes')
  assert.equal((await call('GET', `/approvals/${req.id}`)).json.status, 'confirming')
  await hub.hear('approve') // approving again is not confirming
  assert.equal((await call('GET', `/approvals/${req.id}`)).json.status, 'confirming')
  const waiting = call('GET', `/approvals/${req.id}?wait=5000`)
  await tick()
  await hub.hear('confirm')
  assert.equal((await waiting).json.status, 'approved')
})

test('approvals: named when several are open; ordinary speech still routes; cancelled when the dialog wins', async () => {
  const { hub, call, register, open } = await start()
  const a = await register('api')
  const w = await register('web')
  const sa = await open(a.sessionId)
  await open(w.sessionId)
  await call('POST', `/sessions/${a.sessionId}/active`)
  const ra = (await call('POST', '/approvals', { sessionId: a.sessionId, tool: 'Bash', input: { command: 'npm test' } })).json
  const rw = (await call('POST', '/approvals', { sessionId: w.sessionId, tool: 'Bash', input: { command: 'npm run build' } })).json
  await hub.hear('yes') // two open: a bare yes means nothing, and isn't speech for a session either (no wake word)
  assert.equal((await call('GET', `/approvals/${ra.id}`)).json.status, 'open')
  await hub.hear('hey claude, what is left to do')
  assert.deepEqual(await sa.line(1), { type: 'heard', text: 'what is left to do' })
  const wa = call('GET', `/approvals/${ra.id}?wait=5000`)
  await tick()
  await hub.hear('approve api')
  assert.equal((await wa).json.status, 'approved')
  assert.equal((await call('GET', `/approvals/${rw.id}`)).json.status, 'open')
  await call('DELETE', `/approvals/${rw.id}`)
  assert.equal((await call('GET', `/approvals/${rw.id}`)).json.status, 'gone')
  assert.deepEqual((await call('GET', '/board')).json.approvals, [])
})

test('approvals: the coordinator never gets the answer; a closed session cancels its requests', async () => {
  const { hub, h, cs, ws, worker } = await (async () => {
    const h = await start()
    const coord = await h.register('boss')
    const worker = await h.register('api')
    const cs = await h.open(coord.sessionId)
    const ws = await h.open(worker.sessionId)
    await h.call('POST', `/sessions/${coord.sessionId}/role`, { role: 'coordinator' })
    return { hub: h.hub, h, cs, ws, worker }
  })()
  const r = (await h.call('POST', '/approvals', { sessionId: worker.sessionId, tool: 'Bash', input: { command: 'npm test' } })).json
  const before = cs.lines.length
  const waiting = h.call('GET', `/approvals/${r.id}?wait=5000`)
  await tick()
  await hub.hear('approve')
  assert.equal((await waiting).json.status, 'approved')
  await tick()
  assert.equal(cs.lines.filter(l => l.type === 'heard').length, cs.lines.slice(0, before).filter(l => l.type === 'heard').length)
  const r2 = (await h.call('POST', '/approvals', { sessionId: worker.sessionId, tool: 'Bash', input: { command: 'ls' } })).json
  await h.call('DELETE', `/sessions/${worker.sessionId}`)
  assert.equal((await h.call('GET', `/approvals/${r2.id}`)).json.status, 'cancelled')
  void ws
})

test('the voice level reaches every session only while the person speaks, at most every 120 ms', async () => {
  let t = 1000
  const { hub, register, open } = await start({ now: () => t })
  const s = await open((await register('api')).sessionId)
  const levels = () => s.raw.filter(m => m.type === 'level').map(m => m.v)
  hub.level(0.5)
  hub.speaking(true)
  await waitFor(() => cues(s).some(c => c.speaking === true))
  hub.level(0.3333)
  hub.level(0.9) // within 120 ms of the last: dropped
  t += 150
  hub.level(2) // clamped
  await waitFor(() => levels().length === 2)
  assert.deepEqual(levels(), [0.33, 1])
  hub.speaking(false)
  await waitFor(() => cues(s).at(-1).speaking === false)
  t += 150
  hub.level(0.5)
  await tick()
  assert.equal(levels().length, 2)
})

test('turning interccom off: no speech, no hearing, no voice approvals, mic off; on brings it back', async () => {
  const { hub, call, register, open } = await start()
  const { sessionId } = await register('api')
  const s = await open(sessionId)
  const seen = []
  hub.onConfigChange(c => seen.push(c.listenMode))
  assert.equal((await call('POST', '/power', { on: 'no' })).status, 400)
  assert.deepEqual((await call('POST', '/power', { on: false })).json, { on: false })
  await waitFor(() => s.raw.some(m => m.type === 'power' && m.on === false))
  assert.equal(hub.getConfig().listenMode, 'off')
  assert.deepEqual(seen, ['off'])
  assert.equal((await call('GET', '/board')).json.power, false)
  assert.equal((await call('GET', '/board')).json.mode, 'wake', 'the chosen mode is kept for later')
  assert.deepEqual((await call('POST', '/speak', { sessionId, text: 'hello' })).json, { queued: false, off: true })
  assert.equal((await call('POST', '/approvals', { sessionId, tool: 'Bash', input: { command: 'ls' } })).status, 409)
  await hub.hear('hey claude, api, do it')
  await tick()
  assert.equal(s.lines.filter(m => m.type === 'heard').length, 0)
  // A session that connects while it's off is told so.
  const late = await open((await register('web')).sessionId)
  await waitFor(() => late.raw.some(m => m.type === 'power' && m.on === false))
  await call('POST', '/power', { on: true })
  await waitFor(() => s.raw.some(m => m.type === 'power' && m.on === true))
  assert.equal(hub.getConfig().listenMode, 'wake')
  assert.deepEqual((await call('POST', '/speak', { sessionId, text: 'hello' })).json.queued, true)
})

test('turning interccom off cancels open voice approvals', async () => {
  const { call, register } = await start()
  const { sessionId } = await register('api')
  const { json: req } = await call('POST', '/approvals', { sessionId, tool: 'Bash', input: { command: 'npm test' } })
  await call('POST', '/power', { on: false })
  assert.equal((await call('GET', `/approvals/${req.id}`)).json.status, 'cancelled')
})
