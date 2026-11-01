// OpenCode adapter: an OpenCode plugin, loaded into the OpenCode server for as long as it
// runs, so like the Claude Code plugin it is the session's whole link: tools, guidance,
// busy/idle, and heard speech delivered in-process.
//   ~/.config/opencode/plugins/interccom.js (written by `interccom opencode-setup`) imports
//   `tool` from @opencode-ai/plugin, which OpenCode installs in its config folders, and
//   passes it to createOpencodePlugin.
// One OpenCode server can hold several sessions: speech goes to the one the person last
// used. Subagent sessions (they have a parent) are never targets and get no guidance.
import { createHostLink, callTool, TOOLS } from '../mcp.mjs'
import { hostGuidance, createVoiceInbox } from './text.mjs'

export const SPEAK = 'interccom_speak'

function baseName(dir) {
  return String(dir).split(/[\\/]+/).filter(Boolean).pop() || 'session'
}

async function toolText(link, name, args) {
  const r = await callTool(link, name, args)
  return r.content.map(c => c.text).join('\n')
}

export function opencodeTools(link, tool) {
  const z = tool.schema
  const speak = TOOLS.find(t => t.name === 'speak')
  const board = TOOLS.find(t => t.name === 'board')
  return {
    interccom_speak: tool({
      description: speak.description,
      args: {
        text: z.string().describe(speak.inputSchema.properties.text.description),
        priority: z.enum(['question', 'heads-up', 'status']).optional().describe(speak.inputSchema.properties.priority.description),
      },
      execute: async args => toolText(link, 'speak', args ?? {}),
    }),
    interccom_board: tool({
      description: board.description,
      args: {},
      execute: async () => toolText(link, 'board', {}),
    }),
  }
}

export function createOpencodeAdapter({ client, cwd, tool, env = process.env, linkOptions = {} }) {
  const name = baseName(cwd)
  let current = '' // the OpenCode session the person is working in
  const children = new Set() // subagent sessions
  const waiting = [] // heard before any session existed
  let inbox

  function notify(message) {
    try {
      const p = client?.tui?.showToast?.({ body: { message: `interccom: ${message}`.slice(0, 300), variant: 'warning' } })
      p?.catch?.(() => {})
    } catch { /* no TUI */ }
  }

  async function send(text) {
    const s = client?.session
    const opts = { path: { id: current }, body: { parts: [{ type: 'text', text }] } }
    try {
      if (typeof s?.promptAsync === 'function') await s.promptAsync(opts)
      else void s?.prompt?.(opts) // older servers: prompt waits for the reply; don't
    } catch (err) {
      notify(`couldn't pass your speech on: ${err?.message ?? err}`)
    }
  }

  const link = createHostLink({
    host: 'opencode', name, cwd, env, delivery: 'push',
    onHeard: text => deliver(text),
    onError: m => notify(m),
    ...linkOptions,
  })
  inbox = createVoiceInbox(link.tag)

  function turnStarted() { inbox.setBusy(true); link.setBusy(true) }
  function turnEnded() {
    inbox.setBusy(false)
    link.setBusy(false)
    const left = inbox.takeAtTurnEnd()
    if (left) deliver(left)
  }

  function deliver(text) {
    if (!current) { waiting.push(text); return }
    if (inbox.heard(text) === 'submit') { turnStarted(); void send(text) }
  }

  function adopt(id) {
    if (!id || children.has(id) || id === current) return
    current = id
    for (const t of waiting.splice(0)) deliver(t)
  }

  const hooks = {
    tool: opencodeTools(link, tool),
    event: async ({ event }) => {
      const p = event?.properties ?? {}
      if (event?.type === 'session.created') {
        if (p.info?.parentID) children.add(p.info.id)
        else if (!current) adopt(p.info?.id)
        return
      }
      if (p.sessionID !== current) return
      if (event.type === 'session.status') {
        if (p.status?.type === 'busy') turnStarted()
        else if (p.status?.type === 'idle') turnEnded()
      } else if (event.type === 'session.idle') {
        turnEnded()
      }
    },
    // The person sent a message: that session is now the one they're working in, and busy,
    // so speech waiting from before rides along with this turn instead of starting another.
    'chat.message': async input => {
      const id = input?.sessionID
      if (!id || children.has(id)) return
      turnStarted()
      adopt(id)
      link.markActive()
    },
    'tool.execute.after': async (input, output) => {
      if (input?.sessionID !== current) return
      const note = inbox.takeNote()
      if (note && output) output.output = `${output.output ?? ''}\n\n${note}`
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (children.has(input?.sessionID) || !Array.isArray(output?.system)) return
      output.system.push(hostGuidance(link.name() || name, link.tag, SPEAK))
    },
  }

  return { link, hooks, current: () => current, inbox }
}

export function createOpencodePlugin({ tool, env = process.env, linkOptions }) {
  return async ({ client, directory, worktree }) => {
    const adapter = createOpencodeAdapter({ client, cwd: directory || worktree || process.cwd(), tool, env, linkOptions })
    adapter.link.start()
    return adapter.hooks
  }
}
