import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Board, normalizeName } from '../../hub/board.mjs'

test('dedupes names', () => {
  const b = new Board()
  const r1 = b.register({ name: 'api', cwd: '/a/api', pid: 1 }, 1)
  const r2 = b.register({ name: 'API', cwd: '/b/api', pid: 2 }, 2)
  assert.equal(r1.name, 'api')
  assert.equal(r2.name, 'api-2')
})

test('freed name is reused', () => {
  const b = new Board()
  const r1 = b.register({ name: 'api', cwd: '/a', pid: 1 }, 1)
  b.remove(r1.sessionId)
  assert.equal(b.register({ name: 'api', cwd: '/a', pid: 1 }, 2).name, 'api')
})

test('normalizeName', () => {
  assert.equal(normalizeName('My Project_X!'), 'my-project-x')
  assert.equal(normalizeName(''), 'session')
  assert.equal(normalizeName('--a--'), 'a')
  assert.equal(normalizeName('x'.repeat(40)).length, 30)
})

test('defaultTarget prefers last active', () => {
  const b = new Board()
  assert.equal(b.defaultTarget(), undefined)
  const a = b.register({ name: 'a', cwd: '/', pid: 1 }, 1)
  const c = b.register({ name: 'b', cwd: '/', pid: 2 }, 2)
  assert.equal(b.defaultTarget().sessionId, c.sessionId)
  b.markActive(a.sessionId, 3)
  assert.equal(b.defaultTarget().sessionId, a.sessionId)
})

test('byName is case-insensitive', () => {
  const b = new Board()
  const r = b.register({ name: 'api', cwd: '/', pid: 1 }, 1)
  assert.equal(b.byName('API').sessionId, r.sessionId)
  assert.equal(b.byName('nope'), undefined)
  const m = b.register({ name: 'my-app', cwd: '/', pid: 2 }, 2)
  assert.equal(b.byName('My App').sessionId, m.sessionId)
})

test('rename dedupes, allows own name, updates fields', () => {
  const b = new Board()
  const a = b.register({ name: 'a', cwd: '/', pid: 1 }, 1)
  const c = b.register({ name: 'b', cwd: '/', pid: 2 }, 2)
  assert.equal(b.rename(c.sessionId, 'A', 4), 'a-2')
  assert.equal(b.get(c.sessionId).changedAt, 4)
  assert.equal(b.rename(a.sessionId, 'A', 5), 'a')
  b.setBusy(a.sessionId, true, 5)
  b.setLastLine(a.sessionId, 'hi', 6)
  const row = b.get(a.sessionId)
  assert.equal(row.busy, true)
  assert.equal(row.lastLine, 'hi')
  assert.equal(row.changedAt, 6)
  assert.equal(b.size, 2)
  assert.equal(b.list().length, 2)
})
