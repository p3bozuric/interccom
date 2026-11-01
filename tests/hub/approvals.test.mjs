import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeRequest, isDestructive, matchAnswer } from '../../hub/approvals.mjs'

test('requests are said in a few plain words', () => {
  assert.equal(describeRequest('Bash', { command: 'npm test' }), 'run npm test')
  assert.equal(describeRequest('Edit', { file_path: 'C:\\x\\hub\\server.mjs' }), 'edit server.mjs')
  assert.equal(describeRequest('Write', { file_path: '/a/b/notes.md' }), 'write notes.md')
  assert.equal(describeRequest('WebFetch', { url: 'https://docs.example.com/x' }), 'fetch docs.example.com')
  assert.equal(describeRequest('mcp__github__create_issue', {}), 'use github create issue')
  assert.equal(describeRequest('Glob', {}), 'use Glob')
  assert.ok(describeRequest('Bash', { command: 'x'.repeat(500) }).length <= 124)
})

test('deletes, pushes, publishing and outward MCP calls need a second "confirm"', () => {
  for (const command of ['rm -rf build', 'git push origin main', 'git push --force', 'git reset --hard HEAD~1', 'npm publish', 'Remove-Item -Recurse x', 'gh pr merge 5', 'kubectl delete pod x', 'psql -c "drop table users"']) {
    assert.ok(isDestructive('Bash', { command }), command)
  }
  for (const command of ['npm test', 'git status', 'git commit -m x', 'ls -la', 'node hub/cli.mjs setup --show']) {
    assert.ok(!isDestructive('Bash', { command }), command)
  }
  assert.ok(isDestructive('mcp__slack__send_message', {}))
  assert.ok(!isDestructive('mcp__github__get_issue', {}))
  assert.ok(!isDestructive('Edit', { file_path: 'x' }))
})

const A = { id: 'a', name: 'api', confirming: false }
const W = { id: 'w', name: 'web-2', confirming: false }

test('answers: explicit phrases settle the newest request, or the one named', () => {
  assert.deepEqual(matchAnswer('Approve.', [A, W]), { action: 'approve', id: 'w' })
  assert.deepEqual(matchAnswer('yes, approve it', [A]), { action: 'approve', id: 'a' })
  assert.deepEqual(matchAnswer('deny', [A, W]), { action: 'deny', id: 'w' })
  assert.deepEqual(matchAnswer('No.', [A]), { action: 'deny', id: 'a' })
  assert.deepEqual(matchAnswer('approve API', [A, W]), { action: 'approve', id: 'a' })
  assert.deepEqual(matchAnswer('web two, deny', [A, W]), { action: 'deny', id: 'w' })
  assert.deepEqual(matchAnswer("don't allow it", [A]), { action: 'deny', id: 'a' })
})

test('answers: a bare "yes" only with exactly one request; anything longer is not an answer', () => {
  assert.deepEqual(matchAnswer('yes', [A]), { action: 'approve', id: 'a' })
  assert.equal(matchAnswer('yes', [A, W]), undefined)
  assert.equal(matchAnswer('yes', []), undefined)
  assert.equal(matchAnswer('approve', []), undefined)
  assert.equal(matchAnswer('yes I think we should approve the migration later today', [A]), undefined)
  assert.equal(matchAnswer('no idea what that was', [A]), undefined)
  assert.equal(matchAnswer('what folder are we in', [A]), undefined)
})

test('answers: "confirm" settles only a request waiting for it; "yes" never confirms', () => {
  const C = { id: 'c', name: 'api', confirming: true }
  assert.deepEqual(matchAnswer('confirm', [W, C]), { action: 'confirm', id: 'c' })
  assert.equal(matchAnswer('confirm', [A, W]), undefined)
  assert.equal(matchAnswer('yes', [C]), undefined)
  assert.deepEqual(matchAnswer('deny', [C]), { action: 'deny', id: 'c' })
})
