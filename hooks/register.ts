import type { Register, EngineInterface } from 'claude-code'
import { guidance } from './guidance.ts'
import { startLink, hubCall, currentLink, setLinkName, reportBusy, delivery, voiceTag } from './hub-link.ts'
import { baseName, isMuted } from './link-env.ts'

// interccom, the session side. Claude gets a `speak` tool whose text goes to the hub,
// which plays one voice for every session in priority order. What the person says
// comes back from the hub: idle, it is sent as their message; mid-turn it rides
// along with the next tool result, or is sent when the turn ends.

type Priority = 'question' | 'heads-up' | 'status'
const PRIORITIES: readonly Priority[] = ['question', 'heads-up', 'status']
const MODES = ['always', 'wake', 'off'] as const

// Module state: starts over on a hot reload.
let options: Record<string, unknown> = {}
let sessionCwd = ''

function currentName(): string {
  return currentLink()?.name || baseName(sessionCwd)
}

function errorText(err: unknown): string {
  return String((err as { message?: unknown } | undefined)?.message ?? err).slice(0, 200)
}

async function listenCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const arg = args.trim().toLowerCase()
  if (!arg) {
    const board = (await hubCall($, 'GET', '/board')) as { mode?: unknown }
    return { text: `Listening mode: ${String(board.mode)}.` }
  }
  if (!(MODES as readonly string[]).includes(arg)) return { text: 'Usage: /listen [always|wake|off]' }
  const out = (await hubCall($, 'POST', '/listen', { mode: arg })) as { mode?: unknown }
  return { text: `Listening mode: ${String(out.mode)}.` }
}

async function interccomCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const usage = { text: 'Usage: /interccom name <name> | /interccom status | /interccom stop' }
  const trimmed = args.trim()
  const [sub = '', ...rest] = trimmed.split(/\s+/)
  if (sub.toLowerCase() === 'name') {
    const wanted = rest.join(' ').trim()
    const id = currentLink()?.sessionId
    if (!wanted) return usage
    if (!id) return { text: 'interccom is not connected to the hub yet; try again in a moment.' }
    const out = (await hubCall($, 'POST', `/sessions/${encodeURIComponent(id)}/name`, { name: wanted })) as { name?: unknown }
    const name = String(out.name ?? wanted)
    setLinkName(name)
    return { text: `This session is now called ${name}.` }
  }
  if (sub.toLowerCase() === 'status') {
    const board = (await hubCall($, 'GET', '/board')) as {
      sessions?: { name?: unknown; busy?: unknown; lastLine?: unknown }[]
    }
    const rows = board.sessions ?? []
    if (!rows.length) return { text: 'No sessions are connected.' }
    return {
      text: rows.map((r) => `${String(r.name)} — ${r.busy ? 'busy' : 'idle'} — ${String(r.lastLine ?? '')}`).join('\n'),
    }
  }
  if (sub.toLowerCase() === 'stop') {
    const out = (await hubCall($, 'POST', '/stop', {})) as { flushed?: unknown }
    return { text: `Stopped. Cleared ${Number(out.flushed ?? 0)} queued updates.` }
  }
  return usage
}

export const register: Register = (on, opts) => {
  options = opts as Record<string, unknown>

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionCwd = e.cwd
    await $.tool.register({
      name: 'speak',
      description:
        'Say something out loud to the person: a short spoken summary, conclusion, or question (1-3 plain sentences, no code or markdown). Returns immediately; audio plays in the background, one voice for all sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to say, as plain spoken English.' },
          priority: {
            type: 'string',
            enum: [...PRIORITIES],
            description: 'question: needs an answer. heads-up: "this will take a while". status: results (the default).',
          },
        },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'listen',
      description: 'Voice input: show or set the listening mode (always, wake, off).',
      argumentHint: '[always|wake|off]',
      immediate: true,
    })
    await $.command.register({
      name: 'interccom',
      description: 'interccom: rename this session, list every connected session, or stop playback.',
      argumentHint: 'name <name> | status | stop',
      immediate: true,
    })
    startLink($, options, e.cwd)
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: 'interccom:guidance', text: guidance(currentName(), voiceTag), scope: 'session' as const }],
    }
  })

  // Track whether the main loop is mid-turn; send anything heard after the last tool call.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      delivery.setBusy(true)
      reportBusy($, true)
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!('agentId' in e && e.agentId)) {
      delivery.setBusy(false)
      reportBusy($, false)
      const text = delivery.takeAtTurnEnd()
      if (text) await $.prompt.submit({ text, asUser: true })
    }
    return done
  })

  // Speech heard mid-turn rides along with the next tool result.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ('agentId' in e && e.agentId)) return ran
    const said = delivery.takeForToolResult()
    if (!said) return ran
    return { ...ran, context: [...(ran.context ?? []), said] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__interccom__speak' }, async ($, e) => {
    const text = String((e as { text?: unknown }).text ?? '').trim()
    if (!text) return { result: 'Nothing to say.' }
    if (isMuted(options)) return { result: 'Muted; nothing played.' }
    const raw = (e as { priority?: unknown }).priority
    const priority: Priority = PRIORITIES.includes(raw as Priority) ? (raw as Priority) : 'status'
    const id = currentLink()?.sessionId
    if (!id) return { result: 'interccom is not connected to the hub yet; nothing played.' }
    const out = (await hubCall($, 'POST', '/speak', { sessionId: id, text, priority })) as { queued?: unknown }
    return { result: out.queued ? 'Speaking.' : 'Nothing to say.' }
  }).catch(($, e, next) => ({ result: `interccom could not speak: ${errorText(next.error)}` }))

  // The person typed here: this is the session they're working with.
  on('prompt.submit', async ($, e, next) => {
    const id = currentLink()?.sessionId
    if (e.origin.kind === 'composer' && id) {
      await hubCall($, 'POST', `/sessions/${encodeURIComponent(id)}/active`, {}).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'listen' }, async ($, e) => listenCommand($, e.args))
    .catch(($, e, next) => ({ text: `interccom: ${errorText(next.error)}` }))

  on('command.run', { command: 'interccom' }, async ($, e) => interccomCommand($, e.args))
    .catch(($, e, next) => ({ text: `interccom: ${errorText(next.error)}` }))
}
