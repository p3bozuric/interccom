import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createVad } from '../../hub/vad.mjs'
import { startListener, createListenerManager } from '../../hub/listener.mjs'

const N = 480
function tone(amplitude) {
  const b = Buffer.alloc(N * 2)
  for (let i = 0; i < N; i++) b.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2)
  return b
}
const silence = () => Buffer.alloc(N * 2)
const utteranceFrames = () => [
  ...Array.from({ length: 20 }, silence),
  ...Array.from({ length: 30 }, () => tone(8000)),
  ...Array.from({ length: 60 }, silence),
]

function fakeSpawner() {
  const s = { calls: [], children: [] }
  s.spawn = (cmd, args, opts) => {
    const c = new EventEmitter()
    c.stdout = new PassThrough()
    c.stderr = new PassThrough()
    c.killed = false
    c.kill = () => { c.killed = true }
    s.calls.push({ cmd, args, opts })
    s.children.push(c)
    return c
  }
  return s
}

const FRAME = 960
const flush = () => new Promise(r => setImmediate(r))

function setup(extra = {}) {
  const sp = fakeSpawner()
  const utterances = []
  const errors = []
  const l = startListener({
    mic: 'Mic', spawn: sp.spawn, vad: createVad(),
    isMuted: () => false,
    onUtterance: pcm => utterances.push(pcm),
    onError: m => errors.push(m),
    ...extra,
  })
  return { sp, l, utterances, errors }
}

test('spawns ffmpeg capture with a safe cwd and hidden window', () => {
  const { sp, l } = setup()
  assert.equal(sp.calls[0].cmd, 'ffmpeg')
  assert.equal(sp.calls[0].args.at(-1), '-')
  assert.equal(sp.calls[0].opts.windowsHide, true)
  assert.equal(sp.calls[0].opts.cwd, process.cwd())
  l.stop()
})

test('says when audio first arrives, and when a voice starts and stops, before the utterance is handed over', async () => {
  const events = []
  const { sp, l } = setup({
    onLive: () => events.push('live'),
    onSpeaking: on => events.push(on ? 'speaking' : 'quiet'),
    onUtterance: () => events.push('utterance'),
  })
  for (const f of utteranceFrames()) sp.children[0].stdout.write(f)
  await flush()
  assert.deepEqual(events, ['live', 'speaking', 'utterance', 'quiet'])
  l.stop()
})

test('emits utterance from VAD, even when chunks do not align with frames', async () => {
  const { sp, l, utterances } = setup()
  const all = Buffer.concat(utteranceFrames())
  for (let i = 0; i < all.length; i += 1000) sp.children[0].stdout.write(all.subarray(i, i + 1000))
  await flush()
  assert.equal(utterances.length, 1)
  l.stop()
})

test('drops audio while muted and resets the VAD once on entering mute', async () => {
  let resets = 0
  const vad = createVad()
  const reset = vad.reset
  vad.reset = () => { resets++; reset() }
  const { sp, l, utterances } = setup({ vad, isMuted: () => true })
  for (const f of utteranceFrames()) sp.children[0].stdout.write(f)
  await flush()
  assert.equal(utterances.length, 0)
  assert.equal(resets, 1)
  l.stop()
})

test('unmuting resumes listening and a new mute resets again', async () => {
  let muted = true
  let resets = 0
  const vad = createVad()
  const reset = vad.reset
  vad.reset = () => { resets++; reset() }
  const { sp, l, utterances } = setup({ vad, isMuted: () => muted })
  sp.children[0].stdout.write(silence())
  await flush()
  muted = false
  for (const f of utteranceFrames()) sp.children[0].stdout.write(f)
  await flush()
  assert.equal(utterances.length, 1)
  muted = true
  sp.children[0].stdout.write(silence())
  await flush()
  assert.equal(resets, 2)
  l.stop()
})

test('pushes copies, not views of the capture buffer', async () => {
  const pushed = []
  const vad = { push: f => { pushed.push(f); return null }, reset() {} }
  const { sp, l } = setup({ vad })
  const chunk = Buffer.alloc(FRAME * 2, 7)
  sp.children[0].stdout.write(chunk)
  await flush()
  chunk.fill(0) // the capture buffer gets reused
  assert.equal(pushed.length, 2)
  for (const f of pushed) {
    assert.equal(f.length, 960)
    assert.ok(f.every(byte => byte === 7))
  }
  l.stop()
})

test('restarts ffmpeg with backoff after exit', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sp, l, errors } = setup()
  sp.children[0].emit('close', 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /mic/i)
  t.mock.timers.tick(1999)
  assert.equal(sp.calls.length, 1)
  t.mock.timers.tick(1)
  assert.equal(sp.calls.length, 2)
  // a second failure backs off further
  sp.children[1].emit('close', 1)
  t.mock.timers.tick(2000)
  assert.equal(sp.calls.length, 2)
  t.mock.timers.tick(2000)
  assert.equal(sp.calls.length, 3)
  l.stop()
})

test('backoff is capped at the maximum', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sp, l } = setup()
  for (let i = 0; i < 8; i++) {
    sp.children.at(-1).emit('close', 1)
    t.mock.timers.tick(30000)
  }
  const before = sp.calls.length
  sp.children.at(-1).emit('close', 1)
  t.mock.timers.tick(29999)
  assert.equal(sp.calls.length, before)
  t.mock.timers.tick(1)
  assert.equal(sp.calls.length, before + 1)
  l.stop()
})

test('a spawn error restarts once, not twice', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sp, l, errors } = setup()
  const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })
  sp.children[0].emit('error', err)
  sp.children[0].emit('close', null)
  assert.match(errors[0], /ffmpeg/i)
  t.mock.timers.tick(2000)
  assert.equal(sp.calls.length, 2)
  l.stop()
})

test('stop kills the child and does not restart', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sp, l, errors } = setup()
  l.stop()
  assert.equal(sp.children[0].killed, true)
  sp.children[0].emit('close', 1)
  t.mock.timers.tick(60000)
  assert.equal(sp.calls.length, 1)
  assert.equal(errors.length, 0)
})

test('stop cancels a pending restart', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { sp, l } = setup()
  sp.children[0].emit('close', 1)
  l.stop()
  t.mock.timers.tick(60000)
  assert.equal(sp.calls.length, 1)
})

// ---- manager ----

function fakeHub(cfg) {
  const h = {
    cfg: { apiKey: 'k', listenMode: 'wake', sttModel: 'scribe_v1', sttLanguage: 'en', ...cfg },
    heard: [], errors: [], broadcasts: [], listeners: [],
  }
  h.getConfig = () => ({ ...h.cfg })
  h.hear = async t => { h.heard.push(t) }
  h.reportError = e => { h.errors.push(String(e?.message ?? e)) }
  h.broadcast = o => { h.broadcasts.push(o) }
  h.isPlaying = () => false
  h.mutedUntil = () => 0
  h.onConfigChange = cb => { h.listeners.push(cb) }
  h.change = patch => { Object.assign(h.cfg, patch); for (const cb of h.listeners) cb(h.getConfig()) }
  return h
}

const noVad = () => ({ push: () => null, reset() {} })

function managerSetup({ cfg, mics = ['Mic A', 'Mic B'], env = {}, text = 'hello there', sttImpl } = {}) {
  const hub = fakeHub(cfg)
  const started = []
  const stopped = []
  const sttCalls = []
  const m = createListenerManager({
    hub, env,
    listMics: () => mics,
    startListener: o => { started.push(o); return { stop: () => stopped.push(o.mic) } },
    stt: sttImpl || (async (wav, c) => { sttCalls.push({ wav, c }); return text }),
    pcmToWav: pcm => Buffer.concat([Buffer.from('WAV'), pcm]),
    createVad: noVad,
  })
  return { hub, m, started, stopped, sttCalls }
}

test('manager starts on the first mic when mode is on and a key exists', () => {
  const { hub, m, started } = managerSetup()
  m.sync()
  assert.equal(started.length, 1)
  assert.equal(started[0].mic, 'Mic A')
  assert.deepEqual(hub.broadcasts, [], 'not listening until audio arrives')
  started[0].onLive()
  assert.deepEqual(hub.broadcasts, [{ type: 'mic', state: 'listening', name: 'Mic A' }])
  started[0].onError('Microphone capture stopped')
  assert.deepEqual(hub.broadcasts.at(-1), { type: 'mic', state: 'off' })
  m.sync()
  assert.equal(started.length, 1)
})

test('INTERCCOM_MIC overrides the first mic', () => {
  const { m, started } = managerSetup({ env: { INTERCCOM_MIC: 'Mic B' } })
  m.sync()
  assert.equal(started[0].mic, 'Mic B')
})

test('manager does not start without a key or when mode is off', () => {
  for (const cfg of [{ apiKey: '' }, { listenMode: 'off' }]) {
    const { m, started, hub } = managerSetup({ cfg })
    m.sync()
    assert.equal(started.length, 0)
    assert.deepEqual(hub.broadcasts, [])
  }
})

test('no mic reports the guidance error', () => {
  const { hub, m, started } = managerSetup({ mics: [] })
  m.sync()
  assert.equal(started.length, 0)
  assert.deepEqual(hub.errors, ['No microphone found. Plug one in, or set INTERCCOM_MIC to its name.'])
})

test('config changes start and stop the listener', () => {
  const { hub, m, started, stopped } = managerSetup({ cfg: { listenMode: 'off' } })
  m.start()
  assert.equal(started.length, 0)
  hub.change({ listenMode: 'always' })
  assert.equal(started.length, 1)
  hub.change({ listenMode: 'off' })
  assert.deepEqual(stopped, ['Mic A'])
  assert.deepEqual(hub.broadcasts.at(-1), { type: 'mic', state: 'off', reason: 'paused' })
  hub.change({ listenMode: 'wake' })
  assert.equal(started.length, 2)
})

test('muted = playing or before mutedUntil', () => {
  const { hub, m, started } = managerSetup()
  m.sync()
  const isMuted = started[0].isMuted
  assert.equal(isMuted(), false)
  hub.mutedUntil = () => Date.now() + 10_000
  assert.equal(isMuted(), true)
  hub.mutedUntil = () => 0
  hub.isPlaying = () => true
  assert.equal(isMuted(), true)
})

test('utterance goes through STT with hub config, then hub.hear', async () => {
  const { hub, m, started, sttCalls } = managerSetup()
  m.sync()
  started[0].onUtterance(Buffer.from('pcm'))
  await flush()
  assert.equal(sttCalls.length, 1)
  assert.equal(sttCalls[0].wav.toString(), 'WAVpcm')
  assert.deepEqual(sttCalls[0].c, hub.getConfig())
  assert.deepEqual(hub.heard, ['hello there'])
})

test('empty transcripts are ignored', async () => {
  const { hub, m, started } = managerSetup({ text: '   ' })
  m.sync()
  started[0].onUtterance(Buffer.from('x'))
  await flush()
  assert.deepEqual(hub.heard, [])
  assert.deepEqual(hub.errors, [])
})

test('STT errors go to hub.reportError', async () => {
  const { hub, m, started } = managerSetup({ sttImpl: async () => { throw new Error('stt down') } })
  m.sync()
  started[0].onUtterance(Buffer.from('x'))
  await flush()
  assert.deepEqual(hub.errors, ['stt down'])
  assert.deepEqual(hub.heard, [])
})

test('listener errors go to hub.reportError', () => {
  const { hub, m, started } = managerSetup()
  m.sync()
  started[0].onError('Microphone stopped')
  assert.deepEqual(hub.errors, ['Microphone stopped'])
})

test('stop() on the manager stops a running listener', () => {
  const { m, stopped } = managerSetup()
  m.sync()
  m.stop()
  assert.deepEqual(stopped, ['Mic A'])
})

// ---- fix round 1 ----

function deferredStt() {
  const calls = []
  const stt = (wav) => new Promise((resolve, reject) => { calls.push({ wav: wav.toString(), resolve, reject }) })
  return { calls, stt }
}

test('transcripts reach hub.hear in utterance order even if STT resolves out of order', async () => {
  const d = deferredStt()
  const { hub, m, started } = managerSetup({ sttImpl: d.stt })
  m.sync()
  started[0].onUtterance(Buffer.from('1'))
  started[0].onUtterance(Buffer.from('2'))
  assert.equal(d.calls.length, 2) // both requests start immediately
  d.calls[1].resolve('second')
  await flush()
  assert.deepEqual(hub.heard, [])
  d.calls[0].resolve('first')
  await flush()
  assert.deepEqual(hub.heard, ['first', 'second'])
})

test('a failed earlier transcript does not block later ones', async () => {
  const d = deferredStt()
  const { hub, m, started } = managerSetup({ sttImpl: d.stt })
  m.sync()
  started[0].onUtterance(Buffer.from('1'))
  started[0].onUtterance(Buffer.from('2'))
  d.calls[1].resolve('second')
  d.calls[0].reject(new Error('boom'))
  await flush()
  assert.deepEqual(hub.errors, ['boom'])
  assert.deepEqual(hub.heard, ['second'])
})

test('at most 3 utterances in flight; the 4th is dropped with one error', async () => {
  const d = deferredStt()
  const { hub, m, started } = managerSetup({ sttImpl: d.stt })
  m.sync()
  for (let i = 0; i < 4; i++) started[0].onUtterance(Buffer.from(String(i)))
  assert.equal(d.calls.length, 3)
  assert.deepEqual(hub.errors, ['Speech is arriving faster than it can be transcribed; dropped some audio.'])
  for (const c of d.calls) c.resolve('x')
  await flush()
  assert.equal(hub.heard.length, 3)
  started[0].onUtterance(Buffer.from('again')) // capacity is free again
  assert.equal(d.calls.length, 4)
})

test('in-flight transcripts are discarded after mode off or manager stop', async () => {
  const d = deferredStt()
  const { hub, m, started } = managerSetup({ sttImpl: d.stt })
  m.start()
  started[0].onUtterance(Buffer.from('1'))
  hub.change({ listenMode: 'off' })
  d.calls[0].resolve('late')
  await flush()
  assert.deepEqual(hub.heard, [])

  const e = deferredStt()
  const s2 = managerSetup({ sttImpl: e.stt })
  s2.m.sync()
  s2.started[0].onUtterance(Buffer.from('1'))
  s2.m.stop()
  e.calls[0].resolve('late')
  await flush()
  assert.deepEqual(s2.hub.heard, [])
})

test('after manager stop, a late config change does not start the listener', () => {
  const { hub, m, started } = managerSetup({ cfg: { listenMode: 'off' } })
  m.start()
  m.stop()
  hub.change({ listenMode: 'always' })
  assert.equal(started.length, 0)
})

test('"no mic found" is cached for 30 s: no re-probe, no repeated error', t => {
  t.mock.timers.enable({ apis: ['Date'] })
  let probes = 0
  const hub = fakeHub()
  const m = createListenerManager({
    hub, env: {}, listMics: () => { probes++; return [] }, startListener: () => ({ stop() {} }),
    stt: async () => '', pcmToWav: p => p, createVad: noVad,
  })
  m.sync(); m.sync(); m.sync()
  assert.equal(probes, 1)
  assert.equal(hub.errors.length, 1)
  t.mock.timers.tick(29_999)
  m.sync()
  assert.equal(probes, 1)
  t.mock.timers.tick(1)
  m.sync()
  assert.equal(probes, 2)
  assert.equal(hub.errors.length, 2)
})

test('backoff resets only after 5 s of continuous audio, not on any data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { sp, l } = setup()
  // brief burst of data then death: backoff keeps growing
  sp.children[0].stdout.write(silence())
  await flush()
  sp.children[0].emit('close', 1) // delay 2000 used, next 4000
  t.mock.timers.tick(2000)
  assert.equal(sp.calls.length, 2)
  sp.children[1].stdout.write(silence())
  await flush()
  sp.children[1].emit('close', 1) // delay 4000 used, next 8000
  t.mock.timers.tick(3999)
  assert.equal(sp.calls.length, 2)
  t.mock.timers.tick(1)
  assert.equal(sp.calls.length, 3)
  // healthy for 5 s: backoff resets
  sp.children[2].stdout.write(silence())
  await flush()
  t.mock.timers.tick(5000)
  sp.children[2].stdout.write(silence())
  await flush()
  sp.children[2].emit('close', 1)
  t.mock.timers.tick(2000)
  assert.equal(sp.calls.length, 4)
  l.stop()
})
