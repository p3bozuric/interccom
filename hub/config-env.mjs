// The hub config a session sends on connect. Every setting has one name, used everywhere:
// the Claude Code plugin settings, ~/.interccom/config.json (written by `interccom setup`,
// for agents without a settings screen) and an INTERCCOM_<NAME> environment variable.
// Precedence: plugin setting / INTERCCOM_* variable, then config.json, then the default.
// API keys are never read from config.json: plugin setting, INTERCCOM_*, then the provider's
// own variable (DEEPGRAM_API_KEY, ...), then on Windows the saved user environment.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveKey } from './keys.mjs'
import { PROVIDERS } from './engines/index.mjs'

// setting name -> hub config field. Env variable: INTERCCOM_ + upper-case setting name.
export const SETTINGS = {
  tts_engine: 'ttsEngine',
  stt_engine: 'sttEngine',
  tts_voice: 'voiceId',
  tts_model: 'ttsModel',
  stt_model: 'sttModel',
  stt_language: 'sttLanguage',
  listen_mode: 'listenMode',
  local_tts_url: 'localTtsUrl',
  local_stt_url: 'localSttUrl',
  tts_command: 'ttsCommand',
  stt_command: 'sttCommand',
}
// Older names still honoured.
const ALIASES = { tts_voice: ['INTERCCOM_VOICE_ID'] }

export const envName = setting => `INTERCCOM_${setting.toUpperCase()}`

export function configFile(env = process.env) {
  return path.join(env.INTERCCOM_STATE_DIR || path.join(os.homedir(), '.interccom'), 'config.json')
}

export function readConfigFile(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export function configFromEnv(env = process.env, platform = process.platform, { file = readConfigFile(configFile(env)), readRegistry } = {}) {
  const config = {}
  for (const [setting, field] of Object.entries(SETTINGS)) {
    const fromEnv = [envName(setting), ...(ALIASES[setting] ?? [])].map(n => env[n]).find(v => v !== undefined && String(v).trim() !== '')
    const v = fromEnv ?? file[setting]
    if (v !== undefined && v !== null && String(v).trim() !== '') config[field] = String(v).trim()
  }
  const muted = env.INTERCCOM_MUTED ?? (file.muted === undefined ? undefined : String(file.muted))
  if (muted === 'true' || muted === 'false') config.muted = muted === 'true'

  for (const p of Object.values(PROVIDERS)) {
    if (!p.key) continue
    // ElevenLabs's plugin key has always arrived as INTERCCOM_API_KEY.
    const configKey = env[envName(p.setting)] || (p.key === 'apiKey' ? env.INTERCCOM_API_KEY : '')
    const key = env.INTERCCOM_NO_KEY_FALLBACK
      ? configKey || ''
      : resolveKey({ configKey, envName: p.env, env, platform, ...(readRegistry ? { readRegistry } : {}) })
    if (key) config[p.key] = key
  }
  return config
}
