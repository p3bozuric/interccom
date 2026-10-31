import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restartBackoff, BACKOFF_START_MS } from '../../hooks/backoff.ts'

test('starts at 2 s and doubles on quick failures, capped at 60 s', () => {
  assert.equal(BACKOFF_START_MS, 2000)
  let next = BACKOFF_START_MS
  const waits: number[] = []
  for (let i = 0; i < 8; i++) {
    const r = restartBackoff(next, 0)
    waits.push(r.wait)
    next = r.next
  }
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
})

test('a link that stayed up for 60 s resets to 2 s', () => {
  assert.deepEqual(restartBackoff(60000, 59_999), { wait: 60000, next: 60000 })
  assert.deepEqual(restartBackoff(60000, 60_000), { wait: 2000, next: 4000 })
})
