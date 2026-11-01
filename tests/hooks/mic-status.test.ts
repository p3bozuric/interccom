import { test } from 'node:test'
import assert from 'node:assert/strict'
import { micStatus } from '../../hooks/hub-link.ts'

test('the status line is one plain word about being heard', () => {
  assert.equal(micStatus('on', 'waiting'), 'Waiting')
  assert.equal(micStatus('on', 'listening'), 'Listening')
  assert.equal(micStatus('on', 'processing'), 'Processing')
  assert.equal(micStatus('on', 'talking'), 'Talking')
  assert.equal(micStatus('not connected', 'waiting'), 'Not connected')
  assert.equal(micStatus('paused', 'waiting'), 'Mic off')
  // Speech still plays without a mic; that's what's happening, so say it.
  assert.equal(micStatus('not connected', 'talking'), 'Talking')
})
