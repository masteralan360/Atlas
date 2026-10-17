export const PLAYWRIGHT_SUITE_IDS = Object.freeze({
  POS: 'pos',
  SALES_ORDER: 'sales-order-resilience'
})

const validSuites = new Set(Object.values(PLAYWRIGHT_SUITE_IDS))
const latestRuns = new Map()
let activeExecution = null

export function normalizePlaywrightSuiteId(value = PLAYWRIGHT_SUITE_IDS.POS) {
  if (!validSuites.has(value)) throw new Error('Unsupported Hybrid Playwright suite.')
  return value
}

function snapshot(run) {
  if (!run) return null
  const { promise: _promise, ...value } = run
  return structuredClone(value)
}

export function currentSuiteRun(suiteId = PLAYWRIGHT_SUITE_IDS.POS) {
  return snapshot(latestRuns.get(normalizePlaywrightSuiteId(suiteId)))
}

export function claimSuiteRun(suiteId, run) {
  const owner = normalizePlaywrightSuiteId(suiteId)
  if (run?.suiteId !== owner) throw new Error('The run suite does not match its execution owner.')
  if (activeExecution) {
    const current = latestRuns.get(activeExecution.suiteId)
    throw new Error(current?.status === 'running'
      ? `A ${activeExecution.suiteId} Hybrid Playwright run is already in progress.`
      : 'Another Hybrid Playwright request is being finalized.')
  }
  latestRuns.set(owner, run)
  activeExecution = { suiteId: owner, runId: run.id }
}

export function activeSuiteExecution() {
  return activeExecution ? { ...activeExecution } : null
}

export function cancelSuiteRun(suiteId, runId, { allowLegacyMissingRunId = false } = {}) {
  const owner = normalizePlaywrightSuiteId(suiteId)
  const execution = activeExecution
  const run = latestRuns.get(owner)
  if (!run || run.status !== 'running') return currentSuiteRun(owner)
  if (!execution || execution.suiteId !== owner || execution.runId !== run.id
      || (runId && runId !== run.id)
      || (!runId && !allowLegacyMissingRunId)) {
    throw new Error('The requested run is not the active execution for this suite.')
  }
  if (!run.cancelRequested) {
    run.cancelRequested = true
    run.updatedAt = new Date().toISOString()
    run.logs ??= []
    run.logs.push({ at: run.updatedAt, level: 'warning', message: 'Cancellation requested. The active scenario will finish cleanup first.' })
  }
  return snapshot(run)
}

export function releaseSuiteRun(suiteId, runId) {
  const owner = normalizePlaywrightSuiteId(suiteId)
  if (activeExecution?.suiteId === owner && activeExecution.runId === runId) activeExecution = null
}

export function resetPlaywrightExecutionStateForTests() {
  activeExecution = null
  latestRuns.clear()
}
