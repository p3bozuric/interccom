import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHub } from '../../hub/server.mjs'
import { createHostLink, handleMessage, callTool, TOOLS, PROTOCOL_VERSIONS } from '../../hub/mcp.mjs'
import { codexHook } from '../../hub/codex-hook.mjs'
import { codexSetupText } from '../../hub/cli.mjs'

const TOKEN = 'tok'
const hubs = []
const links = []
const pids = new Set()
const dirs = []
after(async () => {
  for (const l of links) l.stop()
  for (const h of hubs) await h.close()
  for (const d of dirs) { try { pids.add(JSON.parse(fs.readFileSync(path.join(d, 'hub.json'), 'utf8')).pid) } catch { /* none */ } }
  for (const pid of pids) { try { process.kill(pid) } catch { /* gone */ } }
  // On Windows a killed hub holds its state dir for a moment after the kill.
  for (const d of dirs) {
    for (let i = 0; ; i++) {
      try { fs.rmSync(d, { recursive: true, force: true }); break } catch (e) {
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' || i >= 50) throw e
        await new Promise(r => setTimeout(r, 100))
      }
    }
  }
})
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

async function liveHub(opts = {}) {
  const played = []
  const submitted = []
  const hub = createHub({
    token: TOKEN,
    engines: { tts: async t => Buffer.from(t), stt: async () => '' },
    audio: { play: async b => { played.push(b.toString()) } },
    hostSubmit: async s => { submitted.push(s) },
    ...opts,
  })
  hubs.push(hub)
  const { port } = await hub.listen(0)
  return { hub, port, played, submitted }
}

function linkTo(port, extra = {}) {
  const link = createHostLink({ host: 'codex', name: 'cx', cwd: '/w/cx', env: {}, ensure: async () => ({ port, token: TOKEN }), ...extra })
  links.push(link)
  return link
}

// ---- JSON-RPC ----

const fakeLink = (over = {}) => ({
  sessionId: () => 'S', lastError: () => '', call: async () => ({ queued: true }), ...over,
})

test('initialize echoes a supported protocol version, offers tools and instructions', async () => {
  const ctx = { link: fakeLink(), instructions: 'be brief', version: '9.9.9' }
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, ctx)
  assert.deepEqual(r, {
    jsonrpc: '2.0', id: 1,
    result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'interccom', version: '9.9.9' }, instructions: 'be brief' },
  })
  const odd = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, ctx)
  assert.equal(odd.result.protocolVersion, PROTOCOL_VERSIONS[0])
})

test('tools/list, ping, notifications, unknown methods and bad requests', async () => {
  const ctx = { link: fakeLink(), instructions: '', version: '1' }
  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, ctx)).result.tools.map(t => t.name), ['speak', 'board'])
  assert.deepEqual(await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, ctx), { jsonrpc: '2.0', id: 3, result: {} })
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null)
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, ctx)).error.code, -32601)
  assert.equal((await handleMessage({ id: 5, method: 'ping' }, ctx)).error.code, -32600)
  assert.ok(TOOLS.every(t => t.inputSchema.type === 'object'))
})

test('tools/call: speak reports problems and failures as tool errors, never protocol errors', async () => {
  const calls = []
  const link = fakeLink({ call: async (...a) => { calls.push(a); return { queued: true } }, lastError: () => 'no key' })
  assert.deepEqual(await callTool(link, 'speak', { text: 'Done.', priority: 'bogus' }),
    { content: [{ type: 'text', text: 'Speaking. Last interccom problem: no key' }] })
  assert.deepEqual(calls[0], ['POST', '/speak', { sessionId: 'S', text: 'Done.', priority: 'status' }])
  assert.equal((await callTool(link, 'speak', { text: '  ' })).content[0].text, 'Nothing to say.')
  assert.equal((await callTool(fakeLink({ sessionId: () => '' }), 'speak', { text: 'x' })).isError, true)
  const boom = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'speak', arguments: { text: 'x' } } },
    { link: fakeLink({ call: async () => { throw new Error('hub refused') } }), instructions: '', version: '1' })
  assert.deepEqual(boom.result, { content: [{ type: 'text', text: 'interccom: hub refused' }], isError: true })
  assert.equal((await callTool(link, 'nope')).isError, true)
})

// ---- link + hub + hooks, in process ----

test('codex link registers as a pull session, speaks, and hears through the hooks', async () => {
  const { hub, port, played, submitted } = await liveHub()
  const link = linkTo(port)
  await link.start()
  assert.ok(link.sessionId())
  assert.equal(link.delivery, 'pull')
  assert.equal(link.name(), 'cx')

  assert.equal((await callTool(link, 'speak', { text: 'Tests pass.' })).content[0].text, 'Speaking.')
  await waitFor(() => played.length === 1)
  assert.deepEqual(played, ['Tests pass.'])
  const board = JSON.parse((await callTool(link, 'board')).content[0].text)
  assert.deepEqual(board.sessions[0], { name: 'cx', host: 'codex', folder: '/w/cx', role: 'worker', busy: false, lastLine: 'Tests pass.' })

  const find = async () => ({ port, token: TOKEN })
  const hook = (hook_event_name, extra = {}) =>
    codexHook(JSON.stringify({ hook_event_name, session_id: 'th-9', cwd: '/w/cx', ...extra }), { find })
  const start = JSON.parse(await hook('SessionStart'))
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.ok(start.hookSpecificOutput.additionalContext.includes(`[interccom:${link.tag}]`))
  await waitFor(() => link.hostSessionId() === 'th-9')

  assert.equal(await hook('UserPromptSubmit'), '')
  await hub.hear('Hey Claude, skip the slow tests')
  const mid = JSON.parse(await hook('PostToolUse', { tool_name: 'shell' }))
  assert.match(mid.hookSpecificOutput.additionalContext, /\["skip the slow tests"\]$/)
  assert.equal(await hook('Stop', { stop_hook_active: false }), '')

  await hub.hear('Hey Claude, now push it')
  await waitFor(() => submitted.length === 1)
  assert.deepEqual(submitted[0], { host: 'codex', hostSessionId: 'th-9', cwd: '/w/cx', text: 'now push it' })
})

test('a reconnecting codex link re-registers with the thread it learned', async () => {
  const { port, hub } = await liveHub()
  const link = linkTo(port, { env: { CODEX_THREAD_ID: 'from-env' }, backoffMs: [20, 20] })
  await link.start()
  assert.equal(link.hostSessionId(), 'from-env')
  const first = link.sessionId()
  // The hub forgets the session (as if it restarted): the link registers again.
  await fetch(`http://127.0.0.1:${port}/sessions/${first}`, { method: 'DELETE', headers: { 'x-interccom-token': TOKEN } })
  await waitFor(() => link.sessionId() && link.sessionId() !== first)
  const rows = (await (await fetch(`http://127.0.0.1:${port}/board`, { headers: { 'x-interccom-token': TOKEN } })).json()).sessions
  assert.deepEqual(rows.map(r => r.hostSessionId), ['from-env'])
  void hub
})

test('codexHook stays silent: bad JSON, unknown events, no hub, hub errors', async () => {
  const find = async () => ({ port: 1, token: 'x' })
  assert.equal(await codexHook('not json', { find }), '')
  assert.equal(await codexHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's' }), { find }), '')
  assert.equal(await codexHook(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), { find: async () => null }), '')
  assert.equal(await codexHook(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), { find }), '') // nothing listening on port 1
  const fetchFn = async () => new Response('{"error":"x"}', { status: 400 })
  assert.equal(await codexHook(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), { find, fetchFn }), '')
})

test('a generic MCP host is speak-only and gets instructions without a tag', async () => {
  const { port } = await liveHub()
  const link = linkTo(port, { host: 'gemini' })
  await link.start()
  assert.equal(link.delivery, 'none')
  assert.equal(link.tag, '')
})

// ---- the real CLI over stdio, with a real detached hub ----

test('interccom mcp over stdio: initialize, tools/list, speak through a real hub', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interccom-mcp-'))
  dirs.push(stateDir)
  const cli = fileURLToPath(new URL('../../hub/cli.mjs', import.meta.url))
  const child = spawn(process.execPath, [cli, 'mcp', '--host', 'codex', '--cwd', '/w/demo'], {
    env: { ...process.env, INTERCCOM_STATE_DIR: stateDir, INTERCCOM_NO_KEY_FALLBACK: '1', INTERCCOM_LISTEN_MODE: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const replies = []
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
  })
  const send = m => child.stdin.write(JSON.stringify(m) + '\n')
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await waitFor(() => replies.length >= 2, 5000)
    assert.equal(replies[0].result.serverInfo.name, 'interccom')
    assert.match(replies[0].result.instructions, /Your session is called demo/)
    assert.deepEqual(replies[1].result.tools.map(t => t.name), ['speak', 'board'])
    // The link comes up in the background: retry until the hub has the session.
    await waitFor(async () => {
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'board', arguments: {} } })
      await new Promise(r => setTimeout(r, 200))
      const last = replies.filter(r => r.id === 3).at(-1)
      return last && !last.result.isError && JSON.parse(last.result.content[0].text).sessions.some(s => s.name === 'demo' && s.host === 'codex')
    }, 15000)
  } finally {
    child.stdin.end()
    await new Promise(r => child.on('close', r))
  }
})

test('codex-setup prints a TOML MCP entry and a hooks.json for all four events, with quoted paths', () => {
  const txt = codexSetupText('C:\\Program Files\\nodejs\\node.exe', 'C:\\x y\\hub\\cli.mjs')
  assert.ok(txt.includes('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'))
  assert.ok(txt.includes('args = ["C:\\\\x y\\\\hub\\\\cli.mjs", "mcp", "--host", "codex"]'))
  const json = JSON.parse(txt.slice(txt.indexOf('{\n'), txt.lastIndexOf('}') + 1))
  assert.deepEqual(Object.keys(json.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'])
  assert.equal(json.hooks.Stop[0].hooks[0].command, '"C:\\Program Files\\nodejs\\node.exe" "C:\\x y\\hub\\cli.mjs" codex-hook')
})
