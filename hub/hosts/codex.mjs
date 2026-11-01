// Codex CLI specifics: hook output shapes, and running `codex queue` without a shell.
import { existsSync } from 'node:fs'
import path from 'node:path'

// Codex hook events (hook_event_name) mapped to what the hub needs to know.
export const CODEX_EVENTS = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PostToolUse: 'tool',
  Stop: 'stop',
}

// The JSON a Codex command hook prints for the hub's answer; '' prints nothing.
export function hookOutput(hookEventName, answer = {}) {
  if (hookEventName === 'Stop') {
    return answer.block ? JSON.stringify({ decision: 'block', reason: answer.block }) : ''
  }
  if (!answer.context) return ''
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: answer.context } })
}

// How to start Codex with no shell, so a transcript can never be read as shell syntax.
// INTERCCOM_CODEX_BIN overrides (a .js entry runs under this Node). On Windows, npm installs
// `codex.cmd`, which needs a shell; run its JavaScript entry with Node instead.
export function resolveCodexArgv({ env = process.env, platform = process.platform, exists = existsSync, execPath = process.execPath } = {}) {
  const override = env.INTERCCOM_CODEX_BIN
  if (override) return override.endsWith('.js') ? [execPath, override] : [override]
  if (platform !== 'win32') return ['codex']
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    const exe = path.win32.join(dir, 'codex.exe')
    if (exists(exe)) return [exe]
    if (exists(path.win32.join(dir, 'codex.cmd'))) {
      const js = path.win32.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (exists(js)) return [execPath, js]
    }
  }
  return null
}

export function queueArgv(base, { hostSessionId, text, cwd }) {
  return [...base, 'queue', '--thread', hostSessionId, '--message', text, '--resume', ...(cwd ? ['-C', cwd] : [])]
}
