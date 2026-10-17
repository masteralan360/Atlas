import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SALES_ORDER_SCENARIO_CATALOG,
  buildSalesOrderHybridScenarioPlan,
  capabilityFingerprint,
  isSalesOrderHybridMode,
  selectPreparedSalesOrderScenarios
} from './salesOrderScenarioMatrix.mjs'

const capabilities = {
  workspaceId: 'workspace-1', dataMode: 'hybrid', isConfigured: true, isLocked: false,
  orders: true, businessPartners: true, customers: true, products: true, storages: true,
  services: false, loans: false, installments: false, multiCurrency: false,
  allowedCurrencies: ['iqd'], defaultCurrency: 'iqd', authorizedApproverIdentity: false,
  authorizedFinancialCleanup: false, desktopHybridRuntime: false
}

test('Sales Order execution mode accepts Hybrid only', () => {
  assert.equal(isSalesOrderHybridMode('hybrid'), true)
  assert.equal(isSalesOrderHybridMode('HYBRID'), true)
  assert.equal(isSalesOrderHybridMode('cloud'), false)
  assert.equal(isSalesOrderHybridMode('local'), false)
  assert.equal(isSalesOrderHybridMode(undefined), false)
})

test('coverage matrix has bounded stable identities and signatures', () => {
  const first = buildSalesOrderHybridScenarioPlan(capabilities)
  const second = buildSalesOrderHybridScenarioPlan(structuredClone(capabilities))
  assert.deepEqual(first.scenarioPlan.map(({ id, signature }) => ({ id, signature })), second.scenarioPlan.map(({ id, signature }) => ({ id, signature })))
  assert.equal(new Set(first.scenarioPlan.map((scenario) => scenario.id)).size, SALES_ORDER_SCENARIO_CATALOG.length)
  assert.ok(first.scenarioPlan.length <= 10)
  assert.deepEqual(first.coverageSummary.available, ['SO-HYB-001', 'SO-HYB-002', 'SO-HYB-003', 'SO-HYB-004'])
  assert.ok(first.scenarioPlan.every((scenario) => scenario.signature.length === 64))
  assert.ok(first.scenarioPlan.every((scenario) => scenario.cleanupRequirements?.length > 0))
  assert.ok(first.scenarioPlan.every((scenario) => scenario.preparedDimensions && scenario.prerequisites?.length && scenario.assertions?.length))
})

test('capability changes are fingerprinted and unavailable coverage is explicit', () => {
  const before = buildSalesOrderHybridScenarioPlan(capabilities)
  const changed = { ...capabilities, services: true, allowedCurrencies: ['iqd', 'usd'], multiCurrency: true }
  const after = buildSalesOrderHybridScenarioPlan(changed)
  assert.notEqual(capabilityFingerprint(capabilities), capabilityFingerprint(changed))
  assert.notEqual(before.scenarioPlan[0].signature, after.scenarioPlan[0].signature)
  const service = after.scenarioPlan.find((scenario) => scenario.id === 'SO-HYB-005')
  assert.equal(service.status, 'pending')
  assert.deepEqual(service.preparedDimensions.actions, ['service-only-draft', 'mixed-product-service-draft'])
  assert.equal(service.preparedDimensions.serviceUnitPrice, 70)
  assert.ok(!after.coverageSummary.unverified.includes('service-items'))
  const withoutServices = before.scenarioPlan.find((scenario) => scenario.id === 'SO-HYB-005')
  assert.equal(withoutServices.status, 'skipped')
  assert.deepEqual(withoutServices.missingCapabilities, ['services'])
})

test('service scenario keeps its prepared signature and dimensions when selected for execution', () => {
  const serviceCapabilities = { ...capabilities, services: true }
  const prepared = buildSalesOrderHybridScenarioPlan(serviceCapabilities).scenarioPlan
  const service = prepared.find((scenario) => scenario.id === 'SO-HYB-005')
  assert.equal(service.status, 'pending')
  const selected = selectPreparedSalesOrderScenarios(prepared, {
    mode: 'only', planId: 'service-plan', scenarioId: service.id, signature: service.signature
  }, 'service-plan')
  assert.equal(selected[0].signature, service.signature)
  assert.deepEqual(selected[0].preparedDimensions, service.preparedDimensions)
})

test('missing core and advanced prerequisites are reported as skipped or blocked, never passed', () => {
  const plan = buildSalesOrderHybridScenarioPlan({ ...capabilities, orders: false, services: false })
  for (const scenario of plan.scenarioPlan) assert.notEqual(scenario.status, 'passed')
  assert.ok(plan.coverageSummary.skipped.some((item) => item.id === 'SO-HYB-001'))
  assert.ok(plan.coverageSummary.skipped.some((item) => item.id === 'SO-HYB-005'))
  assert.ok(plan.coverageSummary.blocked.some((item) => item.id === 'SO-HYB-008'))
})

test('prepared dimensions are independent snapshots and do not mutate the catalog', () => {
  const plan = buildSalesOrderHybridScenarioPlan(capabilities)
  const scenario = plan.scenarioPlan.find((item) => item.id === 'SO-HYB-001')
  scenario.preparedDimensions.quantity = 99
  assert.equal(SALES_ORDER_SCENARIO_CATALOG.find((item) => item.id === 'SO-HYB-001').dimensions.quantity, 1)
})

test('All, From, and Only resolve the original prepared rows and reject stale signatures', () => {
  const planId = 'prepared-1'
  const plan = buildSalesOrderHybridScenarioPlan(capabilities).scenarioPlan
  const pending = plan.filter((scenario) => scenario.status === 'pending')
  assert.deepEqual(selectPreparedSalesOrderScenarios(plan, { mode: 'all', planId }, planId), pending)
  const selected = pending[1]
  assert.deepEqual(selectPreparedSalesOrderScenarios(plan, { mode: 'only', planId, scenarioId: selected.id, signature: selected.signature }, planId), [selected])
  assert.deepEqual(selectPreparedSalesOrderScenarios(plan, { mode: 'from', planId, scenarioId: selected.id, signature: selected.signature }, planId), pending.slice(1))
  assert.throws(() => selectPreparedSalesOrderScenarios(plan, { mode: 'only', planId, scenarioId: selected.id, signature: 'stale' }, planId), /prepared dimensions/)
  assert.throws(() => selectPreparedSalesOrderScenarios(plan, { mode: 'all', planId: 'other' }, planId), /plan is stale/)
})
