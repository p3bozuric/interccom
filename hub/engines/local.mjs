// Speech over the OpenAI audio API: POST {url}/audio/speech and {url}/audio/transcriptions.
// Used for local model servers (Kokoro-FastAPI, Speaches / faster-whisper, whisper.cpp server
// with --inference-path /v1/audio/transcriptions, LocalAI) and, with an API key, for OpenAI
// and Groq themselves.
import { EngineError } from './elevenlabs.mjs'
import { providerFetch, readBuffer, readJson } from './http.mjs'

const TIMEOUT_MS = 60_000 // local models on a CPU can be slow, especially on the first call
const LOCAL = 'the local speech server'

function endpoint(base, suffix, label) {
  let u
  try { u = new URL(String(base)) } catch { throw new EngineError('config', `The URL for ${label} ("${base}") is not a valid URL.`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EngineError('config', `The URL for ${label} ("${base}") must start with http:// or https://.`)
  return `${u.href.replace(/\/+$/, '')}/${suffix}`
}

function auth(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

export async function tts(text, { url, model, voice, apiKey, label = LOCAL, keySetting, fetch, timeoutMs = TIMEOUT_MS }) {
  const target = endpoint(url, 'audio/speech', label)
  const res = await providerFetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(apiKey) },
    body: JSON.stringify({ model, voice, input: text, response_format: 'wav' }),
  }, { label, keySetting, fetch, timeoutMs })
  return readBuffer(res, label)
}

export async function stt(wav, { url, model, language, apiKey, label = LOCAL, keySetting, fetch, timeoutMs = TIMEOUT_MS }) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
  form.append('model', model)
  form.append('response_format', 'json')
  if (language && language !== 'auto') form.append('language', language)
  const target = endpoint(url, 'audio/transcriptions', label)
  const res = await providerFetch(target, { method: 'POST', headers: auth(apiKey), body: form }, { label, keySetting, fetch, timeoutMs })
  const json = await readJson(res, label)
  return String(json?.text ?? '').trim()
}
