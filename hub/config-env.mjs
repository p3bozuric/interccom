// The hub config a session sends on connect, from INTERCCOM_* variables (set by the
// Claude Code plugin from its settings, or by hand in another agent's MCP config).
import { resolveApiKey } from './keys.mjs'

export function configFromEnv(env = process.env, platform = process.platform) {
  const apiKey = env.INTERCCOM_NO_KEY_FALLBACK
    ? env.INTERCCOM_API_KEY || ''
    : resolveApiKey({ configKey: env.INTERCCOM_API_KEY, env, platform })
  const config = {}
  if (apiKey) config.apiKey = apiKey
  if (env.INTERCCOM_VOICE_ID) config.voiceId = env.INTERCCOM_VOICE_ID
  if (env.INTERCCOM_TTS_MODEL) config.ttsModel = env.INTERCCOM_TTS_MODEL
  if (env.INTERCCOM_STT_LANGUAGE) config.sttLanguage = env.INTERCCOM_STT_LANGUAGE
  if (env.INTERCCOM_LISTEN_MODE) config.listenMode = env.INTERCCOM_LISTEN_MODE
  const passthrough = {
    INTERCCOM_TTS_ENGINE: 'ttsEngine', INTERCCOM_STT_ENGINE: 'sttEngine',
    INTERCCOM_LOCAL_TTS_URL: 'localTtsUrl', INTERCCOM_LOCAL_TTS_MODEL: 'localTtsModel', INTERCCOM_LOCAL_TTS_VOICE: 'localTtsVoice',
    INTERCCOM_LOCAL_STT_URL: 'localSttUrl', INTERCCOM_LOCAL_STT_MODEL: 'localSttModel',
    INTERCCOM_TTS_COMMAND: 'ttsCommand', INTERCCOM_STT_COMMAND: 'sttCommand',
  }
  for (const [name, field] of Object.entries(passthrough)) if (env[name]) config[field] = env[name]
  if (env.INTERCCOM_MUTED === 'true' || env.INTERCCOM_MUTED === 'false') config.muted = env.INTERCCOM_MUTED === 'true'
  return config
}
