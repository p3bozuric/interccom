// Pure helpers for starting hub/connect.mjs. No imports: tests load this file straight into Node.

export function isMuted(opts: Record<string, unknown>): boolean {
  return opts.muted === true || opts.muted === 'true'
}

export function baseName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? 'session'
}

export function linkEnv(opts: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  const key = String(opts.elevenlabs_api_key ?? '').trim()
  if (key) env.INTERCCOM_API_KEY = key
  const pairs: [string, string][] = [
    ['voice_id', 'INTERCCOM_VOICE_ID'],
    ['tts_model', 'INTERCCOM_TTS_MODEL'],
    ['stt_language', 'INTERCCOM_STT_LANGUAGE'],
    ['listen_mode', 'INTERCCOM_LISTEN_MODE'],
    ['tts_engine', 'INTERCCOM_TTS_ENGINE'],
    ['stt_engine', 'INTERCCOM_STT_ENGINE'],
    ['local_tts_url', 'INTERCCOM_LOCAL_TTS_URL'],
    ['local_tts_model', 'INTERCCOM_LOCAL_TTS_MODEL'],
    ['local_tts_voice', 'INTERCCOM_LOCAL_TTS_VOICE'],
    ['local_stt_url', 'INTERCCOM_LOCAL_STT_URL'],
    ['local_stt_model', 'INTERCCOM_LOCAL_STT_MODEL'],
    ['tts_command', 'INTERCCOM_TTS_COMMAND'],
    ['stt_command', 'INTERCCOM_STT_COMMAND'],
  ]
  for (const [opt, name] of pairs) {
    const v = opts[opt]
    if (v !== undefined && v !== null && String(v).trim() !== '') env[name] = String(v).trim()
  }
  env.INTERCCOM_MUTED = isMuted(opts) ? 'true' : 'false'
  return env
}
