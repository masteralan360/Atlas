import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { cloudHybridPlaywrightPlugin } from './vite-plugin.mjs'
import {
  PLAYWRIGHT_SUITE_IDS,
  claimSuiteRun,
  releaseSuiteRun,
  resetPlaywrightExecutionStateForTests
} from './executionState.mjs'

function createHandler() {
  let handler
  cloudHybridPlaywrightPlugin(true).configureServer({ middlewares: { use(callback) { handler = callback } } })
  return handler
}

async function request(handler, { method = 'GET', path, body }) {
  let resolveResponse
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve })
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Object.assign(Readable.from(chunks), {
    method,
    url: path,
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' }
  })
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(value) { resolveResponse({ status: this.statusCode, headers: this.headers, body: JSON.parse(value) }) }
  }
  handler(req, res, () => resolveResponse({ next: true }))
  return responsePromise
}

test('status routes only return a run owned by the requested suite', async () => {
  resetPlaywrightExecutionStateForTests()
  const handler = createHandler()
  const pos = { id: 'pos-route-run', suiteId: PLAYWRIGHT_SUITE_IDS.POS, status: 'running', cancelRequested: false, logs: [], updatedAt: new Date().toISOString() }
  claimSuiteRun(PLAYWRIGHT_SUITE_IDS.POS, pos)
  const posStatus = await request(handler, { path: '/api/cloud-hybrid-playwright/status?suiteId=pos' })
  const salesStatus = await request(handler, { path: '/api/cloud-hybrid-playwright/status?suiteId=sales-order-resilience' })
  assert.equal(posStatus.body.run.id, pos.id)
  assert.equal(salesStatus.body.run, null)
  releaseSuiteRun(PLAYWRIGHT_SUITE_IDS.POS, pos.id)

  const salesOrder = { id: 'sales-route-run', suiteId: PLAYWRIGHT_SUITE_IDS.SALES_ORDER, status: 'running', cancelRequested: false, logs: [], updatedAt: new Date().toISOString() }
  claimSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, salesOrder)
  const salesOrderStatus = await request(handler, { path: '/api/cloud-hybrid-playwright/status?suiteId=sales-order-resilience' })
  const defaultStatus = await request(handler, { path: '/api/cloud-hybrid-playwright/status' })
  assert.equal(salesOrderStatus.body.run.id, salesOrder.id)
  assert.equal(defaultStatus.body.run.id, pos.id)
  resetPlaywrightExecutionStateForTests()
})

test('cancel route requires the owning suite and run ID', async () => {
  resetPlaywrightExecutionStateForTests()
  const handler = createHandler()
  const salesOrder = { id: 'sales-route-run', suiteId: PLAYWRIGHT_SUITE_IDS.SALES_ORDER, status: 'running', cancelRequested: false, logs: [], updatedAt: new Date().toISOString() }
  claimSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER, salesOrder)
  const wrongOwner = await request(handler, {
    method: 'POST', path: '/api/cloud-hybrid-playwright/cancel',
    body: { suiteId: PLAYWRIGHT_SUITE_IDS.POS, runId: salesOrder.id }
  })
  assert.equal(wrongOwner.body.run, null)
  assert.equal(salesOrder.cancelRequested, false)
  const correctOwner = await request(handler, {
    method: 'POST', path: '/api/cloud-hybrid-playwright/cancel',
    body: { suiteId: PLAYWRIGHT_SUITE_IDS.SALES_ORDER, runId: salesOrder.id }
  })
  assert.equal(correctOwner.body.run.id, salesOrder.id)
  assert.equal(correctOwner.body.run.cancelRequested, true)
  resetPlaywrightExecutionStateForTests()
})

test('a Sales Order prepared plan cannot be submitted to the POS execution route', async () => {
  resetPlaywrightExecutionStateForTests()
  const response = await request(createHandler(), {
    method: 'POST', path: '/api/cloud-hybrid-playwright/start',
    body: {
      suiteId: PLAYWRIGHT_SUITE_IDS.POS,
      baseUrl: 'http://localhost:5173',
      scenarioSelection: { mode: 'all', planId: 'sales-order-plan' }
    }
  })
  assert.equal(response.status, 409)
  assert.match(response.body.error, /cannot be executed by the POS suite/)
  resetPlaywrightExecutionStateForTests()
})
