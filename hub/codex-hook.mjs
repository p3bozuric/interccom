// interccom codex-hook: one Codex command hook for SessionStart, UserPromptSubmit,
// PostToolUse and Stop. Reads the hook JSON on stdin, tells the hub, and prints what the
// hub wants injected (guidance, a voice note, or a Stop block). It never starts a hub,
// never fails the hook, and prints nothing when there is nothing to say.
import os from 'node:os'
import path from 'node:path'
import { probe } from './launch.mjs'
import { CODEX_EVENTS, hookOutput } from './hosts/codex.mjs'

export async function codexHook(input, { env = process.env, find = probe, fetchFn = globalThis.fetch } = {}) {
  let ev
  try { ev = JSON.parse(input) } catch { return '' }
  const event = CODEX_EVENTS[ev?.hook_event_name]
  if (!event || !ev.session_id) return ''
  const stateDir = env.INTERCCOM_STATE_DIR || path.join(os.homedir(), '.interccom')
  // Only a hub that proves it holds the recorded token ever receives it.
  const hub = await find(stateDir).catch(() => null)
  if (!hub) return ''
  try {
    const res = await fetchFn(`http://127.0.0.1:${hub.port}/host/event`, {
      method: 'POST',
      headers: { 'x-interccom-token': hub.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        host: 'codex', hostSessionId: String(ev.session_id), cwd: String(ev.cwd ?? ''),
        event, stopHookActive: Boolean(ev.stop_hook_active),
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return ''
    return hookOutput(ev.hook_event_name, await res.json())
  } catch {
    return ''
  }
}

export async function runCodexHook() {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  const out = await codexHook(input).catch(() => '')
  if (out) process.stdout.write(out + '\n')
  process.exit(0)
}
