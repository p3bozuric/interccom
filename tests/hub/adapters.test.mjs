import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../../hub/server.mjs'
import { createCopilotAdapter, runCopilotExtension } from '../../hub/hosts/copilot.mjs'
import { createOpencodeAdapter, createOpencodePlugin } from '../../hub/hosts/opencode.mjs'
import { installLoader, copilotLoader, opencodeLoader, copilotTarget, opencodeTarget, MARKER } from '../../hub/hosts/setup.mjs'

const TOKEN = 'tok'
const hubs = []
const links = []
const dirs = []
after(async () => {
  for (const l of links) l.stop()
  for (const h of hubs) await h.close()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function liveHub() {
  const played = []
  const hub = createHub({
    token: TOKEN,
    engines: { tts: async t => Buffer.from(t), stt: async () => '' },
    audio: { play: async b => { played.push(b.toString()) } },
  })
  hubs.push(hub)
  const { port } = await hub.listen(0)
  const board = async () => (await (await fetch(`http://127.0.0.1:${port}/board`, { headers: { 'x-interccom-token': TOKEN } })).json()).sessions
  return { hub, port, played, board, linkOptions: { ensure: async () => ({ port, token: TOKEN }) } }
}

// ---- Copilot CLI ----

function fakeCopilotSession() {
  const s = { sent: [], logs: [], handlers: {} }
  s.send = async o => { s.sent.push(o.prompt); return 'msg-id' }
  s.log = async (m, o) => { s.logs.push([m, o?.level]) }
  s.on = (type, fn) => { s.handlers[type] = fn; return () => {} }
  s.emit = type => s.handlers[type]?.({ type, data: {} })
  return s
}

test('copilot: tools, guidance, and a push session on the board', async () => {
  const { port, played, board, linkOptions } = await liveHub()
  let joined
  const joinSession = async config => { joined = config; return fakeCopilotSession() }
  const adapter = await runCopilotExtension({ joinSession, cwd: '/w/shop', env: {}, linkOptions })
  links.push(adapter.link)
  await waitFor(() => adapter.link.sessionId())
  void port
  assert.deepEqual(joined.tools.map(t => t.name), ['interccom_speak', 'interccom_board'])
  assert.equal(joined.tools[0].parameters.required[0], 'text')
  const g = (await joined.hooks.onSessionStart({})).additionalContext
  assert.ok(g.includes('interccom `interccom_speak` tool'))
  assert.ok(g.includes(`[interccom:${adapter.link.tag}]`))
  assert.equal(await joined.tools[0].handler({ text: 'Copilot here.' }), 'Speaking.')
  await waitFor(() => played.length === 1)
  const rows = await board()
  assert.deepEqual([rows[0].host, rows[0].delivery, rows[0].name], ['copilot', 'push', 'shop'])
})

test('copilot: idle speech starts a turn; mid-turn it rides on the next tool result; leftovers go at idle', async () => {
  const { hub, board, linkOptions } = await liveHub()
  const a = createCopilotAdapter({ cwd: '/w/cp', env: {}, linkOptions })
  links.push(a.link)
  await hub.hear('Hey Claude, early bird') // before Copilot let the extension join
  await a.link.start()
  const s = fakeCopilotSession()
  await waitFor(async () => (await board()).length === 1)
  await hub.hear('Hey Claude, before join')
  a.attach(s)
  await waitFor(() => s.sent.length === 1)
  assert.deepEqual(s.sent, ['before join'])
  await waitFor(async () => (await board())[0].busy === true)

  s.emit('session.idle')
  await waitFor(async () => (await board())[0].busy === false)
  await a.config.hooks.onUserPromptSubmitted({ prompt: 'fix it' })
  await hub.hear('Hey Claude, use the v2 API')
  await waitFor(() => a.inbox.isBusy() && true)
  await waitFor(async () => {
    const r = await a.config.hooks.onPostToolUse({ toolName: 'bash' })
    if (!r) return false
    assert.match(r.additionalContext, /\["use the v2 API"\]$/)
    return true
  })
  await hub.hear('Hey Claude, and add a test')
  await new Promise(r => setTimeout(r, 50))
  s.emit('session.idle')
  await waitFor(() => s.sent.length === 2)
  assert.equal(s.sent[1], 'and add a test')
})

// ---- OpenCode ----

// Just enough of zod for the tool definitions.
function fakeTool() {
  const chain = kind => { const o = { kind, describe: () => o, optional: () => chain(`${kind}?`) }; return o }
  const tool = def => def
  tool.schema = { string: () => chain('string'), enum: () => chain('enum') }
  return tool
}

function fakeClient() {
  const c = { prompts: [], toasts: [] }
  c.session = { promptAsync: async o => { c.prompts.push([o.path.id, o.body.parts[0].text]) } }
  c.tui = { showToast: async o => { c.toasts.push(o.body.message) } }
  return c
}

test('opencode: plugin hooks, tools, guidance only for the main session', async () => {
  const { played, board, linkOptions } = await liveHub()
  const client = fakeClient()
  const a = createOpencodeAdapter({ client, cwd: '/w/oc', tool: fakeTool(), env: {}, linkOptions })
  links.push(a.link)
  await a.link.start()
  assert.deepEqual(Object.keys(a.hooks.tool), ['interccom_speak', 'interccom_board'])
  assert.equal(a.hooks.tool.interccom_speak.args.priority.kind, 'enum?')
  assert.equal(await a.hooks.tool.interccom_speak.execute({ text: 'OpenCode here.' }), 'Speaking.')
  await waitFor(() => played.length === 1)

  await a.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_main' } } } })
  await a.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_sub', parentID: 'ses_main' } } } })
  assert.equal(a.current(), 'ses_main')
  const sys = { system: [] }
  await a.hooks['experimental.chat.system.transform']({ sessionID: 'ses_main' }, sys)
  assert.ok(sys.system[0].includes('interccom `interccom_speak` tool'))
  const subSys = { system: [] }
  await a.hooks['experimental.chat.system.transform']({ sessionID: 'ses_sub' }, subSys)
  assert.deepEqual(subSys.system, [])
  await a.hooks['chat.message']({ sessionID: 'ses_sub' }, {})
  assert.equal(a.current(), 'ses_main')
  assert.deepEqual((await board())[0].host, 'opencode')
})

test('opencode: idle speech prompts the session; mid-turn it is appended to tool output; leftovers at idle', async () => {
  const { hub, linkOptions } = await liveHub()
  const client = fakeClient()
  const a = createOpencodeAdapter({ client, cwd: '/w/oc2', tool: fakeTool(), env: {}, linkOptions })
  links.push(a.link)
  await a.link.start()
  await hub.hear('Hey Claude, waiting for a session')
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(client.prompts, [])
  await a.hooks['chat.message']({ sessionID: 'ses_1' }, {})
  // The person typed, so the session is busy: the early speech waits for a tool result.
  const out = { output: 'ok' }
  await waitFor(async () => { await a.hooks['tool.execute.after']({ sessionID: 'ses_1', tool: 'bash' }, out); return out.output !== 'ok' })
  assert.match(out.output, /^ok\n\nVoice note \[interccom:[^\]]+\] — the person said .*\["waiting for a session"\]$/)
  const other = { output: 'x' }
  await a.hooks['tool.execute.after']({ sessionID: 'ses_other', tool: 'bash' }, other)
  assert.equal(other.output, 'x')

  await a.hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } } })
  await hub.hear('Hey Claude, now ship it')
  await waitFor(() => client.prompts.length === 1)
  assert.deepEqual(client.prompts[0], ['ses_1', 'now ship it'])

  await a.hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } })
  await hub.hear('Hey Claude, and tag it')
  await new Promise(r => setTimeout(r, 30))
  await a.hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
  await waitFor(() => client.prompts.length === 2)
  assert.deepEqual(client.prompts[1], ['ses_1', 'and tag it'])
})

test('opencode: createOpencodePlugin returns the hooks and starts the link', async () => {
  const { board, linkOptions } = await liveHub()
  const plugin = createOpencodePlugin({ tool: fakeTool(), env: {}, linkOptions: { ...linkOptions, log: () => {} } })
  const hooks = await plugin({ client: fakeClient(), directory: '/w/x', worktree: '/w' })
  assert.deepEqual(Object.keys(hooks.tool), ['interccom_speak', 'interccom_board'])
  await waitFor(async () => (await board()).some(r => r.name === 'x' && r.host === 'opencode'))
})

// ---- setup ----

test('loaders import the adapters by file URL and the tool-provided SDKs by name', () => {
  const c = copilotLoader('file:///x/copilot.mjs')
  assert.ok(c.startsWith(MARKER))
  assert.ok(c.includes('import { joinSession } from "@github/copilot-sdk/extension"'))
  assert.ok(c.includes('from "file:///x/copilot.mjs"'))
  const o = opencodeLoader()
  assert.ok(o.includes('import { tool } from "@opencode-ai/plugin"'))
  assert.match(o, /from "file:\/\/\/.*\/hub\/hosts\/opencode\.mjs"/)
  assert.ok(o.includes('export const Interccom = createOpencodePlugin({ tool })'))
  assert.equal(copilotTarget({ COPILOT_HOME: '/c' }), path.join('/c', 'extensions', 'interccom', 'extension.mjs'))
  assert.equal(copilotTarget({}, '/h'), path.join('/h', '.copilot', 'extensions', 'interccom', 'extension.mjs'))
  assert.equal(opencodeTarget({ XDG_CONFIG_HOME: '/x' }), path.join('/x', 'opencode', 'plugins', 'interccom.js'))
  assert.equal(opencodeTarget({}, '/h'), path.join('/h', '.config', 'opencode', 'plugins', 'interccom.js'))
})

test('installLoader writes, updates and removes its own file, and never touches anyone else\'s', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'interccom-setup-'))
  dirs.push(d)
  const f = path.join(d, 'a', 'b', 'extension.mjs')
  assert.equal(installLoader(f, `${MARKER} v1\n`), `Wrote ${f}.`)
  assert.equal(installLoader(f, `${MARKER} v2\n`), `Updated ${f}.`)
  assert.equal(fs.readFileSync(f, 'utf8'), `${MARKER} v2\n`)
  assert.equal(installLoader(f, '', { remove: true }), `Removed ${f}.`)
  assert.equal(fs.existsSync(f), false)
  assert.equal(installLoader(f, '', { remove: true }), `Nothing to remove at ${f}.`)
  fs.writeFileSync(f, 'my own extension\n')
  assert.throws(() => installLoader(f, `${MARKER}\n`), /wasn't written by interccom/)
  assert.throws(() => installLoader(f, '', { remove: true }), /wasn't written by interccom/)
  assert.equal(fs.readFileSync(f, 'utf8'), 'my own extension\n')
})

test('only Claude Code sessions can be the coordinator', async () => {
  const { port, linkOptions } = await liveHub()
  const a = createCopilotAdapter({ cwd: '/w/c', env: {}, linkOptions })
  links.push(a.link)
  await a.link.start()
  const r = await fetch(`http://127.0.0.1:${port}/sessions/${a.link.sessionId()}/role`, {
    method: 'POST', headers: { 'x-interccom-token': TOKEN, 'content-type': 'application/json' }, body: '{"role":"coordinator"}',
  })
  assert.equal(r.status, 400)
})
