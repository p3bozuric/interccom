// `interccom setup`: choose speech engines for every agent on this machine (Claude Code's own
// settings screen still wins for Claude Code sessions). Saves choices to ~/.interccom/config.json
// and never writes an API key anywhere: it says which environment variable to set instead.
//   interccom setup                       ask, in a terminal; just report when not interactive
//   interccom setup --tts deepgram --stt soniox [--voice v] [--tts-model m] [--stt-model m]
//                   [--language en] [--listen wake] [--local-tts-url u] [--local-stt-url u]
//                   [--tts-command c] [--stt-command c]
//   interccom setup --show                report only
//   interccom setup --test                report, then play a test line
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { PROVIDERS, TTS_ENGINES, STT_ENGINES } from './engines/index.mjs'
import { configFile, readConfigFile, configFromEnv } from './config-env.mjs'
import { resolveKey } from './keys.mjs'

export const FLAGS = {
  tts: 'tts_engine', stt: 'stt_engine', voice: 'tts_voice', 'tts-model': 'tts_model', 'stt-model': 'stt_model',
  language: 'stt_language', listen: 'listen_mode', 'local-tts-url': 'local_tts_url', 'local-stt-url': 'local_stt_url',
  'tts-command': 'tts_command', 'stt-command': 'stt_command',
}
const MODES = ['wake', 'always', 'off']

// Checks a set of choices; returns the first problem, or ''.
export function validate(choices) {
  if (choices.tts_engine && !TTS_ENGINES.includes(choices.tts_engine)) return `Talking engine must be one of: ${TTS_ENGINES.join(', ')}.`
  if (choices.stt_engine && !STT_ENGINES.includes(choices.stt_engine)) return `Listening engine must be one of: ${STT_ENGINES.join(', ')}.`
  if (choices.listen_mode && !MODES.includes(choices.listen_mode)) return `Listening mode must be one of: ${MODES.join(', ')}.`
  return ''
}

// Merge into the existing file; blank values remove a setting. Keys are refused outright.
export function saveChoices(file, current, choices, write = writeFileSync, mkdir = mkdirSync) {
  const next = { ...current }
  for (const [k, v] of Object.entries(choices)) {
    if (/api_key$/.test(k)) throw new Error('interccom setup never saves API keys; set them as environment variables.')
    if (v === undefined) continue
    if (v === null || String(v).trim() === '') delete next[k]
    else next[k] = String(v).trim()
  }
  mkdir(path.dirname(file), { recursive: true })
  write(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

// How to set a key on this platform, for each chosen cloud provider still missing one.
export function keyAdvice(choices, { env = process.env, platform = process.platform, readRegistry } = {}) {
  const out = []
  const engines = new Set([choices.tts_engine || 'elevenlabs', choices.stt_engine || 'elevenlabs'])
  for (const engine of engines) {
    const p = PROVIDERS[engine]
    if (!p?.env) continue
    const have = resolveKey({ configKey: '', envName: p.env, env, platform, ...(readRegistry ? { readRegistry } : {}) })
    if (have) { out.push(`✓ ${p.label} key found in ${p.env}.`); continue }
    const how = platform === 'win32'
      ? `setx ${p.env} "<your key>"   (open a new terminal afterwards)`
      : `export ${p.env}="<your key>"   (add it to your shell profile)`
    out.push(`✗ ${p.label} needs an API key (${p.signup}):\n    ${how}`)
  }
  return out
}

function list(names, dir) {
  return names.map(n => {
    const p = PROVIDERS[n]
    const d = p[dir]?.model ? ` (default model ${p[dir].model})` : ''
    const where = n === 'local' ? ' — your own OpenAI-compatible server' : n === 'command' ? ' — any program, e.g. Piper / whisper-cli' : ''
    return `  ${n}${where}${d}`
  }).join('\n')
}

async function ask(rl, question, fallback, allowed) {
  for (;;) {
    const a = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim()
    const v = a || fallback || ''
    if (!allowed || allowed.includes(v)) return v
    console.log(`  Choose one of: ${allowed.join(', ')}`)
  }
}

export async function interactive(current, rl) {
  const c = {}
  console.log(`Talking (text to speech):\n${list(TTS_ENGINES, 'tts')}`)
  c.tts_engine = await ask(rl, 'Talking engine', current.tts_engine || 'elevenlabs', TTS_ENGINES)
  console.log(`\nListening (speech to text):\n${list(STT_ENGINES, 'stt')}`)
  c.stt_engine = await ask(rl, 'Listening engine', current.stt_engine || 'elevenlabs', STT_ENGINES)
  if (c.tts_engine === 'local') c.local_tts_url = await ask(rl, 'Local TTS server URL', current.local_tts_url || 'http://127.0.0.1:8880/v1')
  if (c.stt_engine === 'local') c.local_stt_url = await ask(rl, 'Local STT server URL', current.local_stt_url || 'http://127.0.0.1:8000/v1')
  if (c.tts_engine === 'command') c.tts_command = await ask(rl, 'TTS command (text on stdin, audio to {out})', current.tts_command)
  if (c.stt_engine === 'command') c.stt_command = await ask(rl, 'STT command (WAV at {in}, prints text)', current.stt_command)
  const keepModel = (dir, engine) => (current[`${dir}_engine`] === engine ? current : {})
  c.tts_voice = await ask(rl, 'Voice (blank: engine default)', keepModel('tts', c.tts_engine).tts_voice)
  c.tts_model = await ask(rl, 'Talking model (blank: engine default)', keepModel('tts', c.tts_engine).tts_model)
  c.stt_model = await ask(rl, 'Listening model (blank: engine default)', keepModel('stt', c.stt_engine).stt_model)
  c.stt_language = await ask(rl, 'Language you speak (en, hr, ..., or auto)', current.stt_language || 'en')
  c.listen_mode = await ask(rl, 'Listening mode (wake, always, off)', current.listen_mode || 'wake', MODES)
  return c
}

// Talk to the hub (starting it if needed) with these settings, for the report and the test line.
async function withHub(env, fn) {
  const { ensureHub } = await import('./launch.mjs')
  const { defaultStateDir, HUB_ENTRY } = await import('./mcp.mjs')
  const hub = await ensureHub({ stateDir: defaultStateDir(env), hubEntry: HUB_ENTRY })
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${hub.port}${p}`, {
      method, headers: { 'x-interccom-token': hub.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(out.error || `hub answered ${res.status}`)
    return out
  }
  await call('POST', '/config', configFromEnv(env))
  return fn(call)
}

export async function runSetup(args, { env = process.env, stdin = process.stdin, hub = withHub } = {}) {
  const { parseArgs } = await import('node:util')
  const options = Object.fromEntries(Object.keys(FLAGS).map(f => [f, { type: 'string' }]))
  options.show = { type: 'boolean' }
  options.test = { type: 'boolean' }
  const { values } = parseArgs({ args, options })
  const file = configFile(env)
  const current = readConfigFile(file)
  let choices = Object.fromEntries(Object.entries(FLAGS).filter(([f]) => values[f] !== undefined).map(([f, s]) => [s, values[f]]))

  // The wizard runs only for a bare `setup`; flags are saved even next to --show or --test.
  if (!Object.keys(choices).length && !values.show && !values.test && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: process.stdout })
    try { choices = await interactive(current, rl) } finally { rl.close() }
  }
  if (Object.keys(choices).length) {
    const bad = validate(choices)
    if (bad) { console.error(bad); process.exitCode = 1; return }
    const saved = saveChoices(file, current, choices)
    console.log(`\nSaved to ${file}.`)
    for (const l of keyAdvice(saved, { env })) console.log(l)
    console.log('Claude Code sessions use their own plugin settings (/plugin → interccom → configure) instead.\n')
  }
  try {
    await hub(env, async call => {
      const report = await call('GET', '/setup')
      console.log(report.text)
      if (values.test) {
        const reg = await call('POST', '/sessions', { name: 'setup', cwd: process.cwd(), host: 'setup', delivery: 'none' })
        await call('POST', '/setup/test', { sessionId: reg.sessionId })
        console.log('Playing a test line…')
        await new Promise(r => setTimeout(r, 6000))
        await call('DELETE', `/sessions/${reg.sessionId}`).catch(() => {})
      }
    })
  } catch (err) {
    console.error(`Couldn't reach the interccom hub: ${err?.message ?? err}`)
    process.exitCode = 1
  }
}
