import { test } from 'node:test'
import assert from 'node:assert/strict'
import { speakResult } from '../../hooks/register.ts'

test('speak never claims it spoke when nothing played', () => {
  assert.equal(speakResult({ queued: true, outcome: 'playing' }), 'Speaking.')
  assert.equal(speakResult({ queued: true }), 'Speaking.')
  assert.match(speakResult({ queued: true, outcome: 'failed', error: "Couldn't reach the local speech server." }),
    /^Not spoken: Couldn't reach the local speech server\. The person didn't hear it; say it in your text reply\.$/)
  assert.match(speakResult({ queued: true, outcome: 'dropped' }), /^Not spoken/)
  assert.match(speakResult({ queued: true, outcome: 'pending' }), /^Queued/)
  assert.match(speakResult({ off: true }), /switched off/)
  assert.equal(speakResult({ queued: false }), 'Nothing to say.')
  assert.match(speakResult({ queued: true, relayed: true }), /coordinator/)
})
