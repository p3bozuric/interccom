import { normalizeName } from './board.mjs'

const WAKE = /^\s*(?:(?:hey|hi|okay|ok)[\s,.!-]*(?:claude|claud|cloud|clod|klod)|claude)\b[\s,.!?:-]*/i
const STOP = /^(stop|quiet|be quiet|shut up)\W*$/i
const NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' }
// The first `n` words, then `,` / `:` or just a space, then the rest.
const HEADS = [1, 2, 3].map(n => new RegExp(String.raw`^((?:[^\s,:]+\s+){${n - 1}}[^\s,:]+)(?:\s*[,:]\s*|\s+)(\S.*)$`, 's'))

// A spoken name as the board would store it: "API two" -> "api-2".
function spokenName(words) {
  return normalizeName(words.split(/\s+/).map(w => NUMBERS[w.toLowerCase().replace(/[^a-z]/g, '')] ?? w).join(' '))
}

// Tries the first 3, 2, then 1 words as a session name; the longest match wins.
function addressed(rest, names) {
  const known = new Map(names.map(n => [normalizeName(n), n]))
  for (let n = 3; n >= 1; n--) {
    const m = HEADS[n - 1].exec(rest)
    if (!m) continue
    const name = known.get(spokenName(m[1]))
    if (name !== undefined) return { name, text: m[2].trim() }
  }
  return undefined
}

export function route(text, ctx) {
  const { mode, names, armedUntil, now, armMs = 10000 } = ctx
  if (mode === 'off') return { kind: 'ignore' }
  const wake = WAKE.exec(text)
  let rest
  if (wake) {
    rest = text.slice(wake[0].length).trim()
    if (!rest) return { kind: 'arm', until: now + armMs }
  } else if (mode === 'always' || armedUntil > now) {
    rest = text.trim()
  } else {
    return { kind: 'ignore' }
  }
  if (!rest) return { kind: 'ignore' }
  if (STOP.test(rest)) return { kind: 'stop' }
  const hit = addressed(rest, names)
  if (hit) return { kind: 'deliver', text: hit.text, name: hit.name }
  return { kind: 'deliver', text: rest }
}
