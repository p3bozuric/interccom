import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseName, linkEnv, isMuted } from '../../hooks/link-env.ts'

test('linkEnv maps every option', () => {
  assert.deepEqual(linkEnv({
    elevenlabs_api_key: 'k', tts_voice: 'v', tts_model: 'm', stt_language: 'hr', listen_mode: 'always', muted: true,
  }), {
    INTERCCOM_API_KEY: 'k', INTERCCOM_TTS_VOICE: 'v', INTERCCOM_TTS_MODEL: 'm',
    INTERCCOM_STT_LANGUAGE: 'hr', INTERCCOM_LISTEN_MODE: 'always', INTERCCOM_MUTED: 'true',
  })
  // voice_id is the old name of tts_voice.
  assert.equal(linkEnv({ voice_id: 'old' }).INTERCCOM_TTS_VOICE, 'old')
  assert.equal(linkEnv({ voice_id: 'old', tts_voice: 'new' }).INTERCCOM_TTS_VOICE, 'new')
})

test('linkEnv omits an empty key and drops blank values', () => {
  const env = linkEnv({ elevenlabs_api_key: '  ', voice_id: '', tts_model: null, stt_language: ' ', listen_mode: undefined })
  assert.deepEqual(env, { INTERCCOM_MUTED: 'false' })
})

test('linkEnv always sets MUTED, accepting true or "true"', () => {
  assert.equal(linkEnv({}).INTERCCOM_MUTED, 'false')
  assert.equal(linkEnv({ muted: false }).INTERCCOM_MUTED, 'false')
  assert.equal(linkEnv({ muted: 'false' }).INTERCCOM_MUTED, 'false')
  assert.equal(linkEnv({ muted: 'true' }).INTERCCOM_MUTED, 'true')
  assert.equal(linkEnv({ muted: true }).INTERCCOM_MUTED, 'true')
})

test('isMuted accepts true or "true" only', () => {
  assert.equal(isMuted({ muted: true }), true)
  assert.equal(isMuted({ muted: 'true' }), true)
  assert.equal(isMuted({ muted: 'false' }), false)
  assert.equal(isMuted({ muted: 1 }), false)
  assert.equal(isMuted({}), false)
})

test('baseName handles slashes, backslashes and trailing separators', () => {
  assert.equal(baseName('C:\\Users\\user\\proj'), 'proj')
  assert.equal(baseName('C:\\Users\\user\\proj\\'), 'proj')
  assert.equal(baseName('/home/user/proj/'), 'proj')
  assert.equal(baseName('/home/user/proj'), 'proj')
  assert.equal(baseName('C:/mixed\\path//x'), 'x')
  assert.equal(baseName(''), 'session')
  assert.equal(baseName('/'), 'session')
})

test('linkEnv passes engines, models, local servers, commands and every provider key through', () => {
  const env = linkEnv({
    tts_engine: 'deepgram', stt_engine: 'soniox', stt_model: 'stt-async-v5', local_tts_url: 'http://127.0.0.1:8880/v1',
    local_stt_url: 'http://127.0.0.1:8000/v1', tts_command: 'piper --output_file {out}', stt_command: ' whisper-cli -f {in} ',
    deepgram_api_key: 'dg', soniox_api_key: 'sx', openai_api_key: 'oa', groq_api_key: 'gq', cartesia_api_key: 'ca',
  })
  assert.equal(env.INTERCCOM_TTS_ENGINE, 'deepgram')
  assert.equal(env.INTERCCOM_STT_ENGINE, 'soniox')
  assert.equal(env.INTERCCOM_STT_MODEL, 'stt-async-v5')
  assert.equal(env.INTERCCOM_LOCAL_TTS_URL, 'http://127.0.0.1:8880/v1')
  assert.equal(env.INTERCCOM_LOCAL_STT_URL, 'http://127.0.0.1:8000/v1')
  assert.equal(env.INTERCCOM_TTS_COMMAND, 'piper --output_file {out}')
  assert.equal(env.INTERCCOM_STT_COMMAND, 'whisper-cli -f {in}')
  assert.deepEqual([env.INTERCCOM_DEEPGRAM_API_KEY, env.INTERCCOM_SONIOX_API_KEY, env.INTERCCOM_OPENAI_API_KEY,
    env.INTERCCOM_GROQ_API_KEY, env.INTERCCOM_CARTESIA_API_KEY], ['dg', 'sx', 'oa', 'gq', 'ca'])
})

test('every hub-facing setting in plugin.json reaches the hub env', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  const sessionOnly = new Set(['autonomy', 'autonomy_rules'])
  for (const key of Object.keys(manifest.userConfig)) {
    if (sessionOnly.has(key)) continue
    const env = linkEnv({ [key]: key === 'muted' ? true : 'x' })
    assert.ok(Object.keys(env).length > 1 || key === 'muted', `${key} is not passed to the hub`)
  }
})
