// interccom codex-hook / gemini-hook: one command hook per agent for its session start,
// prompt, after-tool and end-of-turn events. Reads the hook JSON on stdin, tells the hub, and
// prints what the hub wants injected (guidance, a voice note, or a block that keeps the turn
// going). It never starts a hub and never fails the hook.
import os from 'node:os'
import path from 'node:path'
import { probe } from './launch.mjs'
import { CODEX_EVENTS, hookOutput } from './hosts/codex.mjs'
import { GEMINI_EVENTS, geminiHookOutput } from './hosts/gemini.mjs'

// Per agent: its event names, its output shape, and what it prints when there is nothing to
// say (Codex: nothing; Gemini parses stdout as JSON, so an empty object).
export const HOOK_HOSTS = {
  codex: { events: CODEX_EVENTS, output: hookOutput, none: '' },
  gemini: { events: GEMINI_EVENTS, output: geminiHookOutput, none: '{}' },
}

export async function hostHook(host, input, { env = process.env, find = probe, fetchFn = globalThis.fetch } = {}) {
  const { events, output, none } = HOOK_HOSTS[host]
  let ev
  try { ev = JSON.parse(input) } catch { return none }
  const event = events[ev?.hook_event_name]
  if (!event || !ev.session_id) return none
  const stateDir = env.INTERCCOM_STATE_DIR || path.join(os.homedir(), '.interccom')
  // Only a hub that proves it holds the recorded token ever receives it.
  const hub = await find(stateDir).catch(() => null)
  if (!hub) return none
  try {
    const res = await fetchFn(`http://127.0.0.1:${hub.port}/host/event`, {
      method: 'POST',
      headers: { 'x-interccom-token': hub.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        host, hostSessionId: String(ev.session_id), cwd: String(ev.cwd ?? ''),
        event, stopHookActive: Boolean(ev.stop_hook_active),
      }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return none
    return output(ev.hook_event_name, await res.json()) || none
  } catch {
    return none
  }
}

export const codexHook = (input, opts) => hostHook('codex', input, opts)
export const geminiHook = (input, opts) => hostHook('gemini', input, opts)

export async function runHostHook(host = 'codex') {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  const out = await hostHook(host, input).catch(() => HOOK_HOSTS[host].none)
  if (out) process.stdout.write(out + '\n')
  process.exit(0)
}

export const runCodexHook = () => runHostHook('codex')
