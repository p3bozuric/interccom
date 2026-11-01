// Per-session CLI: node hub/connect.mjs --name <n> --cwd <dir> --pid <n>
// Ensures the hub, configures it, registers this session, then copies the
// hub's NDJSON event stream to stdout (first line: {type:'link', ...}).
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensureHub } from './launch.mjs'
import { resolveApiKey } from './keys.mjs'

const out = o => process.stdout.write(JSON.stringify(o) + '\n')

async function main() {
  const { values } = parseArgs({ options: {
    name: { type: 'string' }, cwd: { type: 'string' }, pid: { type: 'string' },
  } })
  const env = process.env
  const stateDir = env.INTERCCOM_STATE_DIR || path.join(os.homedir(), '.interccom')
  const hubEntry = fileURLToPath(new URL('./main.mjs', import.meta.url))
  const { port, token } = await ensureHub({ stateDir, hubEntry })
  const base = `http://127.0.0.1:${port}`
  const headers = { 'x-interccom-token': token, 'content-type': 'application/json' }
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`POST ${p} failed: ${res.status}`)
    return res.json()
  }

  const apiKey = env.INTERCCOM_NO_KEY_FALLBACK
    ? env.INTERCCOM_API_KEY || ''
    : resolveApiKey({ configKey: env.INTERCCOM_API_KEY, env, platform: process.platform })
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
  await post('/config', config)

  const { sessionId, name } = await post('/sessions', {
    name: values.name, cwd: values.cwd, pid: Number(values.pid),
  })
  out({ type: 'link', port, token, sessionId, name })

  const res = await fetch(`${base}/events?session=${encodeURIComponent(sessionId)}`, { headers })
  if (!res.ok) throw new Error(`GET /events failed: ${res.status}`)
  // The link line is out, so a broken body (hub gone, idle timeout) is a normal
  // end: exit 0 quietly and let the session restart the link.
  try {
    for await (const chunk of res.body) process.stdout.write(chunk)
  } catch { /* stream ended */ }
}

main().then(() => process.exit(0), err => {
  out({ type: 'error', message: String(err?.message ?? err) })
  process.exit(1)
})
