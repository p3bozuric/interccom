import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tts, stt, EngineError } from '../../hub/engines/elevenlabs.mjs';

function fake(res) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (res instanceof Error) throw res;
    return res;
  };
  f.calls = calls;
  return f;
}
const json = (status, body) => new Response(JSON.stringify(body), { status });

test('tts posts text and model and returns bytes', async () => {
  const f = fake(new Response(new Uint8Array([1, 2, 3])));
  const out = await tts('hi', { apiKey: 'k', voiceId: 'v1', modelId: 'm', fetch: f });
  assert.ok(f.calls[0].url.includes('/text-to-speech/v1'));
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'hi', model_id: 'm' });
  assert.equal(f.calls[0].init.headers['xi-api-key'], 'k');
  assert.deepEqual(out, Buffer.from([1, 2, 3]));
});

test('stt sends language only when set', async () => {
  const f = fake(json(200, { text: ' hello ' }));
  const r = await stt(Buffer.from([0]), { apiKey: 'k', language: 'en', fetch: f });
  assert.equal(r, 'hello');
  assert.equal(f.calls[0].init.body.get('language_code'), 'en');
  assert.equal(f.calls[0].init.body.get('model_id'), 'scribe_v1');
  assert.equal(f.calls[0].init.body.get('tag_audio_events'), 'false');
  assert.equal(f.calls[0].init.body.get('file').name, 'utterance.wav');
  const g = fake(json(200, { text: 'x' }));
  await stt(Buffer.from([0]), { apiKey: 'k', language: 'auto', fetch: g });
  assert.equal(g.calls[0].init.body.has('language_code'), false);
});

test('maps 401 missing_permissions to permission error', async () => {
  const f = fake(json(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission speech_to_text to execute this operation.' } }));
  await assert.rejects(stt(Buffer.from([0]), { apiKey: 'k', fetch: f }), (e) => {
    assert.ok(e instanceof EngineError);
    assert.equal(e.code, 'permission');
    assert.ok(e.message.includes('Speech to Text'));
    assert.ok(e.message.includes('(speech_to_text)'));
    return true;
  });
});

test('permission defaults to the permission of the call', async () => {
  const f = fake(json(403, { detail: { status: 'missing_permissions' } }));
  await assert.rejects(tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: f }), (e) =>
    e.code === 'permission' && e.message.includes('(text_to_speech)'));
});

test('maps 401 invalid key to auth', async () => {
  const f = fake(json(401, { detail: { status: 'invalid_api_key' } }));
  await assert.rejects(tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: f }), (e) => e.code === 'auth');
});

test('maps 429 and quota_exceeded to quota', async () => {
  await assert.rejects(tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: fake(json(429, {})) }), (e) => e.code === 'quota');
  await assert.rejects(tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: fake(json(400, { detail: { status: 'quota_exceeded' } })) }), (e) => e.code === 'quota');
});

test('maps fetch rejection to network', async () => {
  await assert.rejects(tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: fake(new Error('boom')) }), (e) => e.code === 'network');
});

test('other errors carry status and body', async () => {
  const f = fake(new Response('x'.repeat(300), { status: 500 }));
  await assert.rejects(tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: f }), (e) =>
    e.code === 'other' && e.message === `ElevenLabs error 500: ${'x'.repeat(200)}`);
});

test('tts encodes the voice id in the URL', async () => {
  const f = fake(new Response(new Uint8Array([1])));
  await tts('a', { apiKey: 'k', voiceId: 'a/b?c', modelId: 'm', fetch: f });
  assert.ok(f.calls[0].url.includes('/text-to-speech/a%2Fb%3Fc?'));
});

// Never answers; rejects with the signal's reason once it aborts, as real fetch does.
function hanging() {
  const calls = [];
  const f = (url, init) => {
    calls.push({ url, init });
    // AbortSignal.timeout's timer is unref'd: hold the event loop open until it fires.
    const keepAlive = setTimeout(() => {}, 10_000);
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal.reason);
    }, { once: true }));
  };
  f.calls = calls;
  return f;
}
const SLOW = "ElevenLabs didn't answer in time. Check your connection.";

test('tts and stt time out as a network error', async () => {
  await assert.rejects(tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: hanging(), timeoutMs: 20 }),
    (e) => e instanceof EngineError && e.code === 'network' && e.message === SLOW);
  await assert.rejects(stt(Buffer.from([0]), { apiKey: 'k', fetch: hanging(), timeoutMs: 20 }),
    (e) => e instanceof EngineError && e.code === 'network' && e.message === SLOW);
});

test('every call carries an abort signal by default', async () => {
  const f = fake(new Response(new Uint8Array([1])));
  await tts('a', { apiKey: 'k', voiceId: 'v', modelId: 'm', fetch: f });
  const g = fake(json(200, { text: 'x' }));
  await stt(Buffer.from([0]), { apiKey: 'k', fetch: g });
  for (const c of [f.calls[0], g.calls[0]]) {
    assert.ok(c.init.signal instanceof AbortSignal);
    assert.equal(c.init.signal.aborted, false);
  }
});
