import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chimeWav, CHIMES } from '../../hub/chime.mjs'

test('chimes are short, quiet mono WAVs that start and end silent', () => {
  assert.deepEqual(CHIMES, ['armed', 'sent'])
  for (const name of CHIMES) {
    const wav = chimeWav(name)
    assert.equal(wav.toString('latin1', 0, 4), 'RIFF')
    const samples = (wav.length - 44) / 2
    const rate = wav.readUInt32LE(24)
    assert.ok(samples / rate < 0.3, `${name} is under 300 ms`)
    let peak = 0
    for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)))
    assert.ok(peak > 0 && peak <= 0.25 * 32767 + 1, `${name} peaks at a quarter volume`)
    assert.equal(wav.readInt16LE(44), 0)
    assert.equal(wav.readInt16LE(wav.length - 2), 0)
  }
  assert.throws(() => chimeWav('nope'), /unknown chime/)
})
