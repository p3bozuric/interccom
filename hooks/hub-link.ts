import type { EngineInterface } from 'claude-code'
import { createDelivery, heardText, makeTag } from './delivery.ts'
import { baseName, linkEnv } from './link-env.ts'
import { BACKOFF_START_MS, restartBackoff } from './backoff.ts'

// The session's link to the hub: runs hub/connect.mjs for as long as the session
// lives, keeps the hub's port and token from its first line, and turns the hub's
// events into status, toasts and heard text. Restarts it if it dies, backing off
// from 2 s up to 60 s while it keeps failing.
// Heard text goes through `delivery`: idle, it is sent as the person's message;
// mid-turn it waits for register.ts to hand it to the model as a tagged voice note.

export type Link = { port: number; token: string; sessionId: string; name: string }
export type Role = 'worker' | 'coordinator'

const ERROR_DEDUPE_MS = 60_000

// Module state: starts over on a hot reload.
let link: Link | undefined
let generation = 0
let stopStream: (() => void) | undefined
let restartWait = BACKOFF_START_MS
let linkedAt = 0 // when the current link's first line arrived; 0 before that
let lastError = ''
let lastErrorAt = 0
let role: Role = 'worker'
// Survives link restarts (a new hub, a reconnect): the session claims the role again.
let wantCoordinator = false
let setupChecked = false // the first-run check runs once per session
let mic: Mic = 'not connected'
let cue = 'waiting'
let powered = true // false while interccom is switched off (the bar's Turn off)
let speaking = false // the person's voice is coming in right now
const levels: number[] = [] // its recent loudness, 0..1, newest last: the bar's sound wave
const WAVE_WIDTH = 8
// A name the person gave (/interccom name, /rename): kept when the link restarts.
let chosenName = ''
export const voiceTag = makeTag()
export const delivery = createDelivery(voiceTag)

export function currentLink(): Link | undefined {
  return link
}

export function currentRole(): Role {
  return role
}

// A command given as the session opens (claude "/interccom coordinator") can run before the
// link is up: wait for it a few seconds rather than fail.
export async function linkReady($: EngineInterface, ms = 8000): Promise<Link | undefined> {
  for (let waited = 0; !link && waited < ms; waited += 250) await $.clock.sleep(250)
  return link
}

// Ask the hub for a role. Throws the hub's refusal (another coordinator) so the command can show it.
export async function requestRole($: EngineInterface, wanted: Role, takeover: boolean): Promise<Role> {
  const id = (await linkReady($))?.sessionId
  if (!id) throw new Error('not connected to the hub yet; try again in a moment.')
  await hubCall($, 'POST', `/sessions/${encodeURIComponent(id)}/role`, { role: wanted, takeover })
  role = wanted
  wantCoordinator = wanted === 'coordinator'
  return role
}

async function reclaimRole($: EngineInterface): Promise<void> {
  try {
    await requestRole($, 'coordinator', false)
  } catch (err) {
    role = 'worker'
    wantCoordinator = false
    toastError($, `no longer the coordinator (${String((err as Error)?.message ?? err).slice(0, 120)})`)
  }
}

// Once per session: if speech can't work yet, say what's missing and where to fix it.
async function firstRunCheck($: EngineInterface): Promise<void> {
  try {
    const report = (await hubCall($, 'GET', '/setup')) as { ok?: unknown; problems?: unknown[] }
    if (report.ok === false && report.problems?.length) {
      toastError($, `not set up yet: ${String(report.problems[0]).slice(0, 110)} Run /interccom setup.`)
    }
  } catch { /* an old hub without /setup: nothing to say */ }
}

// Submit as the plugin's message, not the person's: Claude reads it framed as
// "The interccom plugin sent a message: ..." (asUser left out; the API has no asUser: false).
async function submitReport($: EngineInterface, text: string): Promise<void> {
  await $.prompt.submit({ text })
}

export async function deliverReports($: EngineInterface, text: string | undefined): Promise<void> {
  if (text) await submitReport($, text)
}

async function claimName($: EngineInterface, wanted: string): Promise<void> {
  const id = link?.sessionId
  if (!id) return
  try {
    const out = (await hubCall($, 'POST', `/sessions/${encodeURIComponent(id)}/name`, { name: wanted })) as { name?: unknown }
    setLinkName(String(out.name ?? wanted))
  } catch (err) {
    toastError($, `couldn't use the session's name (${String((err as Error)?.message ?? err).slice(0, 120)})`)
  }
}

export function setLinkName(name: string): void {
  chosenName = name
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

export type Mic = 'on' | 'paused' | 'not connected'

// One plain word for the status line: Talking, Listening (your voice is coming in, or "Hey Claude"
// is waiting for the rest), Processing (being transcribed), Waiting, Mic off or Not connected.
export function micStatus(m: Mic, c: string): string {
  if (c === 'talking') return 'Talking'
  if (m === 'paused') return 'Mic off'
  if (m === 'not connected') return 'Not connected'
  if (c === 'listening') return 'Listening'
  if (c === 'processing') return 'Processing'
  return 'Waiting'
}

export function isTalking(): boolean {
  return cue === 'talking'
}

export function isMicOn(): boolean {
  return mic === 'on'
}

export function isMicPaused(): boolean {
  return mic === 'paused'
}

export function isPowered(): boolean {
  return powered
}

export function currentStatus(): string {
  return powered ? micStatus(mic, cue) : 'Off'
}

// A little sound wave from recent loudness, newest on the right: "▁▂▅▇▆▃▁▁".
export function waveText(values: readonly number[], width = WAVE_WIDTH): string {
  const bars = '▁▂▃▄▅▆▇█'
  const recent = values.slice(-width)
  const padded = [...Array(Math.max(0, width - recent.length)).fill(0), ...recent]
  return padded.map(v => bars[Math.round(Math.min(1, Math.max(0, v)) * (bars.length - 1))]).join('')
}

// The bar's wave while the person speaks, or '' when they don't. Scaled to the loudest recent
// level (never below 0.3, so near-silence stays flat): a quiet voice still draws a shape.
export function currentWave(): string {
  if (!powered || !speaking) return ''
  const peak = Math.max(0.3, ...levels)
  return waveText(levels.map(v => v / peak))
}

function showMic($: EngineInterface): void {
  $.ui.status(currentStatus())
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
    // A new hub starts on; a hub that is off says so on the event stream.
    powered = true
    // A new registration starts idle, as a worker, on the hub: bring it up to date.
    reportBusy($, delivery.isBusy())
    // A name chosen while the link was starting (the session's title arrives at about the same time).
    if (chosenName && chosenName !== link.name) await claimName($, chosenName)
    role = 'worker'
    if (wantCoordinator) await reclaimRole($)
    if (!setupChecked) { setupChecked = true; void firstRunCheck($) }
  } else if (msg.type === 'hello') {
    if (link && typeof msg.name === 'string') link = { ...link, name: msg.name }
  } else if (msg.type === 'heard') {
    const text = String(msg.text ?? '').trim()
    const addressed = typeof msg.addressed === 'string' ? msg.addressed : undefined
    if (text) await deliverHeard($, heardText(text, addressed))
  } else if (msg.type === 'report') {
    const r = { from: String(msg.from ?? ''), priority: String(msg.priority ?? 'status'), text: String(msg.text ?? '').trim() }
    if (r.text && delivery.report(r) === 'submit') await submitReport($, delivery.formatOne(r))
  } else if (msg.type === 'role') {
    role = msg.role === 'coordinator' ? 'coordinator' : 'worker'
    wantCoordinator = role === 'coordinator'
    $.ui.toast(`interccom: this session is now a ${role}${msg.reason ? ` (${String(msg.reason).slice(0, 100)})` : ''}.`)
  } else if (msg.type === 'mic') {
    mic = msg.state === 'listening' ? 'on' : msg.reason === 'paused' ? 'paused' : 'not connected'
    showMic($)
    $.ui.invalidate('ui.render')
  } else if (msg.type === 'cue') {
    cue = String(msg.state ?? 'waiting')
    speaking = msg.speaking === true
    if (!speaking) levels.length = 0
    showMic($)
    // The band above the prompt shows the same word, and Stop while it talks.
    $.ui.invalidate('ui.render')
  } else if (msg.type === 'level') {
    if (!speaking) return
    levels.push(Number(msg.v) || 0)
    if (levels.length > WAVE_WIDTH) levels.shift()
    $.ui.invalidate('ui.render')
  } else if (msg.type === 'power') {
    powered = msg.on !== false
    if (!powered) { speaking = false; levels.length = 0 }
    showMic($)
    $.ui.invalidate('ui.render')
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
  const argv = ['node', `${$.plugin.root}/hub/connect.mjs`, '--name', chosenName || baseName(cwd), '--cwd', cwd, '--pid', '0']
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

// The hub said no: its status and its own words, for a command to show as they are.
export class HubRefusal extends Error {
  readonly status: number
  readonly reason: string
  constructor(status: number, reason: string, what: string) {
    super(`interccom hub refused ${what}: ${status}${reason ? ` ${reason}` : ''}`)
    this.status = status
    this.reason = reason
  }
}

export async function hubCall($: EngineInterface, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!link) throw new Error('not connected to the hub yet; try again in a moment.')
  const res = await $.http.fetch(`http://127.0.0.1:${link.port}${path}`, {
    method,
    headers: { 'x-interccom-token': link.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let parsed: unknown
  try { parsed = res.text ? JSON.parse(res.text) : {} } catch { parsed = undefined }
  if (!res.ok) {
    const reason = (parsed as { error?: unknown } | undefined)?.error
    throw new HubRefusal(res.status, reason ? String(reason) : '', `${method} ${path}`)
  }
  return parsed
}
