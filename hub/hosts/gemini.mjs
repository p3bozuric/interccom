// Gemini CLI specifics: its hook events, the JSON its command hooks print, and the
// extension interccom gemini-setup writes (an MCP server for speak/board, plus hooks).
// Gemini has no command that starts a turn in an open session, so speech heard while it
// is idle waits in the hub and goes in with the person's next message (BeforeAgent).
import os from 'node:os'
import path from 'node:path'

// Gemini hook events (hook_event_name) mapped to what the hub needs to know.
export const GEMINI_EVENTS = {
  SessionStart: 'session-start',
  BeforeAgent: 'prompt',
  AfterTool: 'tool',
  AfterAgent: 'stop',
}

// What a Gemini command hook prints for the hub's answer. Gemini parses stdout as JSON
// and wants nothing else there, so "nothing to say" is an empty object.
export function geminiHookOutput(hookEventName, answer = {}) {
  if (hookEventName === 'AfterAgent') {
    // deny + reason sends the reason back to the agent as a new prompt: the turn goes on with it.
    return JSON.stringify(answer.block ? { decision: 'deny', reason: answer.block } : {})
  }
  if (!answer.context) return '{}'
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: answer.context } })
}

export function geminiExtensionDir(env = process.env, home = os.homedir()) {
  // Gemini expects the folder to carry the extension's name.
  return path.join(env.INTERCCOM_STATE_DIR || path.join(home, '.interccom'), 'gemini', 'interccom')
}

// The extension's two files, with this machine's Node and this install's CLI.
export function geminiExtensionFiles(node = process.execPath, cli, version = '0.0.0') {
  const manifest = {
    name: 'interccom',
    version,
    description: 'One voice for all your coding agents: Gemini speaks and hears through the interccom hub.',
    mcpServers: { interccom: { command: node, args: [cli, 'mcp', '--host', 'gemini'] } },
  }
  // A command line, not JSON: plain double quotes (a Windows path can't contain one).
  const hook = { name: 'interccom', type: 'command', command: `"${node}" "${cli}" gemini-hook`, timeout: 5000 }
  const hooks = {
    hooks: Object.fromEntries(Object.keys(GEMINI_EVENTS).map(e => [e, [
      e === 'AfterTool' ? { matcher: '.*', hooks: [hook] } : { hooks: [hook] },
    ]])),
  }
  return {
    'gemini-extension.json': JSON.stringify(manifest, null, 2) + '\n',
    [path.join('hooks', 'hooks.json')]: JSON.stringify(hooks, null, 2) + '\n',
  }
}
