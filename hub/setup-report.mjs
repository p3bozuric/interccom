// The setup check: what interccom will use and what's missing, with the fix for each.
// Pure: the hub passes in its config and what it found on this machine.
import { PROVIDERS, problem, resolved } from './engines/index.mjs'

function line(ok, text) {
  return `${ok ? '✓' : '✗'} ${text}`
}

function describe(cfg, dir) {
  const r = resolved(cfg, dir)
  const p = PROVIDERS[r.engine]
  const parts = [p?.label ?? r.engine]
  if (r.engine === 'local') parts.push(dir === 'tts' ? cfg.localTtsUrl : cfg.localSttUrl)
  if (r.engine === 'command') parts.push(`"${(dir === 'tts' ? cfg.ttsCommand : cfg.sttCommand) || ''}"`)
  else if (r.model) parts.push(`model ${r.model}`)
  if (dir === 'tts' && r.voice && r.engine !== 'command') parts.push(`voice ${r.voice}`)
  return parts.join(', ')
}

// machine: { ffmpeg: bool, player: { name, ok }, mic: { state, name, error } }
export function setupReport(cfg, machine = {}) {
  const problems = []
  const lines = ['interccom setup']
  for (const dir of ['tts', 'stt']) {
    const why = problem(cfg, dir)
    lines.push(line(!why, `${dir === 'tts' ? 'Talking' : 'Listening'}: ${describe(cfg, dir)}`))
    if (why) { lines.push(`    → ${why}`); problems.push(why) }
  }
  if (machine.ffmpeg !== undefined) {
    lines.push(line(machine.ffmpeg, 'ffmpeg (microphone capture)'))
    if (!machine.ffmpeg) { const fix = machine.ffmpegHint || 'Install FFmpeg and make sure ffmpeg is on PATH.'; lines.push(`    → ${fix}`); problems.push(fix) }
  }
  if (machine.player) {
    lines.push(line(machine.player.ok, `${machine.player.name} (playback)`))
    if (!machine.player.ok) { const fix = machine.player.hint || `Install ${machine.player.name}.`; lines.push(`    → ${fix}`); problems.push(fix) }
  }
  const mode = cfg.listenMode || 'wake'
  if (mode === 'off') lines.push('· Listening is off (/listen wake or always turns it on).')
  else if (machine.mic) {
    const ok = machine.mic.state === 'listening'
    lines.push(line(ok, `Microphone: ${machine.mic.name || (ok ? 'listening' : 'not listening')} (mode ${mode}${mode === 'wake' ? ': start with "Hey Claude"' : ''})`))
    if (!ok && machine.mic.error) { lines.push(`    → ${machine.mic.error}`); problems.push(machine.mic.error) }
  }
  lines.push(problems.length
    ? 'Change engines and keys in the interccom settings (Claude Code: /plugin → interccom → configure; other agents: interccom setup).'
    : 'All set. "/interccom setup test" (or interccom setup --test) plays a test line.')
  return { ok: problems.length === 0, problems, text: lines.join('\n') }
}
