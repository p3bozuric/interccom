import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as deepgram from '../../hub/engines/deepgram.mjs'
import * as soniox from '../../hub/engines/soniox.mjs'
import * as cartesia from '../../hub/engines/cartesia.mjs'
import * as local from '../../hub/engines/local.mjs'
import { EngineError } from '../../hub/engines/elevenlabs.mjs'

// A fake fetch answering from a list of responses (or a function of the request), recording calls.
function fake(...answers) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init, headers: init.headers ?? {} })
    const a = answers.length > 1 ? answers.shift() : answers[0]
    return typeof a === 'function' ? a(url, init) : a.clone ? a.clone() : a
  }
  f.calls = calls
  return f
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const audio = () => new Response(new Uint8Array([0x49, 0x44, 0x33, 1]))

// ---- Deepgram ----

test('deepgram tts: Aura model and mp3 in the query, Token auth, {text} body', async () => {
  const f = fake(audio())
  const out = await deepgram.tts('Hello.', { apiKey: 'dg', model: 'aura-2-orion-en', fetch: f })
  assert.equal(out.length, 4)
  const u = new URL(f.calls[0].url)
  assert.equal(u.origin + u.pathname, 'https://api.deepgram.com/v1/speak')
  assert.deepEqual(Object.fromEntries(u.searchParams), { model: 'aura-2-orion-en', encoding: 'mp3' })
  assert.equal(f.calls[0].headers.authorization, 'Token dg')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'Hello.' })
  assert.ok(f.calls[0].init.signal instanceof AbortSignal)
})

test('deepgram stt: raw WAV body, nova-3 + language, or detect_language for auto; reads the first alternative', async () => {
  const body = { results: { channels: [{ alternatives: [{ transcript: ' run the tests ' }] }] } }
  const f = fake(json(200, body))
  assert.equal(await deepgram.stt(Buffer.from('wav'), { apiKey: 'dg', language: 'hr', fetch: f }), 'run the tests')
  let u = new URL(f.calls[0].url)
  assert.equal(u.pathname, '/v1/listen')
  assert.deepEqual(Object.fromEntries(u.searchParams), { model: 'nova-3', smart_format: 'true', language: 'hr' })
  assert.equal(f.calls[0].headers['content-type'], 'audio/wav')
  assert.equal(f.calls[0].init.body.toString(), 'wav')
  await deepgram.stt(Buffer.from('wav'), { apiKey: 'dg', language: 'auto', fetch: f })
  u = new URL(f.calls[1].url)
  assert.equal(u.searchParams.get('detect_language'), 'true')
  assert.equal(u.searchParams.get('language'), null)
  assert.equal(await deepgram.stt(Buffer.from('w'), { apiKey: 'dg', fetch: fake(json(200, {})) }), '')
})

test('provider errors: bad key names the setting, quota, unreachable', async () => {
  await assert.rejects(deepgram.tts('a', { apiKey: 'x', fetch: fake(json(401, { err: 'no' })) }),
    e => e instanceof EngineError && e.code === 'auth' && e.message === 'Deepgram rejected the API key (401). Check deepgram_api_key (or DEEPGRAM_API_KEY).')
  await assert.rejects(soniox.tts('a', { apiKey: 'x', fetch: fake(json(429, {})) }), e => e.code === 'quota' && /^Soniox quota/.test(e.message))
  const down = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(cartesia.tts('a', { apiKey: 'x', voice: 'v', fetch: down }), e => e.code === 'network' && /^Couldn't reach Cartesia at https:\/\/api\.cartesia\.ai\/tts\/bytes\. Check your connection\.$/.test(e.message))
})

// ---- Soniox ----

test('soniox tts: tts-rt-v2, voice, language, wav, Bearer auth', async () => {
  const f = fake(audio())
  await soniox.tts('Hi.', { apiKey: 'sx', language: 'hr', fetch: f })
  assert.equal(f.calls[0].url, 'https://tts-rt.soniox.com/tts')
  assert.equal(f.calls[0].headers.authorization, 'Bearer sx')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { model: 'tts-rt-v2', language: 'hr', voice: 'Adrian', audio_format: 'wav', text: 'Hi.' })
})

test('soniox stt: upload, create, poll until completed, read the transcript, then delete both', async () => {
  const f = fake(
    json(201, { id: 'file-1' }),
    json(201, { id: 'tr-1', status: 'queued' }),
    json(200, { id: 'tr-1', status: 'processing' }),
    json(200, { id: 'tr-1', status: 'completed' }),
    json(200, { id: 'tr-1', text: ' dobar dan ', tokens: [] }),
    json(200, {}),
    json(200, {}),
  )
  const text = await soniox.stt(Buffer.from('wav'), { apiKey: 'sx', language: 'hr', fetch: f, wait: async () => {} })
  assert.equal(text, 'dobar dan')
  assert.deepEqual(f.calls.map(c => `${c.init.method} ${new URL(c.url).pathname}`), [
    'POST /v1/files',
    'POST /v1/transcriptions',
    'GET /v1/transcriptions/tr-1',
    'GET /v1/transcriptions/tr-1',
    'GET /v1/transcriptions/tr-1/transcript',
    'DELETE /v1/transcriptions/tr-1',
    'DELETE /v1/files/file-1',
  ])
  assert.ok(f.calls[0].init.body instanceof FormData)
  assert.equal(f.calls[0].init.body.get('file').name, 'utterance.wav')
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { model: 'stt-async-v5', file_id: 'file-1', language_hints: ['hr'] })
  assert.ok(f.calls.every(c => c.headers.authorization === 'Bearer sx'))
})

test('soniox stt: auto language sends no hints; a failed job and a timeout still clean up', async () => {
  const ok = fake(json(201, { id: 'f' }), json(201, { id: 't', status: 'completed' }), json(200, { text: 'x' }), json(200, {}))
  await soniox.stt(Buffer.from('w'), { apiKey: 'k', language: 'auto', fetch: ok })
  assert.deepEqual(JSON.parse(ok.calls[1].init.body), { model: 'stt-async-v5', file_id: 'f' })

  const failed = fake(json(201, { id: 'f' }), json(201, { id: 't', status: 'error', error_message: 'audio too short' }), json(200, {}))
  await assert.rejects(soniox.stt(Buffer.from('w'), { apiKey: 'k', fetch: failed }), e => e.code === 'other' && /audio too short/.test(e.message))
  assert.deepEqual(failed.calls.slice(-2).map(c => `${c.init.method} ${new URL(c.url).pathname}`), ['DELETE /v1/transcriptions/t', 'DELETE /v1/files/f'])

  let t = 0
  const slow = fake(json(201, { id: 'f' }), json(201, { id: 't', status: 'queued' }), json(200, { id: 't', status: 'processing' }))
  await assert.rejects(soniox.stt(Buffer.from('w'), { apiKey: 'k', fetch: slow, deadlineMs: 100, now: () => (t += 60), wait: async () => {} }),
    e => e.code === 'network' && /didn't finish the transcription in time/.test(e.message))
  assert.ok(slow.calls.some(c => c.init.method === 'DELETE'))
})

// ---- Cartesia ----

test('cartesia tts: /tts/bytes, version header, voice by id, mp3 output; no voice is a config error', async () => {
  const f = fake(audio())
  await cartesia.tts('Hey.', { apiKey: 'ca', voice: 'voice-uuid', language: 'en', fetch: f })
  assert.equal(f.calls[0].url, 'https://api.cartesia.ai/tts/bytes')
  assert.equal(f.calls[0].headers.authorization, 'Bearer ca')
  assert.equal(f.calls[0].headers['cartesia-version'], cartesia.CARTESIA_VERSION)
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    model_id: 'sonic-3', transcript: 'Hey.', voice: { mode: 'id', id: 'voice-uuid' },
    output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 }, language: 'en',
  })
  await assert.rejects(cartesia.tts('a', { apiKey: 'ca', voice: '', fetch: f }), e => e.code === 'config' && /tts_voice/.test(e.message))
})

// ---- OpenAI / Groq through the OpenAI-style engine ----

test('openai-style engine sends a Bearer key when given one, and none to a local server', async () => {
  const f = fake(audio())
  await local.tts('a', { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKey: 'oa', label: 'OpenAI', keySetting: 'openai_api_key', fetch: f })
  assert.equal(f.calls[0].headers.authorization, 'Bearer oa')
  await local.tts('a', { url: 'http://127.0.0.1:8880/v1', model: 'kokoro', voice: 'af', fetch: f })
  assert.equal(f.calls[1].headers.authorization, undefined)
  await assert.rejects(local.stt(Buffer.from('w'), { url: 'https://api.groq.com/openai/v1', model: 'm', apiKey: 'bad', label: 'Groq', keySetting: 'groq_api_key (or GROQ_API_KEY)', fetch: fake(json(401, {})) }),
    e => e.code === 'auth' && e.message === 'Groq rejected the API key (401). Check groq_api_key (or GROQ_API_KEY).')
})
