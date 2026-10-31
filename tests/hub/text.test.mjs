import test from 'node:test'
import assert from 'node:assert/strict'
import { toSpeakable } from '../../hub/text.mjs'

test('drops fenced code', () => assert.equal(toSpeakable('Done.\n```js\nx()\n```\nAll good.'), 'Done. All good.'))
test('strips markdown symbols', () => assert.equal(toSpeakable('**Tests** _pass_ in `api`'), 'Tests pass in api'))
test('says URLs as a link', () => assert.equal(toSpeakable('See https://x.io/a?b=1 now'), 'See a link now'))
test('caps at a sentence boundary', () => {
  const s = 'One sentence here. ' + 'x'.repeat(500)
  assert.equal(toSpeakable(s), 'One sentence here.')
})
test('hard-caps without a boundary', () => assert.equal(toSpeakable('y'.repeat(500)).length, 400))
test('collapses whitespace', () => assert.equal(toSpeakable('a\n\n  b'), 'a b'))
