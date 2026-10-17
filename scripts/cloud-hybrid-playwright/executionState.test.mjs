import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAYWRIGHT_SUITE_IDS,
  claimSuiteRun,
  currentSuiteRun,
  cancelSuiteRun,
  releaseSuiteRun,
  resetPlaywrightExecutionStateForTests
} from './executionState.mjs'

function run(id, suiteId) {
  return { id, suiteId, status: 'running', cancelRequested: false, logs: [], updatedAt: new Date().toISOString() }
}

test('suite status is isolated while the global execution lock rejects conflicting runs', () => {
  resetPlaywrightExecutionStateForTests()
  const pos = run('pos-run', PLAYWRIGHT_SUITE_IDS.POS)
  claimSuiteRun(PLAYWRIGHT_SUITE_IDS.POS, pos)
  assert.equal(currentSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER), null)
  assert.equal(currentSuiteRun(PLAYWRIGHT_SUITE_IDS.POS)?.id, 'pos-run')
  assert.throws(() => claimSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, run('so-run', PLAYWRIGHT_SUITE_IDS.SALES_ORDER)), /already in progress/)
  releaseSuiteRun(PLAYWRIGHT_SUITE_IDS.POS, pos.id)
  const salesOrder = run('so-run', PLAYWRIGHT_SUITE_IDS.SALES_ORDER)
  claimSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, salesOrder)
  assert.equal(currentSuiteRun(PLAYWRIGHT_SUITE_IDS.POS)?.id, 'pos-run')
  assert.equal(currentSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER)?.id, 'so-run')
  resetPlaywrightExecutionStateForTests()
})

test('cancellation requires the owning suite and exact active run ID', () => {
  resetPlaywrightExecutionStateForTests()
  const salesOrder = run('so-run', PLAYWRIGHT_SUITE_IDS.SALES_ORDER)
  claimSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, salesOrder)
  assert.equal(cancelSuiteRun(PLAYWRIGHT_SUITE_IDS.POS, 'so-run'), null)
  assert.equal(salesOrder.cancelRequested, false)
  assert.throws(() => cancelSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, 'stale-run'), /active execution/)
  assert.equal(cancelSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, 'so-run')?.cancelRequested, true)
  assert.equal(currentSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER)?.cancelRequested, true)
  releaseSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, salesOrder.id)
  resetPlaywrightExecutionStateForTests()
})

test('invalid suite IDs cannot resolve another suite execution', () => {
  resetPlaywrightExecutionStateForTests()
  assert.throws(() => currentSuiteRun('pos-sales-order'), /Unsupported Hybrid Playwright suite/)
})

test('run snapshots retain suite ownership and artifacts while hiding the internal promise', () => {
  resetPlaywrightExecutionStateForTests()
  const salesOrder = {
    ...run('so-export-run', PLAYWRIGHT_SUITE_IDS.SALES_ORDER),
    diagnosticsPath: '.cloud-hybrid-playwright/artifacts/sales-order-resilience/run/report.json',
    results: [{ id: 'SO-HYB-001', status: 'passed' }],
    promise: Promise.resolve()
  }
  claimSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, salesOrder)
  const snapshot = currentSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER)
  assert.equal(snapshot.suiteId, PLAYWRIGHT_SUITE_IDS.SALES_ORDER)
  assert.equal(snapshot.id, 'so-export-run')
  assert.match(snapshot.diagnosticsPath, /sales-order-resilience/)
  assert.equal(snapshot.promise, undefined)
  snapshot.results[0].status = 'failed'
  assert.equal(currentSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER).results[0].status, 'passed')
  resetPlaywrightExecutionStateForTests()
})
