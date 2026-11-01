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
