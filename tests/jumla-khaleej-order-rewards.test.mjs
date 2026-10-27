import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateJumlaKhaleejOrderRewards,
  validateJumlaKhaleejRewardMilestones
} from '../supabase/functions/_shared/jumlaKhaleejOrderRewards.ts'

test('milestones are validated and sorted by exact monetary threshold', () => {
  const result = validateJumlaKhaleejRewardMilestones([
    { threshold: '25000.125', node_type: 'ProgressNode' },
    { threshold: '10000', node_type: 'FreeDelivery' }
  ])

  assert.equal(result.error, null)
  assert.deepEqual(result.milestones.map(({ threshold }) => threshold), ['10000', '25000.125'])
})

test('duplicate thresholds and repeated FreeDelivery nodes are rejected', () => {
  assert.match(validateJumlaKhaleejRewardMilestones([
    { threshold: '10', node_type: 'ProgressNode' },
    { threshold: '10.000', node_type: 'FreeDelivery' }
  ]).error ?? '', /thresholds must be unique/)

  assert.match(validateJumlaKhaleejRewardMilestones([
    { threshold: '10', node_type: 'FreeDelivery' },
    { threshold: '20', node_type: 'FreeDelivery' }
  ]).error ?? '', /only once/)
})

test('ProgressNode is repeatable and has no financial effect', () => {
  const rules = validateJumlaKhaleejRewardMilestones([
    { threshold: '10', node_type: 'ProgressNode' },
    { threshold: '20', node_type: 'ProgressNode' }
  ])
  const result = evaluateJumlaKhaleejOrderRewards(rules.milestones, 20)

  assert.deepEqual(result.milestones.map(({ reached }) => reached), [true, true])
  assert.equal(result.deliveryFeeWaived, false)
})

test('Gift can share a reached milestone with FreeDelivery without adding another financial effect', () => {
  const rules = validateJumlaKhaleejRewardMilestones([
    { threshold: '30', node_types: ['Gift', 'FreeDelivery'] }
  ])
  const reached = evaluateJumlaKhaleejOrderRewards(rules.milestones, 30)
  const notReached = evaluateJumlaKhaleejOrderRewards(rules.milestones, 29.999)

  assert.equal(rules.error, null)
  assert.deepEqual(reached.milestones.map(({ reached: isReached, node_types }) => ({ isReached, node_types })), [
    { isReached: true, node_types: ['Gift', 'FreeDelivery'] }
  ])
  assert.equal(reached.deliveryFeeWaived, true)
  assert.equal(notReached.milestones[0].reached, false)
  assert.equal(notReached.deliveryFeeWaived, false)
})

test('FreeDelivery qualifies at and above its threshold and falls away below it', () => {
  const rules = [{ threshold: '100.001', node_type: 'FreeDelivery' }]

  assert.equal(evaluateJumlaKhaleejOrderRewards(rules, 100.001).deliveryFeeWaived, true)
  assert.equal(evaluateJumlaKhaleejOrderRewards(rules, 100.002).deliveryFeeWaived, true)
  assert.equal(evaluateJumlaKhaleejOrderRewards(rules, 100).deliveryFeeWaived, false)
})
