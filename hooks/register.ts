import type { Register, EngineInterface, RenderElement } from 'claude-code'
import { guidance, coordinatorGuidance, normalizeAutonomy } from './guidance.ts'
import {
  startLink, hubCall, currentLink, setLinkName, reportBusy, delivery, voiceTag,
  currentRole, requestRole, deliverReports, isTalking, isMicPaused, isMicOn, currentStatus, linkReady, HubRefusal,
  isPowered, currentWave,
} from './hub-link.ts'
import { rememberCheck, takeEligible, askByVoice } from './approvals.ts'
import { boardText, type BoardData } from './board-view.ts'
import { baseName, isMuted } from './link-env.ts'

// interccom, the session side. Claude gets a `speak` tool whose text goes to the hub,
// which plays one voice for every session in priority order. What the person says
// comes back from the hub: idle, it is sent as their message; mid-turn it rides
// along with the next tool result, or is sent when the turn ends.
// One session can be the coordinator (/interccom coordinator): it hears everything,
// gets the other sessions' spoken lines as reports, and is the only one heard.

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
  return String((err as { message?: unknown } | undefined)?.message ?? err).replace(/^(Error: )?(interccom: )?/, '').slice(0, 200)
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

// The hub turns the wanted name into a speakable, unique one ("Session #3" -> session-3).
async function renameSession($: EngineInterface, wanted: string): Promise<string> {
  setLinkName(wanted) // a link that isn't up yet registers under it
  const id = currentLink()?.sessionId
  if (!id) return wanted
  const out = (await hubCall($, 'POST', `/sessions/${encodeURIComponent(id)}/name`, { name: wanted })) as { name?: unknown }
  const name = String(out.name ?? wanted)
  setLinkName(name)
  return name
}

// Ends what is playing and drops queued updates (questions stay); how many were dropped.
async function stopTalking($: EngineInterface): Promise<number> {
  const out = (await hubCall($, 'POST', '/stop', {})) as { flushed?: unknown }
  return Number(out.flushed ?? 0)
}

// interccom on/off for every session: off means no listening, no speech, no voice approvals.
async function setPower($: EngineInterface, on: boolean): Promise<void> {
  await hubCall($, 'POST', '/power', { on })
}

let resumeMode: 'wake' | 'always' = 'wake' // what "Mic on" goes back to

// Mic off is /listen off; Mic on goes back to the mode it had (wake unless it was always).
async function toggleMic($: EngineInterface): Promise<void> {
  if (isMicPaused()) {
    await hubCall($, 'POST', '/listen', { mode: resumeMode })
    return
  }
  const board = (await hubCall($, 'GET', '/board')) as { mode?: unknown }
  resumeMode = board.mode === 'always' ? 'always' : 'wake'
  await hubCall($, 'POST', '/listen', { mode: 'off' })
}

// A session title as a name: its first three words, the most a name said out loud can be.
export function titleName(title: string): string {
  return title.trim().replace(/^["']|["']$/g, '').split(/\s+/).slice(0, 3).join(' ')
}

let lastTitle = ''

// Follow the session's title (/rename, the desktop app's sidebar, or its own automatic title)
// whenever it changes; a name set with /interccom name stands until the title changes again.
async function followTitle($: EngineInterface, title: unknown): Promise<void> {
  const wanted = titleName(String(title ?? ''))
  if (!wanted || wanted === lastTitle) return
  lastTitle = wanted
  try {
    await renameSession($, wanted)
  } catch (err) {
    $.ui.toast(`interccom: couldn't use the session's name (${errorText(err).slice(0, 120)})`)
  }
}

async function interccomCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const usage = { text: 'Usage: /interccom setup [test] | name <name> | status | stop | on | off | coordinator [take] | worker' }
  const trimmed = args.trim()
  const [sub = '', ...rest] = trimmed.split(/\s+/)
  if (sub.toLowerCase() === 'name') {
    const wanted = rest.join(' ').trim()
    if (!wanted) return usage
    if (!(await linkReady($))) return { text: 'interccom is not connected to the hub yet; try again in a moment.' }
    return { text: `This session is now called ${await renameSession($, wanted)}.` }
  }
  if (sub.toLowerCase() === 'setup') {
    if ((rest[0] ?? '').toLowerCase() === 'test') {
      const id = (await linkReady($))?.sessionId
      if (!id) return { text: 'interccom is not connected to the hub yet; try again in a moment.' }
      await hubCall($, 'POST', '/setup/test', { sessionId: id })
      return { text: 'Playing a test line. Then say "Hey Claude, testing" to check listening.' }
    }
    const report = (await hubCall($, 'GET', '/setup')) as { text?: unknown }
    return { text: String(report.text ?? '') }
  }
  if (sub.toLowerCase() === 'status') {
    const board = (await hubCall($, 'GET', '/board')) as BoardData
    return { text: boardText(board, Date.now()) }
  }
  if (sub.toLowerCase() === 'coordinator') {
    const takeover = (rest[0] ?? '').toLowerCase() === 'take'
    try {
      await requestRole($, 'coordinator', takeover)
    } catch (err) {
      if (err instanceof HubRefusal && err.status === 409) {
        return { text: `${err.reason}. /interccom coordinator take makes this session the coordinator instead.` }
      }
      throw err
    }
    return {
      text: 'This session is now the interccom coordinator: it hears everything you say, and the other sessions report to it. '
        + 'Its instructions apply from your next message. /interccom worker steps down.',
    }
  }
  if (sub.toLowerCase() === 'worker') {
    await requestRole($, 'worker', false)
    return { text: 'This session is a worker again.' }
  }
  if (sub.toLowerCase() === 'stop') {
    return { text: `Stopped. Cleared ${await stopTalking($)} queued updates.` }
  }
  if (sub.toLowerCase() === 'off' || sub.toLowerCase() === 'on') {
    const on = sub.toLowerCase() === 'on'
    if (!(await linkReady($))) return { text: 'interccom is not connected to the hub yet; try again in a moment.' }
    await setPower($, on)
    return { text: on ? 'interccom is on: listening and speaking again.' : 'interccom is off for every session: no listening, no speech. /interccom on, or Turn on above the prompt, brings it back.' }
  }
  return usage
}

type BoardInput = { resolve?: unknown; decision?: unknown; relay?: { to?: unknown; quote?: unknown } }

async function boardTool($: EngineInterface, input: BoardInput): Promise<{ result: string }> {
  const id = currentLink()?.sessionId
  if (!id) return { result: 'interccom is not connected to the hub yet.' }
  const notes: string[] = []
  const resolve = String(input.resolve ?? '').trim()
  const decision = String(input.decision ?? '').trim()
  if (resolve) {
    const out = (await hubCall($, 'POST', '/board/resolve', { sessionId: id, name: resolve })) as { resolved?: unknown }
    notes.push(`Marked ${String(out.resolved)}'s question as handled.`)
  }
  if (decision) {
    await hubCall($, 'POST', '/board/decision', { sessionId: id, text: decision })
    notes.push('Decision logged.')
  }
  const to = String(input.relay?.to ?? '').trim()
  if (to) {
    const out = (await hubCall($, 'POST', '/board/relay', { sessionId: id, to, quote: String(input.relay?.quote ?? '') })) as { relayed?: unknown }
    notes.push(`Passed the person's words to ${String(out.relayed)}.`)
  }
  const board = (await hubCall($, 'GET', '/board')) as BoardData
  return { result: [...notes, boardText(board, Date.now())].join('\n') }
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
    await $.tool.register({
      name: 'board',
      description:
        'interccom status board: every connected Claude Code session with its name, folder, busy/idle, last spoken line and open question, plus decisions logged by the coordinator. The coordinator can also mark a question answered (resolve) or log a decision it made on its own (decision).',
      inputSchema: {
        type: 'object',
        properties: {
          resolve: { type: 'string', description: 'Coordinator only: the session name whose open question is now handled.' },
          decision: { type: 'string', description: 'Coordinator only: one plain sentence describing a decision you made without the person.' },
          relay: {
            type: 'object',
            description: "Coordinator only: pass the person's own recent words, quoted exactly, to a session by its interccom name: Codex and other non-Claude agents, or a Claude session ListAgents doesn't clearly show.",
            properties: { to: { type: 'string', description: 'Session name.' }, quote: { type: 'string', description: 'The exact words the person said.' } },
            required: ['to', 'quote'],
          },
        },
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
      description: 'interccom: check the speech setup, rename this session, list every session, stop playback, switch interccom on or off, or make this session the coordinator.',
      argumentHint: 'setup [test] | name <name> | status | stop | on | off | coordinator [take] | worker',
      immediate: true,
    })
    startLink($, options, e.cwd)
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections = [...composed.sections, { id: 'interccom:guidance', text: guidance(currentName(), voiceTag), scope: 'session' as const }]
    if (currentRole() === 'coordinator') {
      const policy = coordinatorGuidance(voiceTag, normalizeAutonomy(options.autonomy), String(options.autonomy_rules ?? ''))
      sections.push({ id: 'interccom:coordinator', text: policy, scope: 'session' as const })
    }
    return { sections }
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
      await deliverReports($, delivery.takeReportsAtTurnEnd())
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
    const out = (await hubCall($, 'POST', '/speak', { sessionId: id, text, priority })) as { queued?: unknown; off?: unknown }
    if (out.off) return { result: 'interccom is switched off; nothing played. Answer in text.' }
    return { result: out.queued ? 'Speaking.' : 'Nothing to say.' }
  }).catch(($, e, next) => ({ result: `interccom could not speak: ${errorText(next.error)}` }))

  on('tool.call', { tool: 'mcp__interccom__board' }, async ($, e) => boardTool($, e as BoardInput))
    .catch(($, e, next) => ({ result: `interccom board unavailable: ${errorText(next.error)}` }))

  // The person typed here: this is the session they're working with.
  on('prompt.submit', async ($, e, next) => {
    const id = currentLink()?.sessionId
    if (e.origin.kind === 'composer' && id) {
      await hubCall($, 'POST', `/sessions/${encodeURIComponent(id)}/active`, {}).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A band above the prompt: the voice status, a mic switch, and Stop while it talks. The desktop
  // app holds typed commands (/interccom stop, /listen) until Claude's turn ends; a press
  // reaches the plugin at once.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !currentLink()) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const failed = (what: string) => (err: unknown) => $.ui.toast(`interccom: couldn't ${what} (${errorText(err).slice(0, 120)})`)
    if (!isPowered()) {
      return h(Box, { flexDirection: 'row', gap: 1 },
        h(Text, { dimColor: true }, 'interccom: Off'),
        h(Button, {
          key: 'power', label: 'Turn on', variant: 'primary',
          onPress: () => setPower($, true).catch(failed('turn interccom on')),
        })) as RenderElement
    }
    const wave = currentWave()
    return h(Box, { flexDirection: 'row', gap: 1 },
      h(Text, { dimColor: true }, `interccom: ${currentStatus()}`),
      wave ? h(Text, { key: 'wave', color: 'success' }, wave) : null,
      isTalking() && h(Button, {
        key: 'stop', label: 'Stop', variant: 'primary',
        onPress: () => stopTalking($).catch(failed('stop')),
      }),
      h(Button, {
        key: 'mic', label: isMicPaused() ? 'Mic on' : 'Mic off',
        onPress: () => toggleMic($).catch(failed('switch the mic')),
      }),
      h(Button, {
        key: 'power', label: 'Turn off',
        onPress: () => setPower($, false).catch(failed('turn interccom off')),
      })) as RenderElement
  }).catch(($, e, next) => next(e))

  // Permission prompts by voice. tool.check only watches core's verdict and never changes it.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    rememberCheck(e, verdict)
    return verdict
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const below = await next(e)
    if (below.decision) return below // the person's own PermissionRequest hooks decided
    const toolUseId = takeEligible(e.tool_name, e.tool_input)
    const id = currentLink()?.sessionId
    if (!toolUseId || !id || !isPowered() || !isMicOn() || isMuted(options)) return below
    const call = (method: string, path: string, body?: unknown) => hubCall($, method, path, body)
    const answer = await askByVoice($, call, id, e.tool_name, e.tool_input, toolUseId, next.signal)
    if (answer === 'approved') return { ...below, decision: { behavior: 'allow' as const } }
    if (answer === 'denied') return { ...below, decision: { behavior: 'deny' as const, message: 'The person said no, by voice.' } }
    return below
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'listen' }, async ($, e) => listenCommand($, e.args))
    .catch(($, e, next) => ({ text: errorText(next.error) }))

  on('command.run', { command: 'interccom' }, async ($, e) => interccomCommand($, e.args))
    .catch(($, e, next) => ({ text: errorText(next.error) }))

  // The session's title is its name: at start (a resumed session keeps its title), with every
  // prompt (a rename in the desktop sidebar), and straight away on /rename.
  on('classic.SessionStart', async ($, e, next) => {
    await followTitle($, e.session_title)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await followTitle($, e.session_title)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const ran = await next(e)
    await followTitle($, e.args)
    return ran
  })
}
