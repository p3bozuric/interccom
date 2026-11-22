import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waveText, waveSvg, dictationPiece } from '../../hooks/wave.ts'

test('the text wave: one bar per recent level, newest on the right, padded low', () => {
  assert.equal(waveText([]), '▁▁▁▁▁▁▁▁')
  assert.equal(waveText([0, 0.5, 1]), '▁▁▁▁▁▁▅█')
  assert.equal(waveText([2, -1], 2), '█▁')
  assert.equal(waveText([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]).length, 8)
})

test('the drawn wave: bars fill from the left, dots for slots not reached, one rect per slot', () => {
  const svg = waveSvg([1, 0.5, 0], 4)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="18" height="18" viewBox="0 0 18 18">/)
  const heights = [...svg.matchAll(/height="(\d+)" rx/g)].map(m => Number(m[1]))
  assert.deepEqual(heights, [18, 9, 3, 3])
  const ys = [...svg.matchAll(/ y="([\d.]+)"/g)].map(m => Number(m[1]))
  assert.deepEqual(ys, [0, 4.5, 7.5, 7.5], 'centred vertically')
  // Past the slots it keeps the newest; nonsense levels draw as dots.
  assert.equal([...waveSvg(Array(40).fill(1)).matchAll(/<rect /g)].length, 16)
  assert.match(waveSvg([NaN]), /height="3" rx/)
  assert.doesNotMatch(waveSvg([1]), /script|on\w+=/i)
})

test('dictation: words join what is before the cursor with one space', () => {
  assert.equal(dictationPiece('', 'Hello there.'), 'Hello there.')
  assert.equal(dictationPiece('Fix the', ' bug '), ' bug')
  assert.equal(dictationPiece('Fix the ', 'bug'), 'bug')
  assert.equal(dictationPiece('line one\n', 'line two'), 'line two')
  assert.equal(dictationPiece('x', '   '), '')
})
