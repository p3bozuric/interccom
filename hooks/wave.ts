// Pure helpers for what the bar shows while the person speaks, and for dictation.
// No imports: tests load this file straight into Node.

export const WAVE_TEXT_WIDTH = 8 // bars in the terminal's text wave
export const WAVE_SLOTS = 16 // bars in the desktop's drawn wave, and the levels kept

// A little sound wave from recent loudness (0..1), newest on the right: "▁▂▅▇▆▃▁▁".
export function waveText(values: readonly number[], width = WAVE_TEXT_WIDTH): string {
  const bars = '▁▂▃▄▅▆▇█'
  const recent = values.slice(-width)
  const padded = [...Array(Math.max(0, width - recent.length)).fill(0), ...recent]
  return padded.map(v => bars[Math.round(clamp(v) * (bars.length - 1))]).join('')
}

const BAR = 3 // px wide, and the height of a quiet slot (a dot)
const GAP = 2
const HEIGHT = 18

// The same wave drawn as an SVG for surfaces that draw one (desktop, editor, phone), like the
// desktop's own dictation meter: rounded bars filling from the left, dots for the slots not
// reached yet; once full it scrolls, newest on the right.
export function waveSvg(values: readonly number[], slots = WAVE_SLOTS): string {
  const recent = values.slice(-slots)
  const width = slots * (BAR + GAP) - GAP
  const rects: string[] = []
  for (let i = 0; i < slots; i++) {
    const h = i < recent.length ? Math.max(BAR, Math.round(clamp(recent[i] ?? 0) * HEIGHT)) : BAR
    const y = (HEIGHT - h) / 2
    rects.push(`<rect x="${i * (BAR + GAP)}" y="${y}" width="${BAR}" height="${h}" rx="1.5" fill="#a1a1aa"/>`)
  }
  // Drawn as an image, so it can't read the app's theme: a grey that reads on dark and light,
  // a little darker where the system is light.
  const style = '<style>@media (prefers-color-scheme: light){rect{fill:#71717a}}</style>'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">${style}${rects.join('')}</svg>`
}

// Dictated words as they go into the prompt box at the cursor: a space first when they would
// otherwise run into the word before.
export function dictationPiece(before: string, text: string): string {
  const t = text.trim()
  if (!t) return ''
  return before && !/\s$/.test(before) ? ` ${t}` : t
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
}
