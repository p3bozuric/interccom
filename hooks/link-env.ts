// Pure helpers for starting hub/connect.mjs. No imports: tests load this file straight into Node.

export function isMuted(opts: Record<string, unknown>): boolean {
  return opts.muted === true || opts.muted === 'true'
}

export function baseName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? 'session'
}

// Plugin settings the hub uses. Each reaches connect.mjs as INTERCCOM_<NAME> (see hub/config-env.mjs).
export const HUB_SETTINGS = [
  'tts_engine', 'stt_engine', 'tts_voice', 'tts_model', 'stt_model', 'stt_language', 'listen_mode',
  'local_tts_url', 'local_stt_url', 'tts_command', 'stt_command',
  'deepgram_api_key', 'soniox_api_key', 'openai_api_key', 'groq_api_key', 'cartesia_api_key',
] as const

function value(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

export function linkEnv(opts: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  // ElevenLabs's key has always been passed as INTERCCOM_API_KEY.
  const key = value(opts.elevenlabs_api_key)
  if (key) env.INTERCCOM_API_KEY = key
  for (const name of HUB_SETTINGS) {
    // voice_id is the old name of tts_voice.
    const v = value(opts[name]) || (name === 'tts_voice' ? value(opts.voice_id) : '')
    if (v) env[`INTERCCOM_${name.toUpperCase()}`] = v
  }
  env.INTERCCOM_MUTED = isMuted(opts) ? 'true' : 'false'
  return env
}
