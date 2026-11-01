import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configFromEnv, SETTINGS, envName } from '../../hub/config-env.mjs'
import { setupReport } from '../../hub/setup-report.mjs'
import { validate, saveChoices, keyAdvice, interactive, FLAGS } from '../../hub/setup-cli.mjs'
import { createHub } from '../../hub/server.mjs'
import { hubEnv } from '../../hub/launch.mjs'
import { PROVIDERS } from '../../hub/engines/index.mjs'

const dirs = []
const hubs = []
after(async () => {
  for (const h of hubs) await h.close()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'interccom-setup-')); dirs.push(d); return d }

// ---- settings ----

test('settings: env (plugin) beats config.json beats nothing; old INTERCCOM_VOICE_ID still works', () => {
  const file = { tts_engine: 'deepgram', stt_engine: 'soniox', tts_voice: 'from-file', listen_mode: 'always', muted: true }
  const c = configFromEnv({ INTERCCOM_STT_ENGINE: 'groq', INTERCCOM_NO_KEY_FALLBACK: '1' }, 'linux', { file })
  assert.deepEqual([c.ttsEngine, c.sttEngine, c.voiceId, c.listenMode, c.muted], ['deepgram', 'groq', 'from-file', 'always', true])
  assert.equal(configFromEnv({ INTERCCOM_VOICE_ID: 'old', INTERCCOM_NO_KEY_FALLBACK: '1' }, 'linux', { file: {} }).voiceId, 'old')
  assert.equal(configFromEnv({ INTERCCOM_TTS_VOICE: 'new', INTERCCOM_VOICE_ID: 'old', INTERCCOM_NO_KEY_FALLBACK: '1' }, 'linux', { file: {} }).voiceId, 'new')
  assert.equal(configFromEnv({ INTERCCOM_MUTED: 'false', INTERCCOM_NO_KEY_FALLBACK: '1' }, 'linux', { file }).muted, false)
  for (const s of Object.keys(SETTINGS)) assert.equal(envName(s), `INTERCCOM_${s.toUpperCase()}`)
})

test('keys: plugin setting, then the provider variable, then the Windows registry; never config.json', () => {
  const file = { deepgram_api_key: 'leaked', soniox_api_key: 'leaked' }
  const c = configFromEnv({
    INTERCCOM_API_KEY: 'el-plugin', INTERCCOM_DEEPGRAM_API_KEY: 'dg-plugin', DEEPGRAM_API_KEY: 'dg-env',
    SONIOX_API_KEY: 'sx-env', OPENAI_API_KEY: 'oa-env',
  }, 'linux', { file })
  assert.deepEqual([c.apiKey, c.deepgramKey, c.sonioxKey, c.openaiKey, c.groqKey], ['el-plugin', 'dg-plugin', 'sx-env', 'oa-env', undefined])
  const reg = name => (name === 'GROQ_API_KEY' ? '    GROQ_API_KEY    REG_SZ    gq-reg\n' : '')
  assert.equal(configFromEnv({}, 'win32', { file: {}, readRegistry: reg }).groqKey, 'gq-reg')
  assert.equal(configFromEnv({}, 'linux', { file: {}, readRegistry: reg }).groqKey, undefined)
  assert.equal(configFromEnv({ INTERCCOM_NO_KEY_FALLBACK: '1', DEEPGRAM_API_KEY: 'dg' }, 'linux', { file: {} }).deepgramKey, undefined)
})

test('the hub process never inherits any provider key', () => {
  const env = hubEnv({ PATH: '/bin', ...Object.fromEntries(Object.values(PROVIDERS).filter(p => p.env).flatMap(p => [[p.env, 'k'], [`INTERCCOM_${p.env}`, 'k']])), INTERCCOM_API_KEY: 'k', deepgram_api_key: 'k' })
  assert.deepEqual(Object.keys(env), ['PATH'])
})

// ---- report ----

const BASE = { ttsEngine: 'deepgram', sttEngine: 'soniox', deepgramKey: 'dg', sonioxKey: '', listenMode: 'wake', localTtsUrl: 'u', localSttUrl: 'u' }

test('setup report: each direction, what it uses, and the fix for what is missing', () => {
  const r = setupReport(BASE, {
    ffmpeg: false, ffmpegHint: 'Install FFmpeg (winget install Gyan.FFmpeg).',
    player: { name: 'ffplay', ok: true }, mic: { state: 'off', name: '', error: 'No microphone found.' },
  })
  assert.equal(r.ok, false)
  const lines = r.text.split('\n')
  assert.equal(lines[1], '✓ Talking: Deepgram, model aura-2-thalia-en')
  assert.equal(lines[2], '✗ Listening: Soniox, model stt-async-v5')
  assert.match(lines[3], /→ No Soniox API key\. Set soniox_api_key .* SONIOX_API_KEY\. Get one at console\.soniox\.com\./)
  assert.ok(r.text.includes('✗ ffmpeg (microphone capture)\n    → Install FFmpeg (winget install Gyan.FFmpeg).'))
  assert.ok(r.text.includes('✓ ffplay (playback)'))
  assert.ok(r.text.includes('✗ Microphone: not listening (mode wake: start with "Hey Claude")\n    → No microphone found.'))
  assert.equal(r.problems.length, 3)
  assert.match(lines.at(-1), /\/plugin → interccom → configure/)
})

test('setup report: all good, local and command engines, listening off', () => {
  const r = setupReport({ ...BASE, sonioxKey: 'sx', ttsEngine: 'local', localTtsUrl: 'http://127.0.0.1:8880/v1', sttEngine: 'command', sttCommand: 'whisper-cli -f {in}', listenMode: 'off' },
    { ffmpeg: true, player: { name: 'afplay', ok: true } })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('✓ Talking: Local speech server, http://127.0.0.1:8880/v1, model kokoro, voice af_heart'))
  assert.ok(r.text.includes('✓ Listening: Command, "whisper-cli -f {in}"'))
  assert.ok(r.text.includes('· Listening is off'))
  assert.match(r.text, /All set\./)
})

test('hub: GET /setup reports the live config and machine; POST /setup/test queues a line', async () => {
  const played = []
  const hub = createHub({
    token: 't', engines: { tts: async x => Buffer.from(x), stt: async () => '' },
    audio: { play: async b => { played.push(b.toString()) } },
    checkMachine: async () => ({ ffmpeg: true, player: { name: 'ffplay', ok: true } }),
  })
  hubs.push(hub)
  const { port } = await hub.listen(0)
  const call = async (m, p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'x-interccom-token': 't', 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json()
  await call('POST', '/config', { ttsEngine: 'openai', openaiKey: 'oa', sttEngine: 'groq' })
  const r = await call('GET', '/setup')
  assert.equal(r.ok, false)
  assert.ok(r.text.includes('✓ Talking: OpenAI, model gpt-4o-mini-tts, voice alloy'))
  assert.match(r.text, /✗ Listening: Groq.*\n\s+→ No Groq API key/)
  const reg = await call('POST', '/sessions', { name: 'x', cwd: '/x' })
  assert.deepEqual(await call('POST', '/setup/test', { sessionId: reg.sessionId }), { queued: true })
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(played, ["interccom is working. This is how I'll sound."])
})

// ---- interccom setup ----

test('setup flags map to setting names, and choices are validated per direction', () => {
  assert.equal(FLAGS.tts, 'tts_engine')
  assert.equal(validate({ tts_engine: 'deepgram', stt_engine: 'soniox', listen_mode: 'wake' }), '')
  assert.match(validate({ tts_engine: 'groq' }), /Talking engine must be one of: elevenlabs, deepgram, soniox, openai, cartesia, local, command/)
  assert.match(validate({ stt_engine: 'cartesia' }), /Listening engine must be one of/)
  assert.match(validate({ listen_mode: 'sometimes' }), /Listening mode/)
})

test('saveChoices merges, removes blanks, writes 0600, and refuses keys', () => {
  const d = tmp()
  const f = path.join(d, 'sub', 'config.json')
  const a = saveChoices(f, {}, { tts_engine: 'deepgram', tts_voice: 'x' })
  assert.deepEqual(a, { tts_engine: 'deepgram', tts_voice: 'x' })
  const b = saveChoices(f, a, { tts_voice: '', stt_engine: 'soniox' })
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { tts_engine: 'deepgram', stt_engine: 'soniox' })
  assert.deepEqual(b, { tts_engine: 'deepgram', stt_engine: 'soniox' })
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  assert.throws(() => saveChoices(f, b, { deepgram_api_key: 'k' }), /never saves API keys/)
})

test('keyAdvice: setx on Windows, export elsewhere, ✓ when found; local engines need none', () => {
  const win = keyAdvice({ tts_engine: 'deepgram', stt_engine: 'deepgram' }, { env: {}, platform: 'win32', readRegistry: () => '' })
  assert.deepEqual(win, ['✗ Deepgram needs an API key (console.deepgram.com):\n    setx DEEPGRAM_API_KEY "<your key>"   (open a new terminal afterwards)'])
  const mac = keyAdvice({ tts_engine: 'cartesia', stt_engine: 'soniox' }, { env: { SONIOX_API_KEY: 'k' }, platform: 'darwin' })
  assert.deepEqual(mac, ['✗ Cartesia needs an API key (play.cartesia.ai):\n    export CARTESIA_API_KEY="<your key>"   (add it to your shell profile)', '✓ Soniox key found in SONIOX_API_KEY.'])
  assert.deepEqual(keyAdvice({ tts_engine: 'local', stt_engine: 'command' }, { env: {}, platform: 'linux' }), [])
})

test('setup flags are saved even next to --test or --show', async () => {
  const { runSetup } = await import('../../hub/setup-cli.mjs')
  const d = tmp()
  const calls = []
  // A stand-in hub: it sees the choices already saved, as the real one would read them.
  const hub = async (env, fn) => fn(async (method, p) => {
    calls.push([method, p, JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')).tts_engine])
    return p === '/sessions' ? { sessionId: 's' } : { text: '' }
  })
  const log = console.log
  console.log = () => {}
  try {
    await runSetup(['--tts', 'local', '--stt', 'local', '--show'], { env: { INTERCCOM_STATE_DIR: d }, hub })
  } finally {
    console.log = log
  }
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'))
  assert.equal(saved.tts_engine, 'local')
  assert.equal(saved.stt_engine, 'local')
  assert.deepEqual(calls, [['GET', '/setup', 'local']])
})

test('interactive setup asks for both engines, then only what the choice needs', async () => {
  const asked = []
  const answers = ['soniox', 'local', '', '', '', '', 'hr', 'always']
  const rl = { question: async q => { asked.push(q); return answers.shift() ?? '' } }
  const c = await interactive({ local_stt_url: 'http://gpu-box:8000/v1' }, rl)
  assert.deepEqual(c, {
    tts_engine: 'soniox', stt_engine: 'local', local_stt_url: 'http://gpu-box:8000/v1',
    tts_voice: '', tts_model: '', stt_model: '', stt_language: 'hr', listen_mode: 'always',
  })
  assert.ok(asked[0].startsWith('Talking engine [elevenlabs]'))
  assert.ok(asked.some(q => q.startsWith('Local STT server URL [http://gpu-box:8000/v1]')))
  assert.ok(!asked.some(q => q.startsWith('Local TTS')))
  // An invalid answer is asked again.
  const again = ['nope', 'deepgram', 'deepgram', '', '', '', 'en', 'wake']
  const rl2 = { question: async () => again.shift() ?? '' }
  assert.equal((await interactive({}, rl2)).tts_engine, 'deepgram')
})
