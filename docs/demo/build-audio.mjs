// Lays the voice lines on a timeline, mixes them with the hub's real chimes, and writes
// timeline.js (for the page) plus a per-frame loudness envelope for the waveform.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chimeWav } from '../../hub/chime.mjs'

const FPS = 30
const lines = JSON.parse(fs.readFileSync('lines.json', 'utf8'))
const dur = id => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `audio/${id}.mp3`]).toString())

// Start times: fixed beats for the scenes, then each line follows the last with a gap.
const plan = [['u1', 9.0], ['u2', 1.0], ['c1', 1.2], ['c2', 0.6], ['c3', 0.6], ['u3', 0.8], ['c4', 1.3], ['u4', 'coord'], ['c5', 0.8]]
const T = {}
let end = 0
for (const [id, gap] of plan) {
  const start = gap === 'coord' ? end + 5.2 : (id === 'u1' ? gap : end + gap)
  const d = dur(id)
  const l = lines.find(x => x.id === id)
  T[id] = { start: +start.toFixed(3), dur: +d.toFixed(3), end: +(start + d).toFixed(3), who: l.who, text: l.text }
  end = start + d
}
const total = Math.ceil(end + 9.5)
fs.writeFileSync('timeline.js', `window.T = ${JSON.stringify(T, null, 1)};\nwindow.TOTAL = ${total};\nwindow.FPS = ${FPS};\n`)
fs.writeFileSync('audio/sent.wav', chimeWav('sent', 0.22))

// Mix: voices at their start times, a "sent" chime right after each of your lines.
const inputs = [], filters = [], labels = []
let i = 0
for (const [id, t] of Object.entries(T)) {
  inputs.push('-i', `audio/${id}.mp3`)
  filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(t.start * 1000)}:all=1[a${i}]`); labels.push(`[a${i}]`); i++
  if (t.who === 'you') {
    inputs.push('-i', 'audio/sent.wav')
    filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round((t.end + 0.12) * 1000)}:all=1[a${i}]`); labels.push(`[a${i}]`); i++
  }
}
filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,apad=whole_dur=${total}[out]`)
execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-t', String(total), '-c:a', 'pcm_s16le', 'mix.wav'])

// Loudness envelope, one value per video frame.
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', 'mix.wav', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 })
const per = 48000 / FPS, env = []
for (let f = 0; f * per * 2 < pcm.length; f++) {
  let s = 0, n = 0
  for (let k = f * per; k < (f + 1) * per && k * 2 < pcm.length; k++) { const v = pcm.readInt16LE(k * 2) / 32768; s += v * v; n++ }
  env.push(+Math.min(1, Math.sqrt(s / Math.max(n, 1)) * 5).toFixed(3))
}
fs.writeFileSync('envelope.js', `window.ENV = ${JSON.stringify(env)};\n`)
console.log('total', total, JSON.stringify(Object.fromEntries(Object.entries(T).map(([k, v]) => [k, [v.start, v.end]]))))
