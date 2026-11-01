// interccom for agents other than Claude Code: a stdio MCP server with `speak` and `board`.
//   interccom mcp [--host codex|gemini] [--name <name>] [--cwd <dir>]
// The process lives as long as the agent's session, so it is that session's link to the hub:
// it starts the hub if needed, registers, keeps the event stream open and reconnects.
// With --host codex or gemini, heard speech waits in the hub for that agent's hooks
// (interccom codex-hook / gemini-hook); any other host can speak but not hear yet. stdout carries only JSON-RPC; logs go to stderr.
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ensureHub } from './launch.mjs'
import { configFromEnv } from './config-env.mjs'
import { hostGuidance, genericInstructions } from './hosts/text.mjs'

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const PRIORITIES = ['question', 'heads-up', 'status']
// Hosts whose hooks drain the hub's inbox. Everything else is speak-only for now.
const PULL_HOSTS = new Set(['codex', 'gemini'])

export const TOOLS = [
  {
    name: 'speak',
    description: 'Say something out loud to the person: a short spoken summary, conclusion, or question (1-3 plain sentences, no code or markdown). Returns immediately; audio plays in the background, one voice for all sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say, as plain spoken English.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'question: needs an answer. heads-up: "this will take a while". status: results (the default).' },
      },
      required: ['text'],
    },
  },
  {
    name: 'board',
    description: 'interccom status board: every connected agent session on this machine (Claude Code, Codex, ...) with its name, folder, busy/idle, last spoken line and open question.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function baseName(dir) {
  return String(dir).split(/[\\/]+/).filter(Boolean).pop() || 'session'
}

export function defaultStateDir(env = process.env) {
  return env.INTERCCOM_STATE_DIR || path.join(os.homedir(), '.interccom')
}

export const HUB_ENTRY = fileURLToPath(new URL('./main.mjs', import.meta.url))

// The session's link to the hub. All network access goes through `call`.
// delivery: pull (hooks drain the hub's inbox: Codex), push (heard speech arrives here,
// passed to onHeard: Copilot, OpenCode), or none (speak-only MCP hosts).
export function createHostLink({
  host, name, cwd, env = process.env, stateDir = defaultStateDir(env), hubEntry = HUB_ENTRY,
  delivery = PULL_HOSTS.has(host) ? 'pull' : 'none', onHeard = () => {}, onError = () => {},
  ensure = ensureHub, fetchFn = globalThis.fetch, log = () => {}, backoffMs = [2000, 30000],
}) {
  const tag = delivery === 'none' ? '' : randomUUID()
  let busy = false
  let hostSessionId = env.CODEX_THREAD_ID && host === 'codex' ? String(env.CODEX_THREAD_ID) : ''
  let hub = null // { port, token }
  let sessionId = ''
  let currentName = name
  let lastError = ''
  let stopped = false
  let wait = backoffMs[0]
  let stream = null
  let ready
  const firstLink = new Promise(r => { ready = r })

  async function call(method, p, body) {
    if (!hub) throw new Error('interccom is not connected to the hub yet; try again in a moment.')
    const res = await fetchFn(`http://127.0.0.1:${hub.port}${p}`, {
      method,
      headers: { 'x-interccom-token': hub.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`interccom hub refused ${method} ${p}: ${res.status}${out?.error ? ` ${out.error}` : ''}`)
    return out
  }

  function onEvent(msg) {
    if (msg.type === 'bound' && typeof msg.hostSessionId === 'string') hostSessionId = msg.hostSessionId
    else if (msg.type === 'hello' && typeof msg.name === 'string') currentName = msg.name
    else if (msg.type === 'error') { lastError = String(msg.message ?? ''); log(`interccom: ${lastError}`); onError(lastError) }
    else if (msg.type === 'heard' && typeof msg.text === 'string' && msg.text.trim()) onHeard(msg.text.trim())
  }

  // Best effort, like the Claude Code plugin: never blocks or throws.
  function post(p, body) {
    if (!sessionId) return
    void call('POST', p, body).catch(() => undefined)
  }

  async function connectOnce() {
    hub = await ensure({ stateDir, hubEntry })
    await call('POST', '/config', configFromEnv(env))
    const reg = await call('POST', '/sessions', { name, cwd, pid: process.pid, host, delivery, hostSessionId, tag })
    sessionId = reg.sessionId
    currentName = reg.name
    // A new registration starts idle on the hub: bring it up to date.
    if (busy) post(`/sessions/${encodeURIComponent(sessionId)}/state`, { busy })
    const ac = new AbortController()
    stream = ac
    const res = await fetchFn(`http://127.0.0.1:${hub.port}/events?session=${encodeURIComponent(sessionId)}`, {
      headers: { 'x-interccom-token': hub.token }, signal: ac.signal,
    })
    if (!res.ok) throw new Error(`GET /events failed: ${res.status}`)
    ready()
    wait = backoffMs[0]
    let buf = ''
    try {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8')
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          try { onEvent(JSON.parse(line)) } catch { /* not JSON */ }
        }
      }
    } catch { /* stream broke: the hub went away */ }
  }

  async function run() {
    while (!stopped) {
      try {
        await connectOnce()
      } catch (err) {
        lastError = String(err?.message ?? err)
        log(`interccom: ${lastError}`)
      }
      sessionId = ''
      if (stopped) break
      await new Promise(r => setTimeout(r, wait).unref?.())
      wait = Math.min(wait * 2, backoffMs[1])
    }
  }

  return {
    tag, delivery,
    start() { void run(); return firstLink },
    stop() { stopped = true; stream?.abort() },
    call,
    sessionId: () => sessionId,
    name: () => currentName,
    hostSessionId: () => hostSessionId,
    lastError: () => lastError,
    setBusy(b) {
      if (b === busy) return
      busy = b
      post(`/sessions/${encodeURIComponent(sessionId)}/state`, { busy })
    },
    markActive() { post(`/sessions/${encodeURIComponent(sessionId)}/active`, {}) },
  }
}

function text(t, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) }
}

export async function callTool(link, toolName, args = {}) {
  toolName = String(toolName ?? '').replace(/^interccom_/, '')
  if (toolName === 'speak') {
    const said = String(args.text ?? '').trim()
    if (!said) return text('Nothing to say.')
    const id = link.sessionId()
    if (!id) return text(`interccom is not connected to the hub yet; nothing played.${link.lastError() ? ` (${link.lastError()})` : ''}`, true)
    const priority = PRIORITIES.includes(args.priority) ? args.priority : 'status'
    const out = await link.call('POST', '/speak', { sessionId: id, text: said, priority })
    const problem = link.lastError() ? ` Last interccom problem: ${link.lastError()}` : ''
    return text(out.queued ? `Speaking.${problem}` : 'Nothing to say.')
  }
  if (toolName === 'board') {
    const b = await link.call('GET', '/board')
    const rows = (b.sessions ?? []).map(r => ({
      name: r.name, host: r.host, folder: r.cwd, role: r.role, busy: r.busy,
      lastLine: r.lastLine || undefined, openQuestion: r.openQuestion || undefined,
    }))
    return text(JSON.stringify({ coordinator: b.coordinator, listening: b.mode, sessions: rows }, null, 1))
  }
  return text(`Unknown tool: ${toolName}`, true)
}

// One JSON-RPC message in, the response out (null for notifications).
export async function handleMessage(msg, { link, instructions, version }) {
  const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } })
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return isRequest ? fail(-32600, 'invalid request') : null
  if (!isRequest) return null // notifications: initialized, cancelled, ...
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'interccom', version },
        instructions,
      })
    }
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: TOOLS })
    case 'tools/call':
      try {
        return reply(await callTool(link, msg.params?.name, msg.params?.arguments ?? {}))
      } catch (err) {
        return reply(text(`interccom: ${String(err?.message ?? err).slice(0, 300)}`, true))
      }
    default: return fail(-32601, `method not found: ${msg.method}`)
  }
}

export async function runMcp({ host = 'mcp', name, cwd = process.cwd(), version = '0.0.0', env = process.env } = {}) {
  const sessionName = name || baseName(cwd)
  const link = createHostLink({ host, name: sessionName, cwd, env, log: m => process.stderr.write(`${m}\n`) })
  link.start()
  const instructions = link.delivery === 'pull' ? hostGuidance(sessionName, link.tag) : genericInstructions(sessionName)
  let buf = ''
  let chain = Promise.resolve()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      chain = chain.then(async () => {
        let msg
        try { msg = JSON.parse(line) } catch {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n')
          return
        }
        const out = await handleMessage(msg, { link, instructions, version })
        if (out) process.stdout.write(JSON.stringify(out) + '\n')
      })
    }
  })
  process.stdin.on('end', () => { link.stop(); process.exit(0) })
}
