import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waveText } from '../../hooks/hub-link.ts'

test('the sound wave: one bar per recent level, newest on the right, padded low', () => {
  assert.equal(waveText([]), '▁▁▁▁▁▁▁▁')
  assert.equal(waveText([0, 0.5, 1]), '▁▁▁▁▁▁▅█')
  assert.equal(waveText([2, -1], 2), '█▁')
  assert.equal(waveText([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]).length, 8)
})
