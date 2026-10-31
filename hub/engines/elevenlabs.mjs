const BASE = 'https://api.elevenlabs.io/v1';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

const MESSAGES = {
  auth: 'ElevenLabs rejected the API key. Check it in /plugin settings for interccom or in ELEVENLABS_API_KEY.',
  quota: "ElevenLabs quota or rate limit reached. Check your plan's usage at elevenlabs.io.",
  network: "Couldn't reach ElevenLabs. Check your internet connection.",
  timeout: "ElevenLabs didn't answer in time. Check your connection.",
};
const TIMEOUT_MS = 20_000;

const timedOut = (err) => err?.name === 'TimeoutError';

// Reads a response body; a timeout mid-body is the same network error.
async function readBody(p) {
  try {
    return await p;
  } catch (err) {
    if (timedOut(err)) throw new EngineError('network', MESSAGES.timeout);
    throw err;
  }
}

async function request(url, init, fetchFn, defaultPermission, timeoutMs) {
  let res;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new EngineError('network', timedOut(err) ? MESSAGES.timeout : MESSAGES.network);
  }
  if (res.ok) return res;

  const body = await res.text().catch(() => '');
  let detail = {};
  try {
    const d = JSON.parse(body).detail;
    if (d && typeof d === 'object') detail = d;
  } catch { /* not JSON */ }

  if ((res.status === 401 || res.status === 403) && detail.status === 'missing_permissions') {
    const named = /speech_to_text|text_to_speech/.exec(detail.message || '');
    const perm = named ? named[0] : defaultPermission;
    throw new EngineError('permission',
      `Your ElevenLabs API key is missing a permission (${perm}). In ElevenLabs → API keys, edit the key and enable Speech to Text and Text to Speech.`);
  }
  if (res.status === 429 || detail.status === 'quota_exceeded') throw new EngineError('quota', MESSAGES.quota);
  if (res.status === 401) throw new EngineError('auth', MESSAGES.auth);
  throw new EngineError('other', `ElevenLabs error ${res.status}: ${body.slice(0, 200)}`);
}

export async function tts(text, { apiKey, voiceId, modelId = 'eleven_flash_v2_5', fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const res = await request(
    `${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: modelId }),
    },
    fetch,
    'text_to_speech',
    timeoutMs,
  );
  return Buffer.from(await readBody(res.arrayBuffer()));
}

export async function stt(wav, { apiKey, model = 'scribe_v1', language, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const form = new FormData();
  form.append('model_id', model);
  form.append('tag_audio_events', 'false');
  if (language && language !== 'auto') form.append('language_code', language);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  const res = await request(
    `${BASE}/speech-to-text`,
    { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
    fetch,
    'speech_to_text',
    timeoutMs,
  );
  const json = await readBody(res.json());
  return String(json.text ?? '').trim();
}
