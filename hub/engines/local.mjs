// Local speech over an OpenAI-compatible HTTP API, so any local model server works:
//   TTS  POST {url}/audio/speech         (Kokoro-FastAPI, LocalAI, Speaches, openedai-speech)
//   STT  POST {url}/audio/transcriptions (Speaches / faster-whisper-server, LocalAI,
//                                         whisper.cpp server with --inference-path /v1/audio/transcriptions)
import { EngineError } from './elevenlabs.mjs'

const TIMEOUT_MS = 60_000 // local models on a CPU can be slow, especially on the first call

function endpoint(base, suffix) {
  let u
  try { u = new URL(String(base)) } catch { throw new EngineError('config', `The local speech server URL "${base}" is not a valid URL.`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EngineError('config', `The local speech server URL "${base}" must start with http:// or https://.`)
  return `${u.href.replace(/\/+$/, '')}/${suffix}`
}

async function request(url, init, fetchFn, timeoutMs) {
  let res
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new EngineError('network', `The local speech server at ${url} didn't answer in time.`)
    throw new EngineError('network', `Couldn't reach the local speech server at ${url}. Is it running?`)
  }
  if (res.ok) return res
  const body = (await res.text().catch(() => '')).slice(0, 200)
  if (res.status === 404) {
    throw new EngineError('config', `The local speech server has no ${new URL(url).pathname} (404). Check the URL ends in /v1 and the server speaks the OpenAI audio API.`)
  }
  throw new EngineError('other', `Local speech server error ${res.status}: ${body}`)
}

export async function tts(text, { url, model, voice, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const target = endpoint(url, 'audio/speech')
  const res = await request(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, input: text, response_format: 'wav' }),
  }, fetch, timeoutMs)
  try {
    return Buffer.from(await res.arrayBuffer())
  } catch {
    throw new EngineError('network', `The local speech server at ${target} stopped mid-answer.`)
  }
}

export async function stt(wav, { url, model, language, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
  form.append('model', model)
  form.append('response_format', 'json')
  if (language && language !== 'auto') form.append('language', language)
  const target = endpoint(url, 'audio/transcriptions')
  const res = await request(target, { method: 'POST', body: form }, fetch, timeoutMs)
  let json
  try { json = await res.json() } catch { throw new EngineError('other', 'The local speech server did not return JSON for a transcription.') }
  return String(json?.text ?? '').trim()
}
