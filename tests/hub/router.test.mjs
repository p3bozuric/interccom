import test from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../../hub/router.mjs'

const base = { mode: 'wake', names: ['api', 'frontend'], armedUntil: 0, now: 1000 }
test('wake + text delivers stripped text', () => assert.deepEqual(route('Hey Claude, run the tests.', base), { kind: 'deliver', text: 'run the tests.' }))
test('cloud spelling counts', () => assert.deepEqual(route('Hey, Cloud. What time is it?', base), { kind: 'deliver', text: 'What time is it?' }))
test('no wake word is ignored', () => assert.deepEqual(route('Cloud deployment is broken', base), { kind: 'ignore' }))
test('bare wake arms 10s', () => assert.deepEqual(route('hey claude', base), { kind: 'arm', until: 11000 }))
test('armed accepts next utterance', () => assert.deepEqual(route('run it', { ...base, armedUntil: 5000 }), { kind: 'deliver', text: 'run it' }))
test('expired arm ignores', () => assert.deepEqual(route('run it', { ...base, armedUntil: 900 }), { kind: 'ignore' }))
test('name addressing', () => assert.deepEqual(route('Hey Claude, frontend: run the tests', base), { kind: 'deliver', text: 'run the tests', name: 'frontend' }))
test('name addressing is case-insensitive and allows comma', () => assert.deepEqual(route('hey claude API, status?', base), { kind: 'deliver', text: 'status?', name: 'api' }))
test('unknown name stays in text', () => assert.deepEqual(route('hey claude backend: go', base), { kind: 'deliver', text: 'backend: go' }))
test('stop and quiet', () => {
  assert.deepEqual(route('Hey Claude, stop.', base), { kind: 'stop' })
  assert.deepEqual(route('hey claude quiet', base), { kind: 'stop' })
})
test('always mode delivers without wake word and still strips one', () => {
  assert.deepEqual(route('run it', { ...base, mode: 'always' }), { kind: 'deliver', text: 'run it' })
  assert.deepEqual(route('Hey Claude, run it', { ...base, mode: 'always' }), { kind: 'deliver', text: 'run it' })
})
test('off ignores everything', () => assert.deepEqual(route('hey claude run', { ...base, mode: 'off' }), { kind: 'ignore' }))

const many = { ...base, names: ['api', 'api-2', 'my-app', 'frontend'] }
test('multi-word spoken name', () => assert.deepEqual(route('Hey Claude, my app, run the tests.', many), { kind: 'deliver', text: 'run the tests.', name: 'my-app' }))
test('deduped name spoken with a digit and a colon', () => assert.deepEqual(route('Hey Claude, API 2: hello', many), { kind: 'deliver', text: 'hello', name: 'api-2' }))
test('deduped name spoken with a number word', () => assert.deepEqual(route('Hey Claude, API two, hello', many), { kind: 'deliver', text: 'hello', name: 'api-2' }))
test('name without a separator', () => assert.deepEqual(route('Hey Claude frontend do it', many), { kind: 'deliver', text: 'do it', name: 'frontend' }))
test('longest matching name wins', () => assert.deepEqual(route('hey claude api two status', many), { kind: 'deliver', text: 'status', name: 'api-2' }))
test('unknown multi-word name stays in the text', () => assert.deepEqual(route('hey claude back end, go', many), { kind: 'deliver', text: 'back end, go' }))
test('a name alone is not addressing', () => assert.deepEqual(route('hey claude frontend', many), { kind: 'deliver', text: 'frontend' }))
test('armed and always modes also take a name', () => {
  assert.deepEqual(route('my app run it', { ...many, armedUntil: 5000 }), { kind: 'deliver', text: 'run it', name: 'my-app' })
  assert.deepEqual(route('frontend: go', { ...many, mode: 'always' }), { kind: 'deliver', text: 'go', name: 'frontend' })
})
// Accepted behavior: a session named like a common word takes utterances that start with it.
test('a session named after a common word catches that word', () => assert.deepEqual(
  route('hey claude test the build', { ...base, names: ['test', 'api'] }), { kind: 'deliver', text: 'the build', name: 'test' }))
