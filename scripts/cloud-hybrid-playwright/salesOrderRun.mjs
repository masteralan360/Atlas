import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  authenticateAndInspectWorkspace,
  disposeLiveContext
} from './supabaseState.mjs'
import { loadLiveTestConfiguration } from './config.mjs'
import { SalesOrderHybridDriver } from './salesOrderDriver.mjs'
import {
  SALES_ORDER_SCENARIO_CATALOG,
  buildSalesOrderHybridScenarioPlan,
  capabilityFingerprint,
  isSalesOrderHybridMode,
  selectPreparedSalesOrderScenarios
} from './salesOrderScenarioMatrix.mjs'
import {
  PLAYWRIGHT_SUITE_IDS,
  claimSuiteRun,
  currentSuiteRun,
  releaseSuiteRun
} from './executionState.mjs'

const preparedPlans = new Map()
const PREFLIGHT_CACHE_MS = 20_000
let preflightCache = null
let latestPreparedPlanId = null

function now() { return new Date().toISOString() }
function updateRun(run, update) { Object.assign(run, update, { updatedAt: now() }) }
function addLog(run, level, message, details) {
  run.logs.push({ at: now(), level, message: sanitize(message), ...(details === undefined ? {} : { details }) })
  if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500)
}
function sanitize(value) {
  return String(value ?? '')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-token]')
    .replace(/(?:password|access_token|refresh_token|apikey|api_key)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]')
    .slice(0, 1600)
}

function targetFrom(context) {
  return {
    workspaceName: context.workspace.name,
    workspaceId: context.workspace.id,
    mode: context.workspace.data_mode,
    supabaseHost: context.target.supabaseHost
  }
}

function boundaries() {
  return {
    browser: 'Real Atlas UI in Playwright; authenticated with the configured ordinary live-test account.',
    supabase: 'Verified directly through an authenticated Supabase client using that ordinary account and workspace RLS.',
    dexie: 'The application Dexie order cache is read independently in the authenticated browser after save and reload.',
    nativeSqlite: 'Not exercised by this browser runner; SQLite mirroring is unverified.',
    desktopRuntime: 'Electron/Tauri desktop runtime and restart recovery are not exercised.'
  }
}

function capabilityView(features) {
  return {
    workspaceId: features.workspaceId,
    dataMode: String(features.dataMode).toLowerCase(),
    isConfigured: Boolean(features.isConfigured),
    isLocked: Boolean(features.isLocked),
    orders: Boolean(features.orders),
    businessPartners: Boolean(features.businessPartners),
    customers: Boolean(features.customers),
    products: Boolean(features.products),
    storages: Boolean(features.storages),
    services: Boolean(features.services),
    loans: Boolean(features.loans),
    installments: Boolean(features.installments),
    multiCurrency: Boolean(features.multiCurrency),
    payments: Boolean(features.payments),
    paymentMethodSelectorEnabled: Boolean(features.paymentMethodSelectorEnabled),
    paymentMethods: [...(features.paymentMethods ?? [])].map((method) => String(method)).sort(),
    allowedCurrencies: [...(features.allowedCurrencies ?? [])].map((currency) => String(currency).toLowerCase()).sort(),
    defaultCurrency: features.defaultCurrency ? String(features.defaultCurrency).toLowerCase() : null,
    authorizedApproverIdentity: false,
    authorizedFinancialCleanup: false,
    desktopHybridRuntime: false
  }
}

function preflightReason(error) {
  const message = String(error?.message ?? error)
  if (message.includes('.env.atlas-live-playwright-tests.local')) return 'devTesting.salesOrderHybrid.reasons.liveConfigMissing'
  if (/Hybrid mode is required/i.test(message)) return 'devTesting.salesOrderHybrid.reasons.hybridRequired'
  if (/DEV TEST workspace|configured workspace name/i.test(message)) return 'devTesting.salesOrderHybrid.reasons.testWorkspaceRequired'
  if (/could not sign in|account could not sign in/i.test(message)) return 'devTesting.salesOrderHybrid.reasons.credentialsInvalid'
  if (/configured or is locked/i.test(message)) return 'devTesting.salesOrderHybrid.reasons.workspaceNotReady'
  if (/workspace scope/i.test(message)) return 'devTesting.salesOrderHybrid.reasons.workspaceScopeInvalid'
  return 'devTesting.salesOrderHybrid.reasons.livePreflightFailed'
}

export async function verifyHybridWorkspace(context) {
  const workspace = context.workspace
  if (!isSalesOrderHybridMode(workspace.data_mode)) {
    throw new Error('Hybrid mode is required; this Sales Order runner cannot prepare or execute in Cloud or Local mode.')
  }
  if (!/^DEV TEST(?:\s|$)/i.test(String(workspace.name ?? ''))) {
    throw new Error('The configured workspace name must start with DEV TEST.')
  }
  if (context.config.configuredWorkspaceName && context.config.configuredWorkspaceName !== workspace.name) {
    throw new Error('The configured workspace name does not match the verified workspace name.')
  }
  const checks = await context.supabase.from('workspaces')
    .select('id,name,data_mode,is_configured,locked_workspace')
    .eq('id', workspace.id).maybeSingle()
  if (checks.error || !checks.data) throw new Error('The configured workspace readiness could not be verified.')
  if (checks.data.is_configured !== true || checks.data.locked_workspace === true) {
    throw new Error('The configured workspace is not configured or is locked.')
  }
  if (!isSalesOrderHybridMode(checks.data.data_mode)) {
    throw new Error('Hybrid mode is required; this Sales Order runner cannot prepare or execute in Cloud or Local mode.')
  }
  if (!context.profile || !['admin', 'staff'].includes(String(context.profile.role).toLowerCase())) {
    throw new Error('The configured live-test user must be an authorized admin or staff account.')
  }
  return { ...checks.data, profileRole: context.profile.role }
}

export function salesOrderRunTerminalStatus({ cancelled, scenarioFailures, cleanupFailure, blockedCount }) {
  if (cancelled) return 'cancelled'
  if (scenarioFailures || cleanupFailure) return 'failed'
  if (blockedCount > 0) return 'blocked'
  return 'passed'
}

export async function salesOrderHybridPreflight({ force = false } = {}) {
  if (!force && preflightCache && preflightCache.expiresAt > Date.now()) return structuredClone(preflightCache.value)
  let context
  try {
    context = await authenticateAndInspectWorkspace({ allowedModes: ['hybrid'], modeLabel: 'Hybrid' })
    await verifyHybridWorkspace(context)
    const target = targetFrom(context)
    const result = {
      status: 'ready',
      target,
      capabilities: {
        available: ['hybrid-workspace', 'ordinary-user-authentication', 'real-browser'],
        unavailable: [{ id: 'workspace-feature-snapshot', reason: 'devTesting.salesOrderHybrid.reasons.discoveredDuringPrepare' }]
      },
      boundaries: boundaries()
    }
    preflightCache = { expiresAt: Date.now() + PREFLIGHT_CACHE_MS, value: result }
    return structuredClone(result)
  } catch (error) {
    const result = { status: 'blocked', reason: preflightReason(error) }
    preflightCache = { expiresAt: Date.now() + PREFLIGHT_CACHE_MS, value: result }
    return result
  } finally {
    if (context) await disposeLiveContext(context)
  }
}

function newRun({ baseUrl, stage, title }) {
  const id = randomUUID()
  const artifactsDirectory = resolve(process.cwd(), '.cloud-hybrid-playwright', 'artifacts', PLAYWRIGHT_SUITE_IDS.SALES_ORDER, id)
  const run = {
    id,
    suiteId: PLAYWRIGHT_SUITE_IDS.SALES_ORDER,
    title,
    status: 'running',
    planOnly: stage === 'preflight',
    stage,
    currentScenario: null,
    currentIndex: 0,
    totalScenarios: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    startedAt: now(),
    updatedAt: now(),
    finishedAt: null,
    cancelRequested: false,
    target: null,
    results: [],
    scenarioPlan: [],
    scenarioPlanId: null,
    coverageSummary: null,
    hybridBoundaries: boundaries(),
    scenarioSelection: null,
    logs: [],
    diagnosticsPath: resolve(artifactsDirectory, 'report.json'),
    artifactsDirectory,
    tracePath: null,
    capabilityFingerprint: null,
    promise: null
  }
  return run
}

function launchRun(run, work) {
  claimSuiteRun(run.suiteId, run)
  run.promise = work()
    .catch(async (error) => {
      updateRun(run, { status: 'failed', stage: 'failed', finishedAt: now() })
      addLog(run, 'error', error instanceof Error ? error.message : 'The Sales Order Hybrid Playwright run failed.')
      await writeReport(run).catch((reportError) => addLog(run, 'error', 'The failed run diagnostics could not be saved.', { message: sanitize(reportError?.message ?? reportError) }))
    })
    .finally(() => releaseSuiteRun(run.suiteId, run.id))
  return currentSuiteRun(run.suiteId)
}

export function prepareSalesOrderScenarioPlan({ baseUrl }) {
  const run = newRun({ baseUrl, stage: 'preflight', title: 'Sales Order Hybrid Playwright' })
  return launchRun(run, () => prepareScenarioPlan(run, baseUrl))
}

async function openDriver({ context, baseUrl, run, suffix = 'prepare' }) {
  const driver = new SalesOrderHybridDriver({
    baseUrl,
    email: context.config.email,
    password: context.config.password,
    expectedSupabaseHost: context.target.supabaseHost,
    diagnosticSecrets: [context.config.email, context.config.password, context.config.supabaseKey],
    artifactDirectory: run.artifactsDirectory,
    onDiagnostic: (entry) => {
      if (run.logs.length < 450) run.logs.push({ at: entry.at, level: 'info', message: sanitize(entry.message), ...(entry.details ? { details: entry.details } : {}) })
    }
  })
  run.tracePath = resolve(run.artifactsDirectory, `${suffix}-trace.zip`)
  try {
    await driver.open({ workspaceId: context.workspace.id, userId: context.user.id })
    return driver
  } catch (error) {
    await driver.close(run.tracePath).catch(() => undefined)
    run.diagnostics = driver.diagnostics
    throw error
  }
}

async function prepareScenarioPlan(run, baseUrl) {
  let context
  let driver
  try {
    updateRun(run, { stage: 'preflight' })
    context = await authenticateAndInspectWorkspace({ allowedModes: ['hybrid'], modeLabel: 'Hybrid' })
    await verifyHybridWorkspace(context)
    run.target = targetFrom(context)
    addLog(run, 'info', 'Hybrid mode, dedicated DEV TEST workspace, ordinary user, configured state, and unlocked state verified.')
    updateRun(run, { stage: 'playwright-bootstrap' })
    driver = await openDriver({ context, baseUrl, run, suffix: 'plan' })
    const capabilities = capabilityView(driver.capabilities)
    const plan = buildSalesOrderHybridScenarioPlan(capabilities)
    if (run.cancelRequested) {
      updateRun(run, { stage: 'cleanup' })
      await driver.close(run.tracePath)
      driver = null
      await disposeLiveContext(context)
      context = null
      addLog(run, 'warning', 'Timeline preparation was cancelled before the scenario plan was published.')
      updateRun(run, { status: 'cancelled', stage: 'cancelled', finishedAt: now(), currentScenario: null })
      await writeReport(run)
      return currentSuiteRun(run.suiteId)
    }
    if (plan.scenarioPlan.every((scenario) => scenario.status !== 'pending')) {
      addLog(run, 'warning', 'The verified workspace exposes no runnable Sales Order browser scenarios. The plan reports each unavailable or unsupported requirement.')
    }
    run.scenarioPlan = plan.scenarioPlan
    run.scenarioPlanId = `${run.id}:${plan.capabilityFingerprint.slice(0, 16)}`
    run.capabilityFingerprint = plan.capabilityFingerprint
    run.coverageSummary = plan.coverageSummary
    run.scenarioDimensions = { capabilities }
    run.totalScenarios = plan.scenarioPlan.filter((scenario) => scenario.status === 'pending').length
    run.blocked = plan.scenarioPlan.filter((scenario) => scenario.status === 'blocked').length
    preparedPlans.set(run.scenarioPlanId, {
      runId: run.id,
      workspaceId: context.workspace.id,
      capabilityFingerprint: plan.capabilityFingerprint,
      capabilities,
      scenarioPlan: plan.scenarioPlan,
      coverageSummary: plan.coverageSummary
    })
    latestPreparedPlanId = run.scenarioPlanId
    while (preparedPlans.size > 8) preparedPlans.delete(preparedPlans.keys().next().value)
    updateRun(run, { status: 'planned', planOnly: true, stage: 'scenario-plan-ready', finishedAt: now(), currentIndex: 0 })
    await writeReport(run)
  } finally {
    if (driver) await driver.close(run.tracePath).catch((error) => addLog(run, 'error', 'The preparation browser could not be closed cleanly.', { message: sanitize(error?.message ?? error) }))
    if (context) await disposeLiveContext(context).catch((error) => addLog(run, 'warning', 'The preparation observer session could not be fully closed.', { message: sanitize(error?.message ?? error) }))
  }
  return currentSuiteRun(run.suiteId)
}

function normalizeSelection(selection) {
  if (!selection || !['all', 'from', 'only'].includes(selection.mode) || typeof selection.planId !== 'string') {
    throw new Error('Prepare the Sales Order Hybrid Playwright timeline before starting a run.')
  }
  if (selection.mode !== 'all' && (typeof selection.scenarioId !== 'string' || typeof selection.signature !== 'string')) {
    throw new Error('Select a prepared Sales Order scenario before starting this run.')
  }
  return selection
}

export function runSalesOrderHybridScenarios({ baseUrl, scenarioSelection }) {
  const selection = normalizeSelection(scenarioSelection)
  const prepared = preparedPlans.get(selection.planId)
  const latestPlan = currentSuiteRun(PLAYWRIGHT_SUITE_IDS.SALES_ORDER)
  if (!prepared || selection.planId !== latestPreparedPlanId || !latestPlan || latestPlan.scenarioPlanId !== selection.planId) {
    throw new Error('The prepared Sales Order scenario plan is stale. Prepare the timeline again before running it.')
  }
  const scenarios = selectPreparedSalesOrderScenarios(prepared.scenarioPlan, selection, latestPlan.scenarioPlanId)
  if (scenarios.length === 0) throw new Error('The prepared plan contains no runnable scenarios for this selection.')
  const run = newRun({ baseUrl, stage: 'preflight', title: 'Sales Order Hybrid Playwright' })
  run.planOnly = false
  run.scenarioPlanId = selection.planId
  run.scenarioPlan = structuredClone(prepared.scenarioPlan)
  run.capabilityFingerprint = prepared.capabilityFingerprint
  run.coverageSummary = structuredClone(prepared.coverageSummary)
  run.scenarioDimensions = structuredClone(latestPlan.scenarioDimensions)
  run.scenarioSelection = selection.mode === 'all'
    ? { mode: 'all' }
    : { mode: selection.mode, scenarioId: selection.scenarioId }
  run.totalScenarios = scenarios.length
  run.blocked = run.coverageSummary?.blocked?.length ?? 0
  return launchRun(run, () => executeScenarios(run, baseUrl, prepared, scenarios))
}

async function executeScenarios(run, baseUrl, prepared, scenarios) {
  let context
  let driver
  let fixtureCleanup = { completed: true, errors: [], removed: [] }
  try {
    updateRun(run, { stage: 'preflight' })
    context = await authenticateAndInspectWorkspace({ allowedModes: ['hybrid'], modeLabel: 'Hybrid' })
    const checkedWorkspace = await verifyHybridWorkspace(context)
    if (checkedWorkspace.id !== prepared.workspaceId) throw new Error('The prepared plan belongs to a different verified workspace. Prepare a new Sales Order timeline.')
    run.target = targetFrom(context)
    updateRun(run, { stage: 'playwright-bootstrap' })
    driver = await openDriver({ context, baseUrl, run, suffix: run.id })
    const currentCapabilities = capabilityView(driver.capabilities)
    if (capabilityFingerprint(currentCapabilities) !== prepared.capabilityFingerprint) {
      throw new Error('The workspace capabilities changed after preparation. Re-prepare the timeline before executing scenarios.')
    }
    updateRun(run, { stage: 'test-data-setup' })
    const fixtures = await driver.prepareFixtures(run.id, context.supabase, driver.capabilities.defaultCurrency ?? 'usd')
    addLog(run, 'info', 'Created run-owned Sales Order fixtures through the authenticated Atlas module APIs.', {
      customerId: fixtures.customer.id,
      productId: fixtures.product.id,
      serviceId: fixtures.service?.id ?? null,
      storageId: fixtures.storage.id,
      storageOwnedByRun: fixtures.storage.created
    })
    updateRun(run, { stage: 'running-matrix' })
    for (const scenario of scenarios) {
      if (run.cancelRequested) break
      updateRun(run, { stage: 'scenario', currentScenario: scenario.id })
      const result = {
        id: scenario.id,
        name: scenario.name,
        titleKey: scenario.titleKey,
        status: 'running',
        signature: scenario.signature,
        preparedDimensions: scenario.preparedDimensions,
        startedAt: now(),
        cleanup: { completed: false, errors: [] }
      }
      run.results.push(result)
      try {
        const catalogEntry = SALES_ORDER_SCENARIO_CATALOG.find((entry) => entry.id === scenario.id)
        if (!catalogEntry || catalogEntry.execution === 'unsupported') throw new Error('The selected plan row has no real-browser executor.')
        const baselineProductIds = catalogEntry.execution === 'service-drafts'
          ? [fixtures.product.id, fixtures.service?.id]
          : [fixtures.product.id]
        const baseline = await driver.readBaselines(context.supabase, baselineProductIds)
        if (catalogEntry.execution === 'service-drafts') {
          result.actual = await driver.createServiceDrafts(context.supabase, scenario, baseline, run.id, () => run.cancelRequested)
        } else {
          result.actual = await driver.createDraft(context.supabase, scenario, baseline, run.id)
        }
        if (result.actual?.cancelled) {
          result.status = 'cancelled'
          result.cancelledActions = result.actual.completedActions
        } else {
          result.status = 'passed'
          run.passed++
        }
      } catch (error) {
        result.status = 'failed'
        result.errors = [sanitize(error instanceof Error ? error.message : 'The Sales Order scenario failed.')]
        result.artifacts = { screenshot: await driver.captureScreenshot(`${scenario.id}-failure`) }
        run.failed++
        addLog(run, 'error', `${scenario.id} failed.`, { message: result.errors[0], screenshot: result.artifacts.screenshot })
      } finally {
        result.finishedAt = now()
        run.currentIndex++
        updateRun(run, { currentIndex: run.currentIndex })
      }
      const planItem = run.scenarioPlan.find((item) => item.id === scenario.id)
      if (planItem) planItem.status = result.status
      await writeReport(run)
      if (result.status === 'cancelled' || (run.failed && run.cancelRequested)) break
    }
  } catch (error) {
    run.failed++
    const message = sanitize(error instanceof Error ? error.message : 'The Sales Order run could not continue.')
    addLog(run, 'error', message)
    if (run.results.length === 0) {
      run.results.push({ id: 'SO-HYB-RUN', name: 'Sales Order Hybrid run', status: 'failed', errors: [message], cleanup: { completed: false, errors: [] } })
    }
  } finally {
    updateRun(run, { stage: 'fixture-cleanup', currentScenario: null })
    if (driver && context) {
      try { fixtureCleanup = await driver.cleanup(context.supabase) }
      catch (error) { fixtureCleanup = { completed: false, errors: [sanitize(error instanceof Error ? error.message : 'Fixture cleanup failed.')], removed: [] } }
      if (!fixtureCleanup.completed) {
        addLog(run, 'error', 'Run-owned fixture cleanup failed.', { errors: fixtureCleanup.errors })
        const affected = run.results.at(-1)
        if (affected?.cleanup) Object.assign(affected.cleanup, { completed: false, errors: fixtureCleanup.errors })
      } else {
        addLog(run, 'info', 'Run-owned fixture cleanup verified in Supabase.', { removed: fixtureCleanup.removed })
        for (const result of run.results) if (result.cleanup) result.cleanup = { completed: true, removed: fixtureCleanup.removed }
      }
    } else {
      fixtureCleanup = { completed: true, errors: [], removed: [], notRequired: true }
      for (const result of run.results) {
        if (result.cleanup) result.cleanup = { completed: true, notRequired: true, removed: [] }
      }
    }
    if (driver) {
      const tracePath = resolve(run.artifactsDirectory, `${run.id}-trace.zip`)
      await driver.close(tracePath).catch((error) => addLog(run, 'error', 'The browser trace could not be finalized.', { message: sanitize(error?.message ?? error) }))
      run.tracePath = tracePath
      run.diagnostics = driver.diagnostics
    }
    if (context) await disposeLiveContext(context).catch((error) => addLog(run, 'warning', 'The authenticated Supabase observer session could not be fully closed.', { message: sanitize(error?.message ?? error) }))
    const cancelled = run.cancelRequested
    const scenarioFailures = run.results.some((result) => result.status === 'failed')
    const cleanupFailure = !fixtureCleanup.completed
    const finalStatus = salesOrderRunTerminalStatus({
      cancelled,
      scenarioFailures,
      cleanupFailure,
      blockedCount: run.blocked
    })
    updateRun(run, {
      status: finalStatus,
      stage: finalStatus,
      currentScenario: null,
      finishedAt: now(),
      fixtureCleanup
    })
    if (cancelled) addLog(run, 'warning', 'Cancellation reached its terminal state after fixture cleanup completed or reported its failure.')
    await writeReport(run)
  }
}

async function writeReport(run) {
  await mkdir(run.artifactsDirectory, { recursive: true })
  const { promise: _promise, artifactsDirectory: _artifactsDirectory, ...report } = run
  await writeFile(run.diagnosticsPath, JSON.stringify(report, null, 2), 'utf8')
}
