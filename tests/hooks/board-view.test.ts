import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, boardText, sortRows } from '../../hooks/board-view.ts'

test('ago rounds to s, m, h', () => {
  assert.equal(ago(4_000), '4s ago')
  assert.equal(ago(125_000), '2m ago')
  assert.equal(ago(3 * 3600_000), '3h ago')
  assert.equal(ago(-5), '0s ago')
})

test('rows sort open questions, then idle by recency, then busy', () => {
  const rows = [
    { name: 'busy', busy: true, changedAt: 9 },
    { name: 'old', busy: false, changedAt: 1 },
    { name: 'ask', busy: true, openQuestion: 'Which?', changedAt: 0 },
    { name: 'new', busy: false, changedAt: 5 },
  ]
  assert.deepEqual(sortRows(rows).map((r) => r.name), ['ask', 'new', 'old', 'busy'])
})

test('boardText shows roles, questions, last lines and decisions', () => {
  const text = boardText({
    coordinator: 'boss', mode: 'wake',
    sessions: [
      { name: 'boss', role: 'coordinator', busy: false, cwd: 'C:\\w\\boss', changedAt: 0 },
      { name: 'api', role: 'worker', busy: true, cwd: '/w/api', lastLine: 'Port?', openQuestion: 'Port?', changedAt: 50_000 },
      { name: 'cx', host: 'codex', delivery: 'pull', busy: false, cwd: '/w/cx', changedAt: 0 },
      { name: 'gem', host: 'gemini', delivery: 'none', busy: false, cwd: '/w/g', changedAt: 0 },
    ],
    decisions: [{ at: 0, text: 'Told api to continue.' }],
  }, 60_000)
  const lines = text.split('\n')
  assert.equal(lines[0], 'Coordinator: boss. Listening: wake.')
  assert.equal(lines[1], '- api — busy — folder "/w/api" — OPEN QUESTION "Port?" — changed 10s ago')
  assert.equal(lines[2], '- boss (coordinator) — idle — folder "C:\\\\w\\\\boss" — changed 1m ago')
  assert.equal(lines[3], '- cx [codex] — idle — folder "/w/cx" — changed 1m ago')
  assert.equal(lines[4], '- gem [gemini, cannot hear] — idle — folder "/w/g" — changed 1m ago')
  assert.equal(lines[6], '- 1m ago: "Told api to continue."')
  assert.equal(boardText({ sessions: [] }, 0), 'No sessions are connected.')
})
