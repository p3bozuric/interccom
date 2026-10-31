import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pcmToWav } from '../../hub/wav.mjs'

test('pcmToWav writes a 44-byte mono 16-bit header', () => {
  const wav = pcmToWav(Buffer.alloc(32000))
  assert.equal(wav.length, 32044)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(4), 36 + 32000)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt32LE(28), 32000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), 32000)
})

test('pcmToWav honours a custom sample rate', () => {
  const wav = pcmToWav(Buffer.alloc(10), 8000)
  assert.equal(wav.readUInt32LE(24), 8000)
  assert.equal(wav.readUInt32LE(28), 16000)
})
