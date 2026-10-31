import type { EngineInterface } from 'claude-code'
import { createDelivery, makeTag } from './delivery.ts'
import { baseName, linkEnv } from './link-env.ts'
import { BACKOFF_START_MS, restartBackoff } from './backoff.ts'

// The session's link to the hub: runs hub/connect.mjs for as long as the session
// lives, keeps the hub's port and token from its first line, and turns the hub's
// events into status, toasts and heard text. Restarts it if it dies, backing off
// from 2 s up to 60 s while it keeps failing.
// Heard text goes through `delivery`: idle, it is sent as the person's message;
// mid-turn it waits for register.ts to hand it to the model as a tagged voice note.

export type Link = { port: number; token: string; sessionId: string; name: string }

const ERROR_DEDUPE_MS = 60_000

// Module state: starts over on a hot reload.
let link: Link | undefined
let generation = 0
let stopStream: (() => void) | undefined
let restartWait = BACKOFF_START_MS
let linkedAt = 0 // when the current link's first line arrived; 0 before that
let lastError = ''
let lastErrorAt = 0
export const voiceTag = makeTag()
export const delivery = createDelivery(voiceTag)

export function currentLink(): Link | undefined {
  return link
}

export function setLinkName(name: string): void {
  if (link) link = { ...link, name }
}

function toastError($: EngineInterface, message: string): void {
  // A hub that can't start fails the same way every restart: say it once a minute.
  const now = Date.now()
  if (message === lastError && now - lastErrorAt < ERROR_DEDUPE_MS) return
  lastError = message
  lastErrorAt = now
  $.ui.toast(`interccom: ${message.slice(0, 160)}`)
}

// Tell the hub whether this session is mid-turn. Best effort: never blocks or throws.
export function reportBusy($: EngineInterface, busy: boolean): void {
  const id = link?.sessionId
  if (!id) return
  void hubCall($, 'POST', `/sessions/${encodeURIComponent(id)}/state`, { busy }).catch(() => undefined)
}

async function deliverHeard($: EngineInterface, text: string): Promise<void> {
  if (delivery.heard(text) === 'submit') await $.prompt.submit({ text, asUser: true })
  else $.ui.toast(`heard: ${text.slice(0, 80)}`)
}

async function handleLine($: EngineInterface, line: string): Promise<void> {
  let msg: { type?: unknown; [k: string]: unknown }
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === 'link') {
    link = {
      port: Number(msg.port),
      token: String(msg.token ?? ''),
      sessionId: String(msg.sessionId ?? ''),
      name: String(msg.name ?? ''),
    }
    linkedAt = Date.now()
    // A new registration starts idle on the hub: bring it up to date.
    reportBusy($, delivery.isBusy())
  } else if (msg.type === 'hello') {
    if (link && typeof msg.name === 'string') link = { ...link, name: msg.name }
  } else if (msg.type === 'heard') {
    const text = String(msg.text ?? '').trim()
    if (text) await deliverHeard($, text)
  } else if (msg.type === 'mic') {
    $.ui.status(`mic: ${String(msg.state ?? '')}`)
  } else if (msg.type === 'error') {
    toastError($, String(msg.message ?? 'unknown error'))
  }
  // Anything else (the hub's keepalive ping, future types) is ignored silently.
}

async function pump($: EngineInterface, opts: Record<string, unknown>, cwd: string, mine: number,
  stream: AsyncIterable<{ stream?: string; text?: string } | object>): Promise<void> {
  let buf = ''
  try {
    for await (const chunk of stream) {
      if (mine !== generation) break
      if (!('stream' in chunk) || chunk.stream !== 'stdout' || typeof chunk.text !== 'string') continue
      buf += chunk.text
      let nl: number
      while (mine === generation && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        // One failing line never takes the link down or loses the lines after it.
        try {
          await handleLine($, line)
        } catch (err) {
          toastError($, `could not handle a hub event (${String(err).slice(0, 120)})`)
        }
      }
    }
  } catch (err) {
    toastError($, `hub link failed (${String(err).slice(0, 120)})`)
  }
  if (mine !== generation) return // replaced or stopped on purpose
  link = undefined
  const { wait, next } = restartBackoff(restartWait, linkedAt ? Date.now() - linkedAt : 0)
  restartWait = next
  $.clock.after(wait, () => { if (mine === generation) startLink($, opts, cwd) })
}

export function startLink($: EngineInterface, opts: Record<string, unknown>, cwd: string): void {
  stopLink()
  const mine = ++generation
  linkedAt = 0
  const argv = ['node', `${$.plugin.root}/hub/connect.mjs`, '--name', baseName(cwd), '--cwd', cwd, '--pid', '0']
  // cwd is the plugin's own folder: on Windows a bare `node` is looked up in the cwd first.
  const stream = $.process.spawn({ argv, cwd: $.plugin.root, env: linkEnv(opts) })
  stopStream = () => { void stream.return?.(undefined as never) }
  void pump($, opts, cwd, mine, stream)
}

export function stopLink(): void {
  generation++
  stopStream?.()
  stopStream = undefined
  link = undefined
}

export async function hubCall($: EngineInterface, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!link) throw new Error('interccom is not connected to the hub yet; try again in a moment.')
  const res = await $.http.fetch(`http://127.0.0.1:${link.port}${path}`, {
    method,
    headers: { 'x-interccom-token': link.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let parsed: unknown
  try { parsed = res.text ? JSON.parse(res.text) : {} } catch { parsed = undefined }
  if (!res.ok) {
    const reason = (parsed as { error?: unknown } | undefined)?.error
    throw new Error(`interccom hub refused ${method} ${path}: ${res.status}${reason ? ` ${String(reason)}` : ''}`)
  }
  return parsed
}
