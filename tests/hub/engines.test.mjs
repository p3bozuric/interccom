import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import * as local from '../../hub/engines/local.mjs'
import * as command from '../../hub/engines/command.mjs'
import { createEngines, audioExt, problem, resolved, TTS_ENGINES, STT_ENGINES } from '../../hub/engines/index.mjs'
import { EngineError } from '../../hub/engines/elevenlabs.mjs'

const fixture = name => `"${fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))}"`
const node = `"${process.execPath}"`

function fakeFetch(res) {
  const calls = []
  const f = async (url, init) => { calls.push({ url, init }); return typeof res === 'function' ? res() : res }
  f.calls = calls
  return f
}

// ---- local (OpenAI-compatible) ----

test('local tts posts OpenAI-style JSON to {url}/audio/speech and returns the audio', async () => {
  const f = fakeFetch(new Response(new Uint8Array([82, 73, 70, 70])))
  const audio = await local.tts('Hello.', { url: 'http://127.0.0.1:8880/v1/', model: 'kokoro', voice: 'af_heart', fetch: f })
  assert.equal(audio.toString(), 'RIFF')
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8880/v1/audio/speech')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { model: 'kokoro', voice: 'af_heart', input: 'Hello.', response_format: 'wav' })
  assert.ok(f.calls[0].init.signal instanceof AbortSignal)
})

test('local stt posts multipart to {url}/audio/transcriptions, language unless auto', async () => {
  const f = fakeFetch(() => new Response(JSON.stringify({ text: '  run the tests ' })))
  assert.equal(await local.stt(Buffer.from('wav'), { url: 'http://h:8000/v1', model: 'm', language: 'hr', fetch: f }), 'run the tests')
  const form = f.calls[0].init.body
  assert.equal(f.calls[0].url, 'http://h:8000/v1/audio/transcriptions')
  assert.equal(form.get('model'), 'm')
  assert.equal(form.get('language'), 'hr')
  assert.equal(form.get('response_format'), 'json')
  await local.stt(Buffer.from('wav'), { url: 'http://h:8000/v1', model: 'm', language: 'auto', fetch: f })
  assert.equal(f.calls[1].init.body.get('language'), null)
})

test('local errors name the cause: unreachable, 404 path, bad URL, other status', async () => {
  const down = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(local.tts('a', { url: 'http://127.0.0.1:1/v1', fetch: down }),
    e => e instanceof EngineError && e.code === 'network' && /Couldn't reach the local speech server .*server is running/.test(e.message))
  await assert.rejects(local.stt(Buffer.from('w'), { url: 'http://h/v1', model: 'm', fetch: fakeFetch(new Response('no', { status: 404 })) }),
    e => e.code === 'config' && /\/v1\/audio\/transcriptions/.test(e.message))
  await assert.rejects(local.tts('a', { url: 'not a url', fetch: fakeFetch(new Response('')) }), e => e.code === 'config')
  await assert.rejects(local.tts('a', { url: 'file:///x', fetch: fakeFetch(new Response('')) }), e => e.code === 'config')
  await assert.rejects(local.tts('a', { url: 'http://h/v1', fetch: fakeFetch(new Response('boom', { status: 500 })) }),
    e => e.code === 'other' && /500: boom/.test(e.message))
})

// ---- command ----

test('splitCommand: quotes group, backslashes stay, empty quotes are an argument', () => {
  assert.deepEqual(command.splitCommand('piper --model C:\\voices\\amy.onnx --output_file {out}'),
    ['piper', '--model', 'C:\\voices\\amy.onnx', '--output_file', '{out}'])
  assert.deepEqual(command.splitCommand(`"C:\\Program Files\\piper\\piper.exe" -m 'a b' ""`),
    ['C:\\Program Files\\piper\\piper.exe', '-m', 'a b', ''])
  assert.deepEqual(command.splitCommand('  '), [])
  assert.throws(() => command.splitCommand('piper "oops'), e => e.code === 'config')
})

test('cleanTranscript strips whisper timestamps and joins lines', () => {
  assert.equal(command.cleanTranscript('[00:00:00.000 --> 00:00:01.000]  hey claude\n[00:00:01.000 --> 00:00:02.000] run it\n'), 'hey claude run it')
  assert.equal(command.cleanTranscript(' plain text \r\n'), 'plain text')
})

test('command tts: text on stdin, audio read back from {out}, or from stdout without it', async () => {
  const viaFile = await command.tts('hi there', { command: `${node} ${fixture('fake-piper.mjs')} --output_file {out}` })
  assert.equal(viaFile.toString(), 'RIFFhi there')
  const viaStdout = await command.tts('yo', { command: `${node} ${fixture('fake-piper.mjs')}` })
  assert.equal(viaStdout.toString(), 'RIFFyo')
})

test('command stt: the WAV is written to {in} and stdout is the transcript', async () => {
  const text = await command.stt(Buffer.alloc(7), { command: `${node} ${fixture('fake-whisper.mjs')} -f {in} -np` })
  assert.equal(text, 'heard 7 bytes')
  await assert.rejects(command.stt(Buffer.alloc(1), { command: 'whisper-cli -f x' }), e => e.code === 'config' && /\{in\}/.test(e.message))
})

test('command errors: missing program, non-zero exit with stderr, timeout', async () => {
  await assert.rejects(command.tts('a', { command: 'interccom-no-such-program {out}' }),
    e => e.code === 'config' && /Install it, or put its full path in the tts_command setting/.test(e.message))
  await assert.rejects(command.tts('a', { command: `${node} ${fixture('fake-piper.mjs')} --fail` }),
    e => e.code === 'other' && /exit 3/.test(e.message) && /model not found/.test(e.message))
  await assert.rejects(command.tts('a', { command: `${node} -e "setTimeout(()=>{},5000)"`, timeoutMs: 100 }),
    e => e.code === 'network' && /took longer/.test(e.message))
})

// ---- registry ----

function recorder() {
  const calls = []
  const mk = name => ({
    tts: async (text, o) => { calls.push([name, 'tts', text, o]); return Buffer.from('a') },
    stt: async (wav, o) => { calls.push([name, 'stt', o]); return 't' },
  })
  const impl = Object.fromEntries(['elevenlabs', 'local', 'command', 'deepgram', 'soniox', 'cartesia'].map(n => [n, mk(n)]))
  return { calls, impl }
}

const KEYS = { apiKey: 'el', deepgramKey: 'dg', sonioxKey: 'sx', openaiKey: 'oa', groqKey: 'gq', cartesiaKey: 'ca' }
const CFG = {
  ...KEYS, voiceId: '', ttsModel: '', sttModel: '', sttLanguage: 'hr',
  ttsEngine: 'elevenlabs', sttEngine: 'elevenlabs',
  localTtsUrl: 'http://t/v1', localSttUrl: 'http://s/v1', ttsCommand: 'piper {out}', sttCommand: 'whisper {in}',
}

test('createEngines: every engine gets its own defaults, key and language', async () => {
  const { calls, impl } = recorder()
  const e = createEngines({ impl, cwd: '/state' })
  for (const ttsEngine of ['elevenlabs', 'deepgram', 'soniox', 'openai', 'cartesia', 'local', 'command']) await e.tts('x', { ...CFG, ttsEngine })
  for (const sttEngine of ['elevenlabs', 'deepgram', 'soniox', 'openai', 'groq', 'local', 'command']) await e.stt(Buffer.from('w'), { ...CFG, sttEngine })
  const oa = { label: 'OpenAI', keySetting: 'openai_api_key (or OPENAI_API_KEY)', timeoutMs: 20_000 }
  assert.deepEqual(calls, [
    ['elevenlabs', 'tts', 'x', { apiKey: 'el', voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_flash_v2_5' }],
    ['deepgram', 'tts', 'x', { apiKey: 'dg', model: 'aura-2-thalia-en' }],
    ['soniox', 'tts', 'x', { apiKey: 'sx', model: 'tts-rt-v2', voice: 'Adrian', language: 'hr' }],
    ['local', 'tts', 'x', { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKey: 'oa', ...oa }],
    ['cartesia', 'tts', 'x', { apiKey: 'ca', model: 'sonic-3', voice: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b', language: 'hr' }],
    ['local', 'tts', 'x', { url: 'http://t/v1', model: 'kokoro', voice: 'af_heart' }],
    ['command', 'tts', 'x', { command: 'piper {out}', cwd: '/state' }],
    ['elevenlabs', 'stt', { apiKey: 'el', model: 'scribe_v1', language: 'hr' }],
    ['deepgram', 'stt', { apiKey: 'dg', model: 'nova-3', language: 'hr' }],
    ['soniox', 'stt', { apiKey: 'sx', model: 'stt-async-v5', language: 'hr' }],
    ['local', 'stt', { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', language: 'hr', apiKey: 'oa', ...oa }],
    ['local', 'stt', { url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', language: 'hr', apiKey: 'gq', label: 'Groq', keySetting: 'groq_api_key (or GROQ_API_KEY)', timeoutMs: 20_000 }],
    ['local', 'stt', { url: 'http://s/v1', model: 'Systran/faster-whisper-small', language: 'hr' }],
    ['command', 'stt', { command: 'whisper {in}', cwd: '/state' }],
  ])
})

test('createEngines: the person\'s model and voice win over the defaults', async () => {
  const { calls, impl } = recorder()
  const e = createEngines({ impl })
  await e.tts('x', { ...CFG, ttsEngine: 'deepgram', ttsModel: 'aura-2-orion-en' })
  await e.stt(Buffer.from('w'), { ...CFG, sttEngine: 'soniox', sttModel: 'stt-async-v4' })
  await e.tts('x', { ...CFG, ttsEngine: 'openai', voiceId: 'nova', ttsModel: 'tts-1' })
  assert.equal(calls[0][3].model, 'aura-2-orion-en')
  assert.equal(calls[1][2].model, 'stt-async-v4')
  assert.deepEqual([calls[2][3].voice, calls[2][3].model], ['nova', 'tts-1'])
})

test('problems name the missing key and where to get it; sttReady follows them', () => {
  const none = { ...CFG, ...Object.fromEntries(Object.keys(KEYS).map(k => [k, ''])) }
  assert.match(problem({ ...none, ttsEngine: 'deepgram' }, 'tts'), /^No Deepgram API key\. Set deepgram_api_key .* DEEPGRAM_API_KEY\. Get one at console\.deepgram\.com\.$/)
  assert.match(problem({ ...none, sttEngine: 'soniox' }, 'stt'), /SONIOX_API_KEY/)
  assert.equal(problem({ ...none, sttEngine: 'local' }, 'stt'), '')
  assert.match(problem({ ...none, ttsEngine: 'groq' }, 'tts'), /groq can't do talking/)
  assert.match(problem({ ...none, sttEngine: 'cartesia' }, 'stt'), /cartesia can't do listening/)
  assert.match(problem({ ...none, sttEngine: 'command', sttCommand: '' }, 'stt'), /stt_command is empty/)
  const { impl } = recorder()
  const e = createEngines({ impl })
  assert.equal(e.sttReady(none), false)
  assert.equal(e.sttReady({ ...none, sttEngine: 'local' }), true)
  assert.throws(() => e.tts('x', { ...none, ttsEngine: 'openai' }), err => err.code === 'auth' && /OPENAI_API_KEY/.test(err.message))
  assert.throws(() => e.stt(Buffer.from('w'), { ...CFG, sttEngine: 'command', sttCommand: '' }), err => err.code === 'config')
})

test('engine lists per direction', () => {
  assert.deepEqual(TTS_ENGINES, ['elevenlabs', 'deepgram', 'soniox', 'openai', 'cartesia', 'local', 'command'])
  assert.deepEqual(STT_ENGINES, ['elevenlabs', 'deepgram', 'soniox', 'openai', 'groq', 'local', 'command'])
  assert.deepEqual(resolved({}, 'tts'), { engine: 'elevenlabs', model: 'eleven_flash_v2_5', voice: '21m00Tcm4TlvDq8ikWAM' })
})

test('audioExt sniffs wav, ogg, flac, else mp3', () => {
  assert.equal(audioExt(Buffer.from('RIFF....WAVE')), 'wav')
  assert.equal(audioExt(Buffer.from('OggS')), 'ogg')
  assert.equal(audioExt(Buffer.from('fLaC')), 'flac')
  assert.equal(audioExt(Buffer.from([0xff, 0xfb, 0, 0])), 'mp3')
  assert.equal(audioExt(Buffer.alloc(0)), 'mp3')
})
