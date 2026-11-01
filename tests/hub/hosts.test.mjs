import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hookOutput, resolveCodexArgv, queueArgv, CODEX_EVENTS } from '../../hub/hosts/codex.mjs'
import { hostGuidance, genericInstructions, voiceNote } from '../../hub/hosts/text.mjs'
import { normWords, samePath } from '../../hub/server.mjs'
import { guidance } from '../../hooks/guidance.ts'
import { createDelivery } from '../../hooks/delivery.ts'

test('Codex hook output: context for SessionStart/UserPromptSubmit/PostToolUse, block for Stop, else nothing', () => {
  assert.equal(hookOutput('PostToolUse', { context: 'note' }),
    '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"note"}}')
  assert.equal(hookOutput('SessionStart', {}), '')
  assert.equal(hookOutput('Stop', { block: 'note' }), '{"decision":"block","reason":"note"}')
  assert.equal(hookOutput('Stop', {}), '')
  assert.deepEqual(Object.keys(CODEX_EVENTS), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'])
})

test('resolveCodexArgv: override, plain codex off Windows, codex.exe or the npm JS entry on Windows', () => {
  assert.deepEqual(resolveCodexArgv({ env: { INTERCCOM_CODEX_BIN: '/x/codex.js' }, execPath: 'node' }), ['node', '/x/codex.js'])
  assert.deepEqual(resolveCodexArgv({ env: { INTERCCOM_CODEX_BIN: '/x/codex' } }), ['/x/codex'])
  assert.deepEqual(resolveCodexArgv({ env: {}, platform: 'darwin' }), ['codex'])
  const files = new Set(['C:\\npm\\codex.cmd', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'C:\\bin\\codex.exe'])
  const exists = f => files.has(f)
  assert.deepEqual(resolveCodexArgv({ env: { Path: 'C:\\npm;C:\\bin' }, platform: 'win32', exists, execPath: 'node.exe' }),
    ['node.exe', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'])
  assert.deepEqual(resolveCodexArgv({ env: { PATH: 'C:\\bin;C:\\npm' }, platform: 'win32', exists }), ['C:\\bin\\codex.exe'])
  assert.equal(resolveCodexArgv({ env: { PATH: 'C:\\none' }, platform: 'win32', exists }), null)
})

test('queueArgv passes the text as one argument', () => {
  assert.deepEqual(queueArgv(['codex'], { hostSessionId: 't', text: 'a; rm -rf / & "x"', cwd: '/w' }),
    ['codex', 'queue', '--thread', 't', '--message', 'a; rm -rf / & "x"', '--resume', '-C', '/w'])
})

test('host guidance says the same as the Claude Code guidance, bar the tool name', () => {
  const claude = guidance('api', 'T').replace('`mcp__interccom__speak` tool', 'interccom `speak` tool')
    .replace('When a tool result carries', 'When extra context carries').replace('(interccom plugin)', '(interccom)')
  assert.equal(hostGuidance('api', 'T'), claude)
  assert.ok(!genericInstructions('api').includes('interccom:'))
  const d = createDelivery('T'); d.setBusy(true); d.heard('x')
  assert.equal(voiceNote('T', ['x']), d.takeForToolResult())
})

test('normWords and samePath', () => {
  assert.equal(normWords('  Use PORT 8080, please! '), 'use port 8080 please')
  assert.equal(normWords('Čekaj, molim'), 'čekaj molim')
  assert.ok(samePath('C:\\W\\cx', 'c:/w/cx/', 'win32'))
  assert.ok(!samePath('/W/cx', '/w/cx', 'linux'))
  assert.ok(samePath('/w/cx/', '/w/cx', 'linux'))
  assert.ok(!samePath('', '', 'linux'))
})

import { GEMINI_EVENTS, geminiHookOutput, geminiExtensionFiles, geminiExtensionDir } from '../../hub/hosts/gemini.mjs'
import { geminiSetup } from '../../hub/cli.mjs'

test('gemini: events, hook output shapes, and the extension files', () => {
  assert.deepEqual(GEMINI_EVENTS, { SessionStart: 'session-start', BeforeAgent: 'prompt', AfterTool: 'tool', AfterAgent: 'stop' })
  assert.equal(geminiHookOutput('AfterTool', { context: 'note' }), '{"hookSpecificOutput":{"hookEventName":"AfterTool","additionalContext":"note"}}')
  assert.equal(geminiHookOutput('BeforeAgent', {}), '{}')
  assert.equal(geminiHookOutput('AfterAgent', { block: 'note' }), '{"decision":"deny","reason":"note"}')
  assert.equal(geminiHookOutput('AfterAgent', {}), '{}')
  const files = geminiExtensionFiles('/n/node', '/x y/hub/cli.mjs', '9.9.9')
  const manifest = JSON.parse(files['gemini-extension.json'])
  assert.equal(manifest.name, 'interccom')
  assert.deepEqual(manifest.mcpServers.interccom, { command: '/n/node', args: ['/x y/hub/cli.mjs', 'mcp', '--host', 'gemini'] })
  const hooks = JSON.parse(Object.entries(files).find(([f]) => f.endsWith('hooks.json'))[1]).hooks
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent'])
  assert.equal(hooks.AfterTool[0].matcher, '.*')
  assert.equal(hooks.SessionStart[0].hooks[0].command, '"/n/node" "/x y/hub/cli.mjs" gemini-hook')
  assert.match(geminiExtensionDir({ INTERCCOM_STATE_DIR: '/s' }), /[\\/]s[\\/]gemini[\\/]interccom$/)
})

test('gemini-setup writes, refuses someone else\'s folder, and removes', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'interccom-gemini-'))
  try {
    const env = { INTERCCOM_STATE_DIR: d }
    assert.match(await geminiSetup({ env }), /gemini extensions link/)
    const dir = geminiExtensionDir(env)
    assert.ok(fs.existsSync(path.join(dir, 'hooks', 'hooks.json')))
    assert.match(await geminiSetup({ env }), /Wrote/)
    assert.match(await geminiSetup({ env, remove: true }), /Removed/)
    assert.ok(!fs.existsSync(dir))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'gemini-extension.json'), '{"name":"someone-else"}')
    await assert.rejects(geminiSetup({ env }), /isn't interccom's/)
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})
