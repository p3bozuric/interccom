import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseName, linkEnv, isMuted } from '../../hooks/link-env.ts'

test('linkEnv maps every option', () => {
  assert.deepEqual(linkEnv({
    elevenlabs_api_key: 'k', voice_id: 'v', tts_model: 'm', stt_language: 'hr', listen_mode: 'always', muted: true,
  }), {
    INTERCCOM_API_KEY: 'k', INTERCCOM_VOICE_ID: 'v', INTERCCOM_TTS_MODEL: 'm',
    INTERCCOM_STT_LANGUAGE: 'hr', INTERCCOM_LISTEN_MODE: 'always', INTERCCOM_MUTED: 'true',
  })
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

test('linkEnv passes the local engine settings through', () => {
  const env = linkEnv({
    tts_engine: 'local', stt_engine: 'command', local_tts_url: 'http://127.0.0.1:8880/v1', local_tts_model: 'kokoro',
    local_tts_voice: 'af_heart', local_stt_url: 'http://127.0.0.1:8000/v1', local_stt_model: 'w',
    tts_command: 'piper --output_file {out}', stt_command: ' whisper-cli -f {in} ',
  })
  assert.equal(env.INTERCCOM_TTS_ENGINE, 'local')
  assert.equal(env.INTERCCOM_STT_ENGINE, 'command')
  assert.equal(env.INTERCCOM_LOCAL_TTS_URL, 'http://127.0.0.1:8880/v1')
  assert.equal(env.INTERCCOM_LOCAL_TTS_MODEL, 'kokoro')
  assert.equal(env.INTERCCOM_LOCAL_TTS_VOICE, 'af_heart')
  assert.equal(env.INTERCCOM_LOCAL_STT_URL, 'http://127.0.0.1:8000/v1')
  assert.equal(env.INTERCCOM_LOCAL_STT_MODEL, 'w')
  assert.equal(env.INTERCCOM_TTS_COMMAND, 'piper --output_file {out}')
  assert.equal(env.INTERCCOM_STT_COMMAND, 'whisper-cli -f {in}')
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
