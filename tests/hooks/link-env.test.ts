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
