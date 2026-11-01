import { test } from 'node:test'
import assert from 'node:assert/strict'
import { titleName } from '../../hooks/register.ts'
import { normalizeName } from '../../hub/board.mjs'

test('a session title becomes a name you can say: its first three words', () => {
  assert.equal(normalizeName(titleName('Session #3')), 'session-3')
  assert.equal(normalizeName(titleName('Test #6')), 'test-6')
  assert.equal(normalizeName(titleName('"Session #2"')), 'session-2')
  // The desktop app's own titles are sentences; the router matches at most three words.
  assert.equal(normalizeName(titleName('Pull merged changes from main')), 'pull-merged-changes')
  assert.equal(titleName('   '), '')
})
