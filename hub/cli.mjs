#!/usr/bin/env node
// interccom command line (the npm package's bin).
//   interccom mcp [--host codex] [--name <n>] [--cwd <dir>]   MCP server for any agent
//   interccom codex-hook                                      Codex command hook (stdin JSON)
//   interccom codex-setup                                     print manual Codex config
//   interccom copilot-setup [--print|--remove]                install the Copilot CLI extension
//   interccom opencode-setup [--print|--remove]               install the OpenCode plugin
//   interccom --version
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const cliPath = fileURLToPath(import.meta.url)

const USAGE = `interccom ${pkg.version}: one voice for all your coding agents.

Usage:
  interccom mcp [--host codex] [--name <name>] [--cwd <dir>]
  interccom codex-hook
  interccom codex-setup
  interccom copilot-setup [--print | --remove]
  interccom opencode-setup [--print | --remove]
  interccom --version`

// TOML basic strings and JSON share escaping for what a path can contain.
const q = s => JSON.stringify(s)

export function codexSetupText(node = process.execPath, cli = cliPath) {
  // A shell command line, not JSON: plain double quotes (a Windows path can't contain one).
  const hookCmd = `"${node}" "${cli}" codex-hook`
  const hook = { type: 'command', command: hookCmd }
  const hooks = {
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].map(e => [e, [{ hooks: [hook] }]])),
  }
  return `# interccom for Codex: manual setup
# Prefer the plugin: codex plugin marketplace add p3bozuric/interccom, then codex plugin add interccom.
# Without it, add the two pieces below. Paths are this machine's.

# 1. ~/.codex/config.toml: the speak/board tools (and this session's link to the hub)
[mcp_servers.interccom]
command = ${q(node)}
args = [${q(cli)}, "mcp", "--host", "codex"]
# Optional: settings, the same INTERCCOM_* variables as the Claude Code plugin uses
# env = { INTERCCOM_TTS_ENGINE = "local", INTERCCOM_STT_ENGINE = "local" }

# 2. ~/.codex/hooks.json: hearing (guidance at start, speech mid-turn and at turn end)
${JSON.stringify(hooks, null, 2)}

# Keep Codex's own voice input off while interccom listens: only one program can own the mic.
`
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === '--version' || cmd === '-v') { console.log(pkg.version); return }
  if (cmd === 'mcp') {
    const { values } = parseArgs({ args: rest, options: { host: { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' } } })
    const { runMcp } = await import('./mcp.mjs')
    await runMcp({ host: values.host || 'mcp', name: values.name, cwd: values.cwd || process.cwd(), version: pkg.version })
    return
  }
  if (cmd === 'codex-hook') {
    const { runCodexHook } = await import('./codex-hook.mjs')
    await runCodexHook()
    return
  }
  if (cmd === 'codex-setup') { process.stdout.write(codexSetupText()); return }
  if (cmd === 'copilot-setup' || cmd === 'opencode-setup') {
    const { values } = parseArgs({ args: rest, options: { print: { type: 'boolean' }, remove: { type: 'boolean' } } })
    const setup = await import('./hosts/setup.mjs')
    const copilot = cmd === 'copilot-setup'
    const file = copilot ? setup.copilotTarget() : setup.opencodeTarget()
    const content = copilot ? setup.copilotLoader() : setup.opencodeLoader()
    if (values.print) { process.stdout.write(`# ${file}\n${content}`); return }
    console.log(setup.installLoader(file, content, { remove: values.remove }))
    if (!values.remove) {
      console.log(copilot
        ? 'Restart Copilot CLI (or run /clear) to load it. Keep Copilot\'s own voice input off while interccom listens.'
        : 'Restart OpenCode to load it. Settings: INTERCCOM_* environment variables, set before starting opencode.')
    }
    return
  }
  console.log(USAGE)
  if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  await main(process.argv.slice(2))
}
