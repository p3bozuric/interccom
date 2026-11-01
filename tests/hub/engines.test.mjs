import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import * as local from '../../hub/engines/local.mjs'
import * as command from '../../hub/engines/command.mjs'
import { createEngines, audioExt, ENGINES } from '../../hub/engines/index.mjs'
import { EngineError } from '../../hub/engines/elevenlabs.mjs'

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
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
    e => e instanceof EngineError && e.code === 'network' && /Is it running\?/.test(e.message))
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
  return { calls, impl: { elevenlabs: mk('elevenlabs'), local: mk('local'), command: mk('command') } }
}

const CFG = {
  apiKey: 'k', voiceId: 'v', ttsModel: 'tm', sttModel: 'sm', sttLanguage: 'en',
  ttsEngine: 'elevenlabs', sttEngine: 'elevenlabs',
  localTtsUrl: 'http://t/v1', localTtsModel: 'kokoro', localTtsVoice: 'af', localSttUrl: 'http://s/v1', localSttModel: 'w',
  ttsCommand: 'piper {out}', sttCommand: 'whisper {in}',
}

test('createEngines routes each direction to its own engine with the right options', async () => {
  const { calls, impl } = recorder()
  const e = createEngines({ impl, cwd: '/state' })
  await e.tts('x', CFG)
  await e.stt(Buffer.from('w'), { ...CFG, sttEngine: 'local' })
  await e.tts('y', { ...CFG, ttsEngine: 'command' })
  await e.stt(Buffer.from('w'), { ...CFG, sttEngine: 'command' })
  await e.tts('z', { ...CFG, ttsEngine: 'local' })
  assert.deepEqual(calls, [
    ['elevenlabs', 'tts', 'x', { apiKey: 'k', voiceId: 'v', modelId: 'tm' }],
    ['local', 'stt', { url: 'http://s/v1', model: 'w', language: 'en' }],
    ['command', 'tts', 'y', { command: 'piper {out}', cwd: '/state' }],
    ['command', 'stt', { command: 'whisper {in}', cwd: '/state' }],
    ['local', 'tts', 'z', { url: 'http://t/v1', model: 'kokoro', voice: 'af' }],
  ])
})

test('createEngines: no key is an error only for elevenlabs; sttReady follows the engine', async () => {
  const { impl } = recorder()
  const e = createEngines({ impl })
  const noKey = { ...CFG, apiKey: '' }
  assert.throws(() => e.tts('x', noKey), e => e.code === 'auth' && /local engine/.test(e.message))
  await e.tts('x', { ...noKey, ttsEngine: 'local' })
  assert.equal(e.sttReady(noKey), false)
  assert.equal(e.sttReady({ ...noKey, sttEngine: 'local' }), true)
  assert.equal(e.sttReady({ ...noKey, sttEngine: 'command', sttCommand: '' }), false)
  assert.throws(() => e.stt(Buffer.from('w'), { ...CFG, sttEngine: 'command', sttCommand: '' }), e => e.code === 'config')
  assert.deepEqual([...ENGINES], ['elevenlabs', 'local', 'command'])
})

test('audioExt sniffs wav, ogg, flac, else mp3', () => {
  assert.equal(audioExt(Buffer.from('RIFF....WAVE')), 'wav')
  assert.equal(audioExt(Buffer.from('OggS')), 'ogg')
  assert.equal(audioExt(Buffer.from('fLaC')), 'flac')
  assert.equal(audioExt(Buffer.from([0xff, 0xfb, 0, 0])), 'mp3')
  assert.equal(audioExt(Buffer.alloc(0)), 'mp3')
})
