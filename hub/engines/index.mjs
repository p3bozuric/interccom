// Picks the speech engines from the hub config: elevenlabs (cloud), local (an
// OpenAI-compatible server on this machine or LAN) or command (any CLI program).
// A new engine is one module with tts(text, opts) -> audio Buffer and
// stt(wav, opts) -> text, plus a case here.
import * as elevenlabs from './elevenlabs.mjs'
import * as local from './local.mjs'
import * as command from './command.mjs'

const { EngineError } = elevenlabs
export const ENGINES = new Set(['elevenlabs', 'local', 'command'])
const NO_KEY = 'No ElevenLabs API key configured. Set it in /plugin settings for interccom or in ELEVENLABS_API_KEY, or switch to a local engine.'

export function createEngines({ impl = { elevenlabs, local, command }, cwd } = {}) {
  return {
    tts(text, cfg) {
      switch (cfg.ttsEngine) {
        case 'local': return impl.local.tts(text, { url: cfg.localTtsUrl, model: cfg.localTtsModel, voice: cfg.localTtsVoice })
        case 'command':
          if (!cfg.ttsCommand) throw new EngineError('config', 'tts_engine is command, but tts_command is empty.')
          return impl.command.tts(text, { command: cfg.ttsCommand, cwd })
        default:
          if (!cfg.apiKey) throw new EngineError('auth', NO_KEY)
          return impl.elevenlabs.tts(text, { apiKey: cfg.apiKey, voiceId: cfg.voiceId, modelId: cfg.ttsModel })
      }
    },
    stt(wav, cfg) {
      switch (cfg.sttEngine) {
        case 'local': return impl.local.stt(wav, { url: cfg.localSttUrl, model: cfg.localSttModel, language: cfg.sttLanguage })
        case 'command':
          if (!cfg.sttCommand) throw new EngineError('config', 'stt_engine is command, but stt_command is empty.')
          return impl.command.stt(wav, { command: cfg.sttCommand, cwd })
        default:
          if (!cfg.apiKey) throw new EngineError('auth', NO_KEY)
          return impl.elevenlabs.stt(wav, { apiKey: cfg.apiKey, model: cfg.sttModel, language: cfg.sttLanguage })
      }
    },
    // Whether listening can work at all: the mic stays off until it can.
    sttReady(cfg) {
      if (cfg.sttEngine === 'local') return Boolean(cfg.localSttUrl)
      if (cfg.sttEngine === 'command') return Boolean(cfg.sttCommand)
      return Boolean(cfg.apiKey)
    },
  }
}

// What ffplay is handed: name the temp file after what the engine actually returned.
export function audioExt(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'RIFF') return 'wav'
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS') return 'ogg'
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'fLaC') return 'flac'
  return 'mp3'
}
