// Cartesia: Sonic TTS (POST https://api.cartesia.ai/tts/bytes). Text to speech only.
// Auth is "Authorization: Bearer <key>" plus a cartesia-version header. Checked against
// @cartesia/cartesia-js 4.2.
import { EngineError } from './elevenlabs.mjs'
import { providerFetch, readBuffer } from './http.mjs'

const BASE = 'https://api.cartesia.ai'
export const CARTESIA_VERSION = '2026-08-14'
const LABEL = 'Cartesia'

export async function tts(text, { apiKey, model = 'sonic-3', voice, language, fetch, timeoutMs, base = BASE }) {
  if (!voice) throw new EngineError('config', 'Cartesia needs a voice: set tts_voice to a Cartesia voice ID.')
  const res = await providerFetch(`${base}/tts/bytes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'cartesia-version': CARTESIA_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: model,
      transcript: text,
      voice: { mode: 'id', id: voice },
      output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
      ...(language && language !== 'auto' ? { language } : {}),
    }),
  }, { label: LABEL, keySetting: 'cartesia_api_key (or CARTESIA_API_KEY)', fetch, timeoutMs })
  return readBuffer(res, LABEL)
}
