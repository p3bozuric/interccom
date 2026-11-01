// Deepgram: Aura TTS (POST /v1/speak) and Nova STT (POST /v1/listen, prerecorded).
// Auth is "Authorization: Token <key>". Checked against @deepgram/sdk 5.17.
import { providerFetch, readBuffer, readJson } from './http.mjs'

const BASE = 'https://api.deepgram.com'
const LABEL = 'Deepgram'
const KEY = 'deepgram_api_key (or DEEPGRAM_API_KEY)'

export async function tts(text, { apiKey, model = 'aura-2-thalia-en', fetch, timeoutMs, base = BASE }) {
  const q = new URLSearchParams({ model, encoding: 'mp3' })
  const res = await providerFetch(`${base}/v1/speak?${q}`, {
    method: 'POST',
    headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }, { label: LABEL, keySetting: KEY, fetch, timeoutMs })
  return readBuffer(res, LABEL)
}

export async function stt(wav, { apiKey, model = 'nova-3', language, fetch, timeoutMs, base = BASE }) {
  const q = new URLSearchParams({ model, smart_format: 'true' })
  if (language && language !== 'auto') q.set('language', language)
  else q.set('detect_language', 'true')
  const res = await providerFetch(`${base}/v1/listen?${q}`, {
    method: 'POST',
    headers: { authorization: `Token ${apiKey}`, 'content-type': 'audio/wav' },
    body: wav,
  }, { label: LABEL, keySetting: KEY, fetch, timeoutMs })
  const json = await readJson(res, LABEL)
  return String(json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
}
