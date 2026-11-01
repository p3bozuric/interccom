// Loader files that plug interccom into Copilot CLI and OpenCode. Each is a few lines in
// the tool's own extension/plugin folder that import the adapter from this install, so an
// update of interccom needs no new setup. Never overwrites a file interccom didn't write.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MARKER = '// Installed by interccom'
const here = file => new URL(`./${file}`, import.meta.url).href

export function copilotTarget(env = process.env, home = os.homedir()) {
  return path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'extensions', 'interccom', 'extension.mjs')
}

export function opencodeTarget(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'plugins', 'interccom.js')
}

export function copilotLoader(adapterUrl = here('copilot.mjs')) {
  return `${MARKER} (interccom copilot-setup). Remove with: interccom copilot-setup --remove
// Copilot resolves @github/copilot-sdk for extensions; interccom itself lives at the URL below.
import { joinSession } from "@github/copilot-sdk/extension"
import { runCopilotExtension } from ${JSON.stringify(adapterUrl)}

await runCopilotExtension({ joinSession })
`
}

export function opencodeLoader(adapterUrl = here('opencode.mjs')) {
  return `${MARKER} (interccom opencode-setup). Remove with: interccom opencode-setup --remove
// OpenCode installs @opencode-ai/plugin in its config folder; interccom itself lives at the URL below.
import { tool } from "@opencode-ai/plugin"
import { createOpencodePlugin } from ${JSON.stringify(adapterUrl)}

export const Interccom = createOpencodePlugin({ tool })
`
}

// Returns a line saying what happened; throws when it would clobber someone else's file.
export function installLoader(file, content, { remove = false, fs = { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } } = {}) {
  const ours = fs.existsSync(file) && fs.readFileSync(file, 'utf8').startsWith(MARKER)
  if (fs.existsSync(file) && !ours) throw new Error(`${file} exists and wasn't written by interccom; leaving it alone.`)
  if (remove) {
    if (!ours) return `Nothing to remove at ${file}.`
    fs.rmSync(file, { force: true })
    return `Removed ${file}.`
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return `${ours ? 'Updated' : 'Wrote'} ${file}.`
}
