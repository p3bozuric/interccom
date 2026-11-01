// Regenerate: node scripts/make-icon.mjs .claude-plugin/icon.png
// Draws the interccom icon: five sound-wave bars on a rounded square, 1024 px, 4x supersampled.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
const N = 1024, SS = 4
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
const lerp = (a, b, t) => a + (b - a) * t
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
const bg = [[30, 27, 75], [49, 46, 129]] // indigo, top to bottom
const bar = [[167, 139, 250], [34, 211, 238]] // violet to cyan, left to right
const heights = [0.30, 0.52, 0.72, 0.52, 0.30]
const bw = 92, gap = 52, total = 5 * bw + 4 * gap, left = (N - total) / 2
const raw = Buffer.alloc(N * (N * 4 + 1))
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS
      if (!inRoundRect(px, py, 0, 0, N, N, 220)) continue
      let c = bg[0].map((v, i) => lerp(v, bg[1][i], py / N))
      for (let i = 0; i < 5; i++) {
        const x0 = left + i * (bw + gap), h = heights[i] * N
        if (inRoundRect(px, py, x0, (N - h) / 2, x0 + bw, (N + h) / 2, bw / 2)) c = bar[0].map((v, k) => lerp(v, bar[1][k], (px - left) / total))
      }
      r += c[0]; g += c[1]; b += c[2]; a += 255
    }
    const n = SS * SS, o = y * (N * 4 + 1) + 1 + x * 4
    const cov = a / 255 || 1
    raw[o] = Math.round(r / cov); raw[o + 1] = Math.round(g / cov); raw[o + 2] = Math.round(b / cov); raw[o + 3] = Math.round(a / n)
  }
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6
writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]))
