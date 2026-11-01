import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('manifest names the plugin interccom', () => {
  const json = JSON.parse(
    readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  )
  assert.equal(json.name, 'interccom')
})

test('Codex plugin manifest points at files that exist, and its hooks run the CLI', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const root = new URL('../', import.meta.url)
  const read = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'))
  const m = read('.codex-plugin/plugin.json')
  assert.equal(m.name, 'interccom')
  assert.equal(m.version, read('package.json').version)
  assert.equal(m.version, read('.claude-plugin/plugin.json').version)
  for (const p of [m.mcpServers, m.hooks]) assert.ok(existsSync(new URL(p, root)), p)
  const mcp = read(m.mcpServers).mcpServers.interccom
  assert.deepEqual(mcp.args, ['${PLUGIN_ROOT}/hub/cli.mjs', 'mcp', '--host', 'codex'])
  const hooks = read(m.hooks).hooks
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'])
  for (const groups of Object.values(hooks)) assert.match(groups[0].hooks[0].command, /cli\.mjs" codex-hook$/)
  assert.equal(read('package.json').name, 'interccom')
  assert.equal(read('package.json').bin.interccom, 'hub/cli.mjs')
})
