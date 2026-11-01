// Speech engines. Talking (TTS) and listening (STT) are chosen separately from:
//   cloud:  elevenlabs, deepgram, soniox, openai, groq (STT only), cartesia (TTS only)
//   local:  local   - any server with the OpenAI audio API on this machine or LAN
//           command - any program (Piper, whisper.cpp's whisper-cli, ...)
// A new provider is one module with tts(text, opts) -> audio Buffer and/or
// stt(wav, opts) -> text, plus an entry in PROVIDERS.
import * as elevenlabs from './elevenlabs.mjs'
import * as local from './local.mjs'
import * as command from './command.mjs'
import * as deepgram from './deepgram.mjs'
import * as soniox from './soniox.mjs'
import * as cartesia from './cartesia.mjs'

const { EngineError } = elevenlabs

// What each engine can do and its defaults. `key` is the hub config field holding its API
// key; `setting` is what the person sets (plugin setting, then environment variable).
export const PROVIDERS = {
  elevenlabs: {
    label: 'ElevenLabs', key: 'apiKey', setting: 'elevenlabs_api_key', env: 'ELEVENLABS_API_KEY', signup: 'elevenlabs.io (API key with Text to Speech and Speech to Text)',
    tts: { model: 'eleven_flash_v2_5', voice: '21m00Tcm4TlvDq8ikWAM' }, stt: { model: 'scribe_v1' },
  },
  deepgram: {
    label: 'Deepgram', key: 'deepgramKey', setting: 'deepgram_api_key', env: 'DEEPGRAM_API_KEY', signup: 'console.deepgram.com',
    tts: { model: 'aura-2-thalia-en', voice: '' }, stt: { model: 'nova-3' },
  },
  soniox: {
    label: 'Soniox', key: 'sonioxKey', setting: 'soniox_api_key', env: 'SONIOX_API_KEY', signup: 'console.soniox.com',
    tts: { model: 'tts-rt-v2', voice: 'Adrian' }, stt: { model: 'stt-async-v5' },
  },
  openai: {
    label: 'OpenAI', key: 'openaiKey', setting: 'openai_api_key', env: 'OPENAI_API_KEY', signup: 'platform.openai.com',
    url: 'https://api.openai.com/v1',
    tts: { model: 'gpt-4o-mini-tts', voice: 'alloy' }, stt: { model: 'gpt-4o-mini-transcribe' },
  },
  groq: {
    label: 'Groq', key: 'groqKey', setting: 'groq_api_key', env: 'GROQ_API_KEY', signup: 'console.groq.com',
    url: 'https://api.groq.com/openai/v1',
    stt: { model: 'whisper-large-v3-turbo' },
  },
  cartesia: {
    label: 'Cartesia', key: 'cartesiaKey', setting: 'cartesia_api_key', env: 'CARTESIA_API_KEY', signup: 'play.cartesia.ai',
    // The voice from Cartesia's own SDK example; pick yours at play.cartesia.ai.
    tts: { model: 'sonic-3', voice: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b' },
  },
  local: {
    label: 'Local speech server',
    tts: { model: 'kokoro', voice: 'af_heart' }, stt: { model: 'Systran/faster-whisper-small' },
  },
  command: { label: 'Command', tts: {}, stt: {} },
}

export const ENGINES = new Set(Object.keys(PROVIDERS))
export const TTS_ENGINES = Object.keys(PROVIDERS).filter(k => PROVIDERS[k].tts)
export const STT_ENGINES = Object.keys(PROVIDERS).filter(k => PROVIDERS[k].stt)
export const KEY_FIELDS = Object.values(PROVIDERS).map(p => p.key).filter(Boolean)

function engineOf(cfg, dir) {
  return dir === 'tts' ? (cfg.ttsEngine || 'elevenlabs') : (cfg.sttEngine || 'elevenlabs')
}

// The model and voice an engine will actually use: the person's choice, else the engine's default.
export function resolved(cfg, dir) {
  const engine = engineOf(cfg, dir)
  const d = PROVIDERS[engine]?.[dir] ?? {}
  return dir === 'tts'
    ? { engine, model: cfg.ttsModel || d.model || '', voice: cfg.voiceId || d.voice || '' }
    : { engine, model: cfg.sttModel || d.model || '' }
}

// Why this direction can't work right now, in words the person can act on; '' when it can.
export function problem(cfg, dir) {
  const engine = engineOf(cfg, dir)
  const p = PROVIDERS[engine]
  const what = dir === 'tts' ? 'talking' : 'listening'
  if (!p || !p[dir]) return `${engine} can't do ${what}. Choose another ${dir}_engine.`
  if (p.key && !cfg[p.key]) return `No ${p.label} API key. Set ${p.setting} in the interccom settings, or ${p.env}. Get one at ${p.signup}.`
  if (engine === 'local' && !(dir === 'tts' ? cfg.localTtsUrl : cfg.localSttUrl)) return `Set local_${dir}_url to your local speech server.`
  if (engine === 'command' && !(dir === 'tts' ? cfg.ttsCommand : cfg.sttCommand)) return `${dir}_engine is command, but ${dir}_command is empty.`
  if (engine === 'cartesia' && !resolved(cfg, 'tts').voice) return 'Cartesia needs a voice: set tts_voice to a Cartesia voice ID.'
  return ''
}

export function createEngines({ impl = { elevenlabs, local, command, deepgram, soniox, cartesia }, cwd } = {}) {
  function guard(cfg, dir) {
    const why = problem(cfg, dir)
    if (why) throw new EngineError(why.startsWith('No ') ? 'auth' : 'config', why)
  }
  return {
    tts(text, cfg) {
      guard(cfg, 'tts')
      const { engine, model, voice } = resolved(cfg, 'tts')
      const lang = cfg.sttLanguage && cfg.sttLanguage !== 'auto' ? cfg.sttLanguage : 'en'
      switch (engine) {
        case 'local': return impl.local.tts(text, { url: cfg.localTtsUrl, model, voice })
        case 'openai': return impl.local.tts(text, { url: PROVIDERS.openai.url, model, voice, apiKey: cfg.openaiKey, label: 'OpenAI', keySetting: 'openai_api_key (or OPENAI_API_KEY)', timeoutMs: 20_000 })
        case 'command': return impl.command.tts(text, { command: cfg.ttsCommand, cwd })
        case 'deepgram': return impl.deepgram.tts(text, { apiKey: cfg.deepgramKey, model })
        case 'soniox': return impl.soniox.tts(text, { apiKey: cfg.sonioxKey, model, voice, language: lang })
        case 'cartesia': return impl.cartesia.tts(text, { apiKey: cfg.cartesiaKey, model, voice, language: lang })
        default: return impl.elevenlabs.tts(text, { apiKey: cfg.apiKey, voiceId: voice, modelId: model })
      }
    },
    stt(wav, cfg) {
      guard(cfg, 'stt')
      const { engine, model } = resolved(cfg, 'stt')
      const language = cfg.sttLanguage
      switch (engine) {
        case 'local': return impl.local.stt(wav, { url: cfg.localSttUrl, model, language })
        case 'openai': return impl.local.stt(wav, { url: PROVIDERS.openai.url, model, language, apiKey: cfg.openaiKey, label: 'OpenAI', keySetting: 'openai_api_key (or OPENAI_API_KEY)', timeoutMs: 20_000 })
        case 'groq': return impl.local.stt(wav, { url: PROVIDERS.groq.url, model, language, apiKey: cfg.groqKey, label: 'Groq', keySetting: 'groq_api_key (or GROQ_API_KEY)', timeoutMs: 20_000 })
        case 'command': return impl.command.stt(wav, { command: cfg.sttCommand, cwd })
        case 'deepgram': return impl.deepgram.stt(wav, { apiKey: cfg.deepgramKey, model, language })
        case 'soniox': return impl.soniox.stt(wav, { apiKey: cfg.sonioxKey, model, language })
        default: return impl.elevenlabs.stt(wav, { apiKey: cfg.apiKey, model, language })
      }
    },
    // Whether listening can work at all: the mic stays off until it can.
    sttReady: cfg => !problem(cfg, 'stt'),
  }
}

// What ffplay is handed: name the temp file after what the engine actually returned.
export function audioExt(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'RIFF') return 'wav'
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS') return 'ogg'
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'fLaC') return 'flac'
  return 'mp3'
}
