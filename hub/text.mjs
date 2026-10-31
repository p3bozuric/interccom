export function toSpeakable(text, max = 400) {
  let s = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*>/gm, '')
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  const head = s.slice(0, max + 1)
  let cut = -1
  for (const m of head.matchAll(/[.!?] /g)) cut = m.index
  if (cut >= 0) return s.slice(0, cut + 1)
  return s.slice(0, max)
}
