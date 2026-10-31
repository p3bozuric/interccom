import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVad } from '../../hub/vad.mjs'

const N = 480
function tone(amplitude) {
  const b = Buffer.alloc(N * 2)
  for (let i = 0; i < N; i++) b.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2)
  return b
}
const silence = () => Buffer.alloc(N * 2)

test('ignores silence', () => {
  const vad = createVad()
  for (let i = 0; i < 200; i++) assert.equal(vad.push(silence()), null)
})

test('ends after 54 quiet frames', () => {
  const vad = createVad()
  for (let i = 0; i < 20; i++) assert.equal(vad.push(silence()), null)
  for (let i = 0; i < 30; i++) assert.equal(vad.push(tone(8000)), null)
  let quiet = 0
  let out = null
  while (!out && quiet < 100) { quiet++; out = vad.push(silence()) }
  assert.equal(quiet, 54)
  assert.equal(out.length, (10 + 27 + 54) * 960)
})

test('drops blips under minLoud', () => {
  const vad = createVad()
  for (let i = 0; i < 5; i++) assert.equal(vad.push(tone(8000)), null)
  for (let i = 0; i < 60; i++) assert.equal(vad.push(silence()), null)
})

test('caps at maxFrames', () => {
  const vad = createVad()
  let at = -1
  for (let i = 0; i < 1100 && at < 0; i++) if (vad.push(tone(8000))) at = i
  assert.ok(at >= 0 && at <= 1010, `returned at ${at}`)
})

test('reset clears a segment in progress', () => {
  const vad = createVad()
  for (let i = 0; i < 30; i++) vad.push(tone(8000))
  vad.reset()
  for (let i = 0; i < 60; i++) assert.equal(vad.push(silence()), null)
})

test('reset keeps the learned noise floor', () => {
  // Noise of rms ~778 is speech against the initial floor (threshold 600) but not once
  // the floor has learned room noise of rms ~396 (threshold ~1188).
  const noise = () => tone(1100)
  const trainFloor = vad => {
    // quiet-but-not-silent frames below the initial threshold teach the floor upward
    for (let i = 0; i < 400; i++) vad.push(tone(560)) // rms ~396 < 600, floor -> ~396, threshold ~1188
  }
  const vad = createVad()
  trainFloor(vad)
  for (let i = 0; i < 40; i++) assert.equal(vad.push(noise()), null) // below learned threshold: never a segment
  vad.reset()
  let out = null
  for (let i = 0; i < 40; i++) vad.push(noise())
  for (let i = 0; i < 60; i++) out = vad.push(silence()) || out
  assert.equal(out, null, 'noise still below the learned threshold after reset')
  // control: a fresh VAD (floor 200, threshold 600) treats the same noise as speech
  const fresh = createVad()
  let got = null
  for (let i = 0; i < 40; i++) fresh.push(noise())
  for (let i = 0; i < 60; i++) got = fresh.push(silence()) || got
  assert.ok(got)
})
