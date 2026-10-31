import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TalkQueue } from '../../hub/queue.mjs'

const it = (text, priority) => ({ sessionId: 's', name: 'n', text, priority })

test('orders by priority then FIFO', () => {
  const q = new TalkQueue()
  q.push(it('s1', 'status'))
  q.push(it('q1', 'question'))
  q.push(it('h1', 'heads-up'))
  q.push(it('q2', 'question'))
  assert.deepEqual([q.next(), q.next(), q.next(), q.next()].map(i => i.text), ['q1', 'q2', 'h1', 's1'])
  assert.equal(q.next(), undefined)
})

test('flush keeps questions', () => {
  const q = new TalkQueue()
  q.push(it('s1', 'status'))
  q.push(it('q1', 'question'))
  q.push(it('h1', 'heads-up'))
  assert.equal(q.flush(), 2)
  assert.equal(q.next().text, 'q1')
  assert.equal(q.size, 0)
})
