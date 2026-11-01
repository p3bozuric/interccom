import { test } from 'node:test'
import assert from 'node:assert/strict'
import { micStatus } from '../../hooks/hub-link.ts'

test('the status line says whether the person is being heard right now', () => {
  const idle = { state: 'idle', to: '' }
  assert.equal(micStatus(true, idle), 'mic: on')
  assert.equal(micStatus(false, idle), 'mic: off')
  assert.equal(micStatus(true, { state: 'armed', to: '' }), 'mic: listening to you…')
  assert.equal(micStatus(true, { state: 'sent', to: 'session-3' }), 'mic: sent to session-3')
  assert.equal(micStatus(true, { state: 'talking', to: '' }), "mic: talking, can't hear you")
  // Speech still plays with the mic off; that's worth saying too.
  assert.equal(micStatus(false, { state: 'talking', to: '' }), "mic: talking, can't hear you")
})
