// Soniox: TTS (POST https://tts-rt.soniox.com/tts) and async STT (upload the file,
// create a transcription, poll it, read the transcript, then delete both).
// Auth is "Authorization: Bearer <key>". Checked against @soniox/node 2.4.
import { EngineError } from './elevenlabs.mjs'
import { providerFetch, readBuffer, readJson } from './http.mjs'

const API = 'https://api.soniox.com'
const TTS_API = 'https://tts-rt.soniox.com'
const LABEL = 'Soniox'
const KEY = 'soniox_api_key (or SONIOX_API_KEY)'
const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function tts(text, { apiKey, model = 'tts-rt-v2', voice = 'Adrian', language = 'en', fetch, timeoutMs, base = TTS_API }) {
  const res = await providerFetch(`${base}/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, language, voice, audio_format: 'wav', text }),
  }, { label: LABEL, keySetting: KEY, fetch, timeoutMs })
  return readBuffer(res, LABEL)
}

export async function stt(wav, {
  apiKey, model = 'stt-async-v5', language, fetch, timeoutMs = 20_000, base = API,
  pollMs = 250, deadlineMs = 30_000, now = Date.now, wait = sleep,
}) {
  const opts = { label: LABEL, keySetting: KEY, fetch, timeoutMs }
  const headers = { authorization: `Bearer ${apiKey}` }
  const call = async (method, p, body, json = true) => {
    const init = { method, headers: { ...headers, ...(json && body ? { 'content-type': 'application/json' } : {}) } }
    if (body) init.body = json ? JSON.stringify(body) : body
    return providerFetch(`${base}${p}`, init, opts)
  }
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
  const file = await readJson(await call('POST', '/v1/files', form, false), LABEL)
  let job
  try {
    job = await readJson(await call('POST', '/v1/transcriptions', {
      model, file_id: file.id,
      ...(language && language !== 'auto' ? { language_hints: [language] } : {}),
    }), LABEL)
    const end = now() + deadlineMs
    while (job.status === 'queued' || job.status === 'processing') {
      if (now() > end) throw new EngineError('network', `${LABEL} didn't finish the transcription in time.`)
      await wait(pollMs)
      job = await readJson(await call('GET', `/v1/transcriptions/${encodeURIComponent(job.id)}`), LABEL)
    }
    if (job.status !== 'completed') throw new EngineError('other', `${LABEL} transcription failed: ${job.error_message || job.status}`)
    const transcript = await readJson(await call('GET', `/v1/transcriptions/${encodeURIComponent(job.id)}/transcript`), LABEL)
    return String(transcript?.text ?? '').trim()
  } finally {
    // Don't leave the person's audio on Soniox's servers. Best effort.
    if (job?.id) await call('DELETE', `/v1/transcriptions/${encodeURIComponent(job.id)}`).catch(() => {})
    if (file?.id) await call('DELETE', `/v1/files/${encodeURIComponent(file.id)}`).catch(() => {})
  }
}
