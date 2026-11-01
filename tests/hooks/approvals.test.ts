import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voiceEligible, rememberCheck, takeEligible, askByVoice } from '../../hooks/approvals.ts'

const ask = { decision: 'ask' }
const call = (tool: string, extra: Record<string, unknown> = {}) => ({ tool, input: { command: 'npm test' }, tool_use_id: 't1', ...extra })

test('only core asks that go to the dialog can be answered by voice', () => {
  assert.equal(voiceEligible(call('Bash'), ask), true)
  assert.equal(voiceEligible(call('Bash'), { decision: 'allow' }), false)
  assert.equal(voiceEligible(call('Bash'), { decision: 'deny' }), false)
  assert.equal(voiceEligible(call('Bash'), { decision: 'ask', decider: 'person' }), false, 'another plugin put it to the person')
  assert.equal(voiceEligible(call('Bash', { ceiling: 'ask' }), ask), false, 'the organization caps it at ask')
  assert.equal(voiceEligible(call('AskUserQuestion'), ask), false)
  assert.equal(voiceEligible(call('ExitPlanMode'), ask), false)
  assert.equal(voiceEligible({ tool: 'Bash', input: {} }, ask), false, 'a query, not a real call')
})

test('the PermissionRequest finds its tool.check by tool and input, once', () => {
  rememberCheck(call('Bash'), ask)
  rememberCheck({ tool: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 't2', ceiling: 'ask' }, ask)
  assert.equal(takeEligible('Bash', { command: 'rm -rf x' }), undefined)
  assert.equal(takeEligible('Bash', { command: 'npm test' }), 't1')
  assert.equal(takeEligible('Bash', { command: 'npm test' }), undefined)
  rememberCheck(call('Bash'), ask, 0)
  rememberCheck(call('Edit'), ask) // 5 minutes later: the old one is dropped
  assert.equal(takeEligible('Bash', { command: 'npm test' }), undefined)
})

function fakeHub(statuses: string[]) {
  const calls: [string, string][] = []
  const fn = async (method: string, path: string) => {
    calls.push([method, path.replace(/\?.*/, '')])
    if (method === 'POST') return { id: '7', destructive: false }
    if (method === 'GET') return { status: statuses.shift() ?? 'open' }
    return {}
  }
  return { calls, fn }
}
const notices: string[] = []
const $ = { ui: { notice: (_id: string, text: string) => { notices.push(text) } } } as never

test('askByVoice: polls until the answer, notes the dialog, cleans up only when unsettled', async () => {
  const hub = fakeHub(['open', 'approved'])
  assert.equal(await askByVoice($, hub.fn, 's', 'Bash', {}, 't1', undefined), 'approved')
  assert.deepEqual(hub.calls, [['POST', '/approvals'], ['GET', '/approvals/7'], ['GET', '/approvals/7']])
  assert.match(notices.at(-1) ?? '', /say "approve" or "deny"/)

  const denied = fakeHub(['denied'])
  assert.equal(await askByVoice($, denied.fn, 's', 'Bash', {}, 't1', undefined), 'denied')

  const gone = fakeHub(['cancelled'])
  assert.equal(await askByVoice($, gone.fn, 's', 'Bash', {}, 't1', undefined), undefined)
  assert.ok(!gone.calls.some(([m]) => m === 'DELETE'))
})

test('askByVoice: the dialog answering first (signal) or the timeout leaves it to the dialog and withdraws', async () => {
  const ac = new AbortController()
  const hub = fakeHub([])
  const orig = hub.fn
  let polls = 0
  const fn = async (m: string, p: string) => { if (m === 'GET' && ++polls === 2) ac.abort(); return orig(m, p) }
  assert.equal(await askByVoice($, fn, 's', 'Bash', {}, 't1', ac.signal), undefined)
  assert.deepEqual(hub.calls.at(-1), ['DELETE', '/approvals/7'])

  const slow = fakeHub([])
  assert.equal(await askByVoice($, slow.fn, 's', 'Bash', {}, 't1', undefined, 0), undefined)
  assert.deepEqual(slow.calls.map(c => c[0]), ['POST', 'DELETE'])
})
