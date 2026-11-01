// Per-session CLI: node hub/connect.mjs --name <n> --cwd <dir> --pid <n>
// Ensures the hub, configures it, registers this session, then copies the
// hub's NDJSON event stream to stdout (first line: {type:'link', ...}).
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensureHub } from './launch.mjs'
import { configFromEnv } from './config-env.mjs'

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

  const config = configFromEnv(env)
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
