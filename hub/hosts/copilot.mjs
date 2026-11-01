// GitHub Copilot CLI adapter: runs as a Copilot extension (one forked Node process per
// foreground session), so like the Claude Code plugin it is the session's whole link:
// tools, guidance, busy/idle, and heard speech delivered in-process.
//   ~/.copilot/extensions/interccom/extension.mjs (written by `interccom copilot-setup`)
//   imports joinSession from @github/copilot-sdk/extension, which only Copilot can resolve,
//   and hands it to runCopilotExtension.
// stdout is Copilot's JSON-RPC channel: nothing here writes to it.
import { createHostLink, callTool, TOOLS } from '../mcp.mjs'
import { hostGuidance, createVoiceInbox } from './text.mjs'

export const SPEAK = 'interccom_speak'
export const BOARD = 'interccom_board'

function baseName(dir) {
  return String(dir).split(/[\\/]+/).filter(Boolean).pop() || 'session'
}

// Tool results come back as MCP-style content; Copilot handlers return text.
async function toolText(link, name, args) {
  const r = await callTool(link, name, args)
  return r.content.map(c => c.text).join('\n')
}

export function copilotTools(link) {
  return TOOLS.map(t => ({
    name: `interccom_${t.name}`,
    description: t.description,
    parameters: t.inputSchema,
    handler: async args => toolText(link, t.name, args ?? {}),
  }))
}

// Everything except joinSession, so tests can drive it with a fake session.
export function createCopilotAdapter({ cwd = process.cwd(), env = process.env, linkOptions = {} } = {}) {
  const name = baseName(cwd)
  let session = null
  const pending = [] // heard before joinSession resolved
  let inbox
  const send = text => session?.send({ prompt: text }).catch(err => log(`couldn't pass your speech on: ${err?.message ?? err}`, 'error'))
  const log = (m, level = 'warning') => { void session?.log?.(`interccom: ${m}`, { level }).catch?.(() => {}) }
  const link = createHostLink({
    host: 'copilot', name, cwd, env, delivery: 'push',
    onHeard: text => (session ? deliver(text) : pending.push(text)),
    onError: m => log(m),
    ...linkOptions,
  })
  inbox = createVoiceInbox(link.tag)
  const turnStarted = () => { inbox.setBusy(true); link.setBusy(true) }
  // Idle: the speech starts a turn. Busy: it waits for the next tool result or the turn's end.
  function deliver(text) {
    if (inbox.heard(text) === 'submit') { turnStarted(); void send(text) }
  }

  const config = {
    tools: copilotTools(link),
    hooks: {
      onSessionStart: async () => ({ additionalContext: hostGuidance(link.name() || name, link.tag, SPEAK) }),
      onUserPromptSubmitted: async () => {
        turnStarted()
        link.markActive()
        const note = inbox.takeNote()
        return note ? { additionalContext: note } : undefined
      },
      onPostToolUse: async () => {
        const note = inbox.takeNote()
        return note ? { additionalContext: note } : undefined
      },
    },
  }

  function attach(s) {
    session = s
    s.on('assistant.turn_start', turnStarted)
    s.on('session.idle', () => {
      inbox.setBusy(false)
      link.setBusy(false)
      const left = inbox.takeAtTurnEnd()
      if (left) { turnStarted(); void send(left) }
    })
    for (const t of pending.splice(0)) deliver(t)
  }

  return { link, config, attach, inbox }
}

export async function runCopilotExtension({ joinSession, cwd = process.cwd(), env = process.env, linkOptions }) {
  const adapter = createCopilotAdapter({ cwd, env, linkOptions })
  adapter.link.start()
  const session = await joinSession(adapter.config)
  adapter.attach(session)
  return adapter
}
