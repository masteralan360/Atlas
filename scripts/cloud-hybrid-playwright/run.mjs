import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  buildCloudHybridScenarioMatrix,
  buildNegativeScenarioMatrix,
  selectPaymentMethodsForCloudHybridRun,
  summarizeScenarioCoverage
} from './scenarioMatrix.mjs'
import { calculateExpectedCheckout } from './expectedBusinessState.mjs'
import {
  authenticateAndInspectWorkspace,
  captureScenarioBaseline,
  cleanupOwnedFixtures,
  cleanupPartialOwnedFixtures,
  cleanupScenario,
  disposeLiveContext,
  cleanupWorkspaceStorageFixture,
  prepareWorkspaceStorageFixture,
  prepareOwnedFixtures,
  reconcileSuccessfulScenario
} from './supabaseState.mjs'
import { CloudHybridPosDriver } from './posDriver.mjs'
import { exercisePosLoanRepayments, verifyPosLoanRepaymentCleanup } from './loanRepayments.mjs'
import {
  calculateExpectedActivityCheckout,
  captureActivityBaseline,
  cleanupActivityScenario,
  cleanupOwnedActivities,
  cleanupPartialOwnedActivities,
  prepareOwnedActivities,
  reconcileActivityCheckout
} from './activities.mjs'
import {
  buildQuickOrderScenarioMatrix,
  captureQuickOrderBaseline,
  cleanupQuickOrderCustomer,
  cleanupPartialQuickOrderCustomer,
  cleanupQuickOrderScenario,
  exerciseQuickOrderLoanRepayments,
  prepareQuickOrderCustomer,
  reconcileQuickOrder,
  reconcileQuickOrderNoMutation
} from './quickOrders.mjs'

let activeRun = null

function now() { return new Date().toISOString() }
function updateRun(run, update) { Object.assign(run, update, { updatedAt: now() }) }
function addLog(run, level, message, details) {
  run.logs.push({ at: now(), level, message, ...(details === undefined ? {} : { details }) })
  if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500)
}

function normalizeScenarioSelection(selection) {
  if (!selection || selection.mode === 'all') return { mode: 'all' }
  if (!['from', 'only'].includes(selection.mode)
      || typeof selection.scenarioId !== 'string'
      || typeof selection.signature !== 'string') {
    throw new Error('Choose a scenario from the generated timeline before starting a selected run.')
  }
  return {
    mode: selection.mode,
    scenarioId: selection.scenarioId,
    signature: selection.signature,
    digitalPaymentMethodId: typeof selection.digitalPaymentMethodId === 'string'
      ? selection.digitalPaymentMethodId
      : null
  }
}

function storageSelectionKey(storageId, setup, serviceSource, activityStorage, storageFixture) {
  if (!storageId) return null
  if (storageId === serviceSource?.id || storageId === '__atlas_services__') return 'services'
  if (storageId === activityStorage?.id || storageId === '__atlas_activities__') return 'activities'
  const storageIndex = setup.storages.findIndex((storage) => storage.id === storageId)
  if (storageIndex < 0) return `source:${storageId}`
  return storageFixture.created ? `test-stock:${storageIndex + 1}` : `stock:${setup.storages[storageIndex].id}`
}

function scenarioSignature(scenario, setup, serviceSource, activityStorage, storageFixture) {
  const itemDimensions = (scenario.items ?? []).map((item) => ({
    source: storageSelectionKey(item.storageId, setup, serviceSource, activityStorage, storageFixture),
    itemType: item.itemType ?? null,
    currency: String(item.currency ?? '').toLowerCase(),
    quantity: Number(item.quantity ?? 1),
    price: item.price ?? 'original',
    customName: Boolean(item.customName),
    additionalName: item.additionalName ?? null
  }))
  const descriptor = {
    id: scenario.id,
    domain: scenario.domain ?? (scenario.method ? 'quick-order' : 'sale'),
    kind: scenario.kind ?? scenario.negativeKind ?? null,
    source: storageSelectionKey(scenario.source?.id ?? scenario.storage?.id, setup, serviceSource, activityStorage, storageFixture),
    items: itemDimensions,
    itemType: scenario.itemType ?? null,
    currency: scenario.currency ? String(scenario.currency).toLowerCase() : null,
    paymentMethod: scenario.payment?.id ?? scenario.method?.id ?? null,
    paymentAccount: scenario.account?.id ?? null,
    discount: scenario.discount ? {
      percent: Number(scenario.discount.percent ?? 0),
      amount: Number(scenario.discount.amount ?? 0)
    } : null,
    duplicateSubmit: Boolean(scenario.duplicateSubmit),
    orderStatus: scenario.orderStatus ?? null,
    paymentStatus: scenario.paymentStatus ?? null,
    initialPaymentAmount: Number(scenario.initialPaymentAmount ?? 0),
    installmentCount: Number(scenario.installmentCount ?? 0),
    installmentFrequency: scenario.installmentFrequency ?? null,
    hasFirstDueDate: Boolean(scenario.firstDueDate),
    coverage: [...(scenario.coverage ?? [])].sort()
  }
  return JSON.stringify(descriptor)
}

function buildScenarioPlan(scenarios, setup, serviceSource, activityStorage, storageFixture) {
  return scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    domain: scenario.domain ?? (scenario.method ? 'quick-order' : 'sale'),
    signature: scenarioSignature(scenario, setup, serviceSource, activityStorage, storageFixture),
    status: 'pending'
  }))
}

export function currentCloudHybridRun() {
  if (!activeRun) return null
  const { promise, ...snapshot } = activeRun
  return structuredClone(snapshot)
}

export async function cloudHybridPreflight() {
  const context = await authenticateAndInspectWorkspace()
  try {
    const storageCheck = await context.supabase.from('storages').select('id', { count: 'exact', head: true })
      .eq('workspace_id', context.workspace.id).eq('is_deleted', false)
    if (storageCheck.error) throw new Error(`Storage access check failed: ${storageCheck.error.message}`)
    return { status: 'ready', target: context.target, mode: context.workspace.data_mode, activeStorageCount: storageCheck.count ?? 0 }
  } finally {
    await disposeLiveContext(context)
  }
}

function createCloudHybridRun({ baseUrl, scenarioSelection: requestedScenarioSelection, planOnly = false }) {
  if (activeRun?.status === 'running') throw new Error('A Cloud/Hybrid Playwright run is already in progress.')
  const scenarioSelection = planOnly ? { mode: 'all' } : normalizeScenarioSelection(requestedScenarioSelection)
  const runId = randomUUID()
  const artifactsDirectory = resolve(process.cwd(), '.cloud-hybrid-playwright', 'artifacts', runId)
  const run = {
    id: runId,
    title: 'Cloud/Hybrid Playwright',
    status: 'running',
    planOnly,
    stage: 'preflight',
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
    scenarioSelection: scenarioSelection.mode === 'all'
      ? { mode: 'all' }
      : { mode: scenarioSelection.mode, scenarioId: scenarioSelection.scenarioId },
    logs: [],
    diagnosticsPath: resolve(artifactsDirectory, 'report.json'),
    artifactsDirectory,
    promise: null
  }
  activeRun = run
  run.promise = executeCloudHybridRun(run, baseUrl, scenarioSelection, planOnly)
    .catch((error) => {
      updateRun(run, { status: 'failed', stage: 'failed', finishedAt: now() })
      addLog(run, 'error', error instanceof Error ? error.message : 'Cloud/Hybrid Playwright could not finish.')
    })
  return currentCloudHybridRun()
}

export function startCloudHybridRun(args) {
  return createCloudHybridRun(args)
}

export function prepareCloudHybridScenarioPlan({ baseUrl }) {
  return createCloudHybridRun({ baseUrl, planOnly: true })
}

export function requestCloudHybridCancellation() {
  if (!activeRun || activeRun.status !== 'running') return currentCloudHybridRun()
  updateRun(activeRun, { cancelRequested: true })
  addLog(activeRun, 'warning', 'Cancellation requested. The active scenario will finish cleanup first.')
  return currentCloudHybridRun()
}

async function queryScenarioRows(context, setup, baseline) {
  const { supabase, workspace } = context
  const itemResult = await supabase.from('sale_items').select('*')
    .eq('workspace_id', workspace.id).in('product_id', setup.productIds)
  if (itemResult.error) throw new Error(`Could not inspect related sale items after checkout: ${itemResult.error.message}`)
  const beforeItemIds = new Set(baseline.relatedSaleItems.map((row) => row.id))
  const createdItems = (itemResult.data ?? []).filter((row) => !beforeItemIds.has(row.id))
  const newSaleIds = [...new Set(createdItems.map((row) => row.sale_id))]
  if (newSaleIds.length === 1) {
    const sale = await supabase.from('sales').select('id').eq('workspace_id', workspace.id).eq('id', newSaleIds[0]).maybeSingle()
    if (sale.error) throw new Error(`Could not correlate a persisted sale to its sale items: ${sale.error.message}`)
    if (sale.data) return newSaleIds[0]
  }
  return null
}

async function calculateExpectedFromPersistedSnapshot(context, setup, scenario, saleId) {
  const { supabase, workspace } = context
  const [saleResult, itemResult, exchangeResult] = await Promise.all([
    supabase.from('sales').select('id,workspace_id,cashier_id,created_at,currency,settlement_currency')
      .eq('workspace_id', workspace.id).eq('id', saleId).maybeSingle(),
    supabase.from('sale_items').select('id,workspace_id,sale_id,created_at')
      .eq('workspace_id', workspace.id).eq('sale_id', saleId),
    supabase.from('sales_exchange').select('*')
      .eq('workspace_id', workspace.id).eq('sale_id', saleId)
  ])
  if (saleResult.error) throw new Error(`Could not read the correlated persisted sale snapshot: ${saleResult.error.message}`)
  if (itemResult.error) throw new Error(`Could not read the correlated persisted sale-item snapshot: ${itemResult.error.message}`)
  if (exchangeResult.error) throw new Error(`Could not read the correlated exchange-rate snapshot: ${exchangeResult.error.message}`)
  if (!saleResult.data || !itemResult.data?.length) throw new Error('The correlated checkout has no persisted sale or sale-item snapshot.')
  const conversionApplied = setup.currencyConversionEnabled
  const settlementCurrency = conversionApplied
    ? setup.currency
    : String(scenario.items[0]?.currency ?? saleResult.data.currency).toLowerCase()
  return calculateExpectedCheckout(scenario, setup.fixtures, {
    settlementCurrency,
    exchangeRows: exchangeResult.data ?? [],
    conversionApplied,
    checkoutTimestamp: itemResult.data[0].created_at ?? saleResult.data.created_at ?? null
  })
}

async function reconcileNoMutation(context, setup, before, scenario, saleId = null) {
  const { supabase, workspace } = context
  const errors = []
  const [items, inventory, movements, balances, products, batches] = await Promise.all([
    supabase.from('sale_items').select('id,sale_id,product_id').eq('workspace_id', workspace.id).in('product_id', setup.productIds),
    supabase.from('inventory').select('id,product_id,storage_id,quantity').eq('workspace_id', workspace.id).in('product_id', setup.productIds),
    supabase.from('inventory_transactions').select('id,product_id,storage_id,quantity_delta,reference_id,is_deleted').eq('workspace_id', workspace.id).in('product_id', setup.productIds),
    supabase.schema('payment_accounts').from('account_balances').select('account_id,currency,balance_amount').eq('workspace_id', workspace.id),
    supabase.from('products').select('id,quantity,is_deleted,version').eq('workspace_id', workspace.id).in('id', setup.productIds),
    supabase.from('stock_batches').select('id,product_id,storage_id,quantity,is_deleted').eq('workspace_id', workspace.id).in('product_id', setup.productIds)
  ])
  for (const result of [items, inventory, movements, balances, products, batches]) if (result.error) errors.push(result.error.message)
  if (errors.length) throw new Error(errors.join('; '))
  const beforeItemIds = new Set(before.relatedSaleItems.map((row) => row.id))
  const newItems = (items.data ?? []).filter((row) => !beforeItemIds.has(row.id))
  if (newItems.length) errors.push(`Unexpected sale items were persisted: ${JSON.stringify(newItems)}`)
  for (const row of before.inventoryRows) {
    const actual = inventory.data?.find((candidate) => candidate.id === row.id)
    if (!actual || Number(actual.quantity) !== Number(row.quantity)) errors.push(`Inventory changed after rejected checkout for product ${row.product_id}, storage ${row.storage_id}.`)
  }
  const beforeMovementIds = new Set(before.inventoryTransactions.map((row) => row.id))
  const newMovements = (movements.data ?? []).filter((row) => !beforeMovementIds.has(row.id))
  if (newMovements.length) errors.push(`Unexpected inventory movements were created: ${JSON.stringify(newMovements)}`)
  for (const row of before.productRows) {
    const actual = products.data?.find((candidate) => candidate.id === row.id)
    if (!actual || Number(actual.quantity) !== Number(row.quantity) || actual.is_deleted !== row.is_deleted) {
      errors.push(`Product state changed after rejected checkout for product ${row.id}.`)
    }
  }
  const beforeBatchIds = new Set(before.batchRows.map((row) => row.id))
  const newBatches = (batches.data ?? []).filter((row) => !beforeBatchIds.has(row.id))
  if (newBatches.length) errors.push(`Unexpected stock batches were created: ${JSON.stringify(newBatches)}`)
  for (const row of before.batchRows) {
    const actual = batches.data?.find((candidate) => candidate.id === row.id)
    if (!actual || Number(actual.quantity) !== Number(row.quantity) || actual.is_deleted !== row.is_deleted) {
      errors.push(`Stock batch changed after rejected checkout for batch ${row.id}.`)
    }
  }
  for (const row of before.accountBalances) {
    const actual = balances.data?.find((candidate) => candidate.account_id === row.account_id && candidate.currency === row.currency)
    if (Math.abs(Number(actual?.balance_amount ?? 0) - Number(row.balance_amount)) > 0.000001) {
      errors.push(`Payment account balance changed after rejected checkout for account ${row.account_id}, currency ${row.currency}.`)
    }
  }
  const baselineBalanceKeys = new Set(before.accountBalances.map((row) => `${row.account_id}:${row.currency}`))
  const unexpectedBalances = (balances.data ?? []).filter((row) => !baselineBalanceKeys.has(`${row.account_id}:${row.currency}`))
  if (unexpectedBalances.length) errors.push(`Unexpected payment-account balance rows appeared after rejected checkout: ${JSON.stringify(unexpectedBalances)}`)
  let orphanChecks = { sales: [], payments: [], accountMovements: [] }
  if (saleId) {
    const [saleRows, paymentRows, accountRows] = await Promise.all([
      supabase.from('sales').select('id,workspace_id,cashier_id,origin').eq('workspace_id', workspace.id).eq('id', saleId),
      supabase.from('payment_transactions').select('id,source_type,source_record_id,is_deleted').eq('workspace_id', workspace.id).eq('source_record_id', saleId),
      supabase.schema('payment_accounts').from('account_movements').select('id,payment_transaction_id').eq('workspace_id', workspace.id).eq('payment_transaction_id', saleId)
    ])
    for (const result of [saleRows, paymentRows, accountRows]) if (result.error) errors.push(result.error.message)
    orphanChecks = { sales: saleRows.data ?? [], payments: paymentRows.data ?? [], accountMovements: accountRows.data ?? [] }
    if (orphanChecks.sales.length || orphanChecks.payments.length || orphanChecks.accountMovements.length) {
      errors.push(`Rejected checkout left sale/payment/account rows: ${JSON.stringify(orphanChecks)}`)
    }
  }
  return { passed: errors.length === 0, errors, newItems, inventory: inventory.data, newMovements, products: products.data, batches: batches.data, accountBalances: balances.data, orphanChecks }
}

async function runNegativeScenario(run, context, setup, driver, scenario) {
  updateRun(run, { stage: 'scenario', currentScenario: scenario.name })
  scenario.productIds = setup.productIds
  scenario.runId = run.id
  if (scenario.fixtureId) {
    const fixture = setup.fixtures.get(scenario.fixtureId)
    if (!fixture) throw new Error(`Negative scenario fixture ${scenario.fixtureId} is missing.`)
    scenario.source = scenario.storage
    scenario.items = [{
      fixtureId: fixture.id,
      itemType: fixture.itemType,
      storageId: scenario.storage.id,
      quantity: 1,
      price: 'original',
      customName: false,
      currency: fixture.currency
    }]
    scenario.itemTypes = fixture.itemType
    scenario.payment = { id: 'cash', label: 'Cash', ui: 'cash' }
    scenario.account = { id: null, name: 'No Account' }
  } else {
    scenario.items = []
    scenario.payment = { id: null, label: 'Not applicable' }
    scenario.account = { id: null, name: 'No Account' }
  }
  const baseline = await captureScenarioBaseline(context, setup.fixtures, { ...scenario, account: null })
  let ui
  let database
  let error = null
  let failureBaseline = baseline
  let saleId = null
  let persistedSaleId = null
  try {
    if (scenario.kind === 'empty-cart') {
      ui = await driver.attemptEmptyCart()
    } else {
      const fixture = setup.fixtures.get(scenario.fixtureId)
      await driver.prepareRejectedCheckout(scenario, fixture)
      if (scenario.kind === 'insufficient-stock') {
        const row = baseline.inventoryRows.find((candidate) => candidate.product_id === fixture.id && candidate.storage_id === scenario.storage.id)
        if (!row) throw new Error('The insufficient-stock scenario has no test-owned inventory row to modify.')
        const update = await context.supabase.from('inventory').update({ quantity: 0 })
          .eq('id', row.id).eq('workspace_id', context.workspace.id).eq('product_id', fixture.id).eq('storage_id', scenario.storage.id).select('id').maybeSingle()
        if (update.error || !update.data) throw new Error(`Could not create the controlled stale-stock condition: ${update.error?.message ?? 'inventory row was not updated'}`)
      } else if (scenario.kind === 'unavailable-product') {
        const update = await context.supabase.from('products').update({ is_deleted: true })
          .eq('id', fixture.id).eq('workspace_id', context.workspace.id).eq('created_by', context.user.id).select('id').maybeSingle()
        if (update.error || !update.data) throw new Error(`Could not create the controlled unavailable-product condition: ${update.error?.message ?? 'fixture was not updated'}`)
      } else throw new Error(`Unsupported negative scenario kind: ${scenario.kind}`)
      failureBaseline = await captureScenarioBaseline(context, setup.fixtures, { ...scenario, items: [{ fixtureId: fixture.id }], account: null })
      ui = await driver.attemptRejectedCheckout()
      saleId = ui.saleId ?? null
    }
    database = await reconcileNoMutation(context, setup, failureBaseline, { ...scenario, account: null }, saleId)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  updateRun(run, { stage: 'cleanup' })
  if (saleId) {
    // The RPC request can contain a client-generated sale ID even when the
    // transaction is rejected. Cleanup must only treat it as a sale after the
    // exact row is found and its workspace, cashier, and POS origin are proven.
    const persistedSale = await context.supabase.from('sales')
      .select('id,workspace_id,cashier_id,origin')
      .eq('id', saleId).eq('workspace_id', context.workspace.id).maybeSingle()
    if (persistedSale.error) {
      error = [error, `Could not verify whether rejected checkout ${saleId} persisted before cleanup: ${persistedSale.error.message}`].filter(Boolean).join(' ')
    } else if (persistedSale.data) {
      if (persistedSale.data.cashier_id !== context.user.id || persistedSale.data.origin !== 'pos') {
        error = [error, `Refusing cleanup of checkout ${saleId}: sale ownership did not match the configured workspace user and POS origin.`].filter(Boolean).join(' ')
      } else {
        persistedSaleId = persistedSale.data.id
      }
    }
  }
  const cleanup = await cleanupScenario(context, setup.fixtures, scenario, persistedSaleId, baseline)
  const scenarioPassed = !!ui?.passed && !!database?.passed && !error
  const failureScreenshot = !scenarioPassed || !cleanup.completed
    ? await driver.pageScreenshot(scenario.id).catch(() => null)
    : null
  let browserResetError = null
  let browserTracePath = null
  let browserInventoryVerification = null
  await driver.resetPosContext(!scenarioPassed || !cleanup.completed ? scenario.id : null, cleanup.verification?.inventoryRows ?? [], setup.fixtures).then((result) => {
    browserTracePath = result.tracePath
    browserInventoryVerification = result.inventoryVerification
  }).catch((cause) => {
    browserResetError = cause instanceof Error ? cause.message : String(cause)
  })
  if (browserInventoryVerification) cleanup.verification = { ...(cleanup.verification ?? {}), uiInventory: browserInventoryVerification }
  if (browserResetError) {
    cleanup.completed = false
    cleanup.errors.push(`Cleanup UI refresh or inventory verification failed: ${browserResetError}`)
  }
  const passed = scenarioPassed && cleanup.completed && !browserResetError
  const result = {
    id: scenario.id, name: scenario.name, status: passed ? 'passed' : 'failed',
    dimensions: scenario, ui, expected: 'Checkout is blocked and Supabase remains unchanged.',
    actual: database, before: { initial: baseline, beforeCheckout: failureBaseline },
    errors: [...(error ? [error] : database?.errors ?? []), ...(browserResetError ? [`Could not reload POS after scenario cleanup: ${browserResetError}`] : [])], cleanup
  }
  if (!passed) result.artifacts = {
    ...(failureScreenshot ? { screenshot: failureScreenshot } : { screenshot: await driver.pageScreenshot(scenario.id) }),
    ...(browserTracePath ? { trace: browserTracePath } : {})
  }
  run.results.push(result)
  run[passed ? 'passed' : 'failed'] += 1
  updateRun(run, { currentIndex: run.currentIndex + 1 })
  return result
}

async function runCheckoutScenario(run, context, setup, driver, scenario) {
  updateRun(run, { stage: 'scenario', currentScenario: scenario.name })
  scenario.workspaceId = context.workspace.id
  scenario.cashierId = context.user.id
  scenario.productIds = setup.productIds
  scenario.runId = run.id
  const baseline = await captureScenarioBaseline(context, setup.fixtures, scenario)
  let ui = null
  let after = null
  let saleId = null
  let expected = null
  let error = null
  let loanRepayment = null
  try {
    ui = await driver.performCheckout(scenario, setup.fixtures)
    saleId = ui.saleId
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    saleId = driver.rpcRequests.at(-1)?.saleId ?? null
  }

  const observedRequest = driver.rpcRequests.find((entry) => entry.saleId === saleId)
  if (saleId && observedRequest?.payload) {
    try {
      const conversionApplied = setup.currencyConversionEnabled
      const settlementCurrency = conversionApplied ? setup.currency : String(scenario.items[0].currency).toLowerCase()
      expected = calculateExpectedCheckout(scenario, setup.fixtures, {
        settlementCurrency,
        exchangeRows: observedRequest.payload.sales_exchange ?? [],
        conversionApplied,
        checkoutTimestamp: observedRequest.payload.items?.[0]?.created_at ?? null
      })
      for (const line of expected.lines) {
        line.inventorySnapshot = Number(baseline.inventoryRows.find((row) => row.product_id === line.productId && row.storage_id === line.storageId)?.quantity ?? 0)
      }
      if (ui?.displayedTotalText) {
        const formattedTotal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(expected.total)
        if (!ui.displayedTotalText.includes(formattedTotal)) {
          error = [error, `POS displayed total did not match expected ${formattedTotal}: ${ui.displayedTotalText}`].filter(Boolean).join('\n')
        }
      }
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  }

  if (!saleId) {
    try {
      saleId = await queryScenarioRows(context, setup, baseline)
    } catch (cause) {
      error = [error, `Could not correlate a new sale to this scenario's test-owned fixtures: ${cause instanceof Error ? cause.message : String(cause)}`].filter(Boolean).join('\n')
    }
  }

  if (saleId && !expected && ui?.uiSuccess) {
    try {
      expected = await calculateExpectedFromPersistedSnapshot(context, setup, scenario, saleId)
      for (const line of expected.lines) {
        line.inventorySnapshot = Number(baseline.inventoryRows.find((row) => row.product_id === line.productId && row.storage_id === line.storageId)?.quantity ?? 0)
      }
      if (ui.displayedTotalText) {
        const formattedTotal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(expected.total)
        if (!ui.displayedTotalText.includes(formattedTotal)) {
          error = [error, `POS displayed total did not match expected ${formattedTotal}: ${ui.displayedTotalText}`].filter(Boolean).join('\n')
        }
      }
    } catch (cause) {
      error = [error, `Could not independently calculate expected checkout state from the persisted exchange snapshot: ${cause instanceof Error ? cause.message : String(cause)}`].filter(Boolean).join('\n')
    }
  }

  if (saleId && expected) {
    try {
      after = await reconcileSuccessfulScenario(context, setup.fixtures, scenario, saleId, baseline, expected)
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  } else {
    try {
      after = await reconcileNoMutation(context, setup, baseline, scenario)
      if (!after.passed) error = [error, ...after.errors].filter(Boolean).join('\n')
      else if (!error) error = 'The POS showed no persisted checkout request for this generated valid scenario.'
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  }

  const observedCheckoutRequests = driver.rpcRequests.length
  const requestedSaleIds = [...new Set(driver.rpcRequests.map((entry) => entry.saleId).filter(Boolean))]
  if (requestedSaleIds.length > 1 || (observedCheckoutRequests > 1 && !scenario.duplicateSubmit)) {
    error = [error, `Expected one logical checkout; observed ${observedCheckoutRequests} request(s) and ${requestedSaleIds.length} sale ID(s).`].filter(Boolean).join('\n')
  }
  if (after && !after.passed) error = [error, JSON.stringify(after.mismatches ?? after.errors)].filter(Boolean).join('\n')

  let history = null
  if (ui?.uiSuccess && saleId && expected) {
    history = await driver.verifySaleHistory(saleId, expected, setup.fixtures, scenario)
      .catch((cause) => ({ passed: false, error: cause instanceof Error ? cause.message : String(cause) }))
    if (!history.passed) error = [error, `Sales History UI reconciliation failed: ${JSON.stringify(history)}`].filter(Boolean).join('\n')
    if (!history.passed) {
      await driver.returnToPos().catch((cause) => {
        error = [error, `Could not return the headed browser to POS after Sales History verification: ${cause instanceof Error ? cause.message : String(cause)}`].filter(Boolean).join('\n')
      })
    }
  }

  if (ui?.uiSuccess && saleId && expected && scenario.items.length === 1 && scenario.items[0].itemType === 'Product') {
    const line = expected.lines[0]
    const inventoryBefore = baseline.inventoryRows.find((row) => row.product_id === line.productId && row.storage_id === line.storageId)
    const uiAfterReload = await driver.verifyReloadedInventory(scenario.source, setup.fixtures.get(line.productId), Number(inventoryBefore?.quantity ?? 0) - line.inventoryQuantity)
      .catch((cause) => ({ passed: false, error: cause instanceof Error ? cause.message : String(cause) }))
    if (!uiAfterReload.passed) error = [error, `Reloaded POS inventory did not match: ${JSON.stringify(uiAfterReload)}`].filter(Boolean).join('\n')
    ui = { ...ui, afterReload: uiAfterReload }
  }

  if (scenario.payment.ui === 'loan' && ui?.uiSuccess && saleId) {
    updateRun(run, { stage: 'loan-details', currentScenario: scenario.name })
    if (!expected?.total) {
      error = [error, 'The loan scenario has no independently calculated sale total to validate its principal.'].filter(Boolean).join('\n')
    } else {
      loanRepayment = await exercisePosLoanRepayments(context, driver, saleId, expected.total)
      if (!loanRepayment.passed) {
        error = [error, `Loan details partial/full repayment checks failed: ${JSON.stringify(loanRepayment.errors)}`].filter(Boolean).join('\n')
      }
    }
  }

  updateRun(run, { stage: 'cleanup' })
  const cleanupSaleIds = requestedSaleIds.length ? requestedSaleIds : (saleId ? [saleId] : [])
  const cleanup = await cleanupScenario(context, setup.fixtures, scenario, cleanupSaleIds, baseline)
  let loanRepaymentCleanup = null
  if (loanRepayment?.baseline) {
    updateRun(run, { stage: 'loan-repayment-cleanup', currentScenario: scenario.name })
    loanRepaymentCleanup = await verifyPosLoanRepaymentCleanup(context, loanRepayment).catch((cause) => ({
      passed: false,
      errors: [cause instanceof Error ? cause.message : String(cause)]
    }))
    if (!loanRepaymentCleanup.passed) {
      cleanup.completed = false
      cleanup.errors.push(...loanRepaymentCleanup.errors.map((message) => `Loan repayment cleanup reconciliation: ${message}`))
      error = [error, `Loan repayment cleanup did not reconcile: ${JSON.stringify(loanRepaymentCleanup.errors)}`].filter(Boolean).join('\n')
    }
  }
  const failureScreenshot = !ui?.uiSuccess || !after?.passed || !cleanup.completed || !!error || (loanRepayment && !loanRepayment.passed)
    ? await driver.pageScreenshot(scenario.id).catch(() => null)
    : null
  let browserResetError = null
  let browserTracePath = null
  let browserInventoryVerification = null
  await driver.resetPosContext(!ui?.uiSuccess || !after?.passed || !cleanup.completed || !!error ? scenario.id : null, cleanup.verification?.inventoryRows ?? [], setup.fixtures).then((result) => {
    browserTracePath = result.tracePath
    browserInventoryVerification = result.inventoryVerification
  }).catch((cause) => {
    browserResetError = cause instanceof Error ? cause.message : String(cause)
  })
  if (browserInventoryVerification) cleanup.verification = { ...(cleanup.verification ?? {}), uiInventory: browserInventoryVerification }
  if (browserResetError) {
    cleanup.completed = false
    cleanup.errors.push(`Cleanup UI refresh or inventory verification failed: ${browserResetError}`)
  }
  if (browserResetError) error = [error, `Could not reload POS after scenario cleanup: ${browserResetError}`].filter(Boolean).join('\n')
  const passed = !!ui?.uiSuccess && !!after?.passed && cleanup.completed && !error
    && (scenario.payment.ui !== 'loan' || !!loanRepayment?.passed)
  const result = {
    id: scenario.id,
    name: scenario.name,
    status: passed ? 'passed' : 'failed',
    dimensions: {
      storage: scenario.source.name,
      itemTypes: scenario.itemTypes,
      modifiers: scenario.items.map((item) => ({ quantity: item.quantity, price: item.price, customName: item.customName, discount: scenario.discount })),
      paymentMethod: scenario.payment.label,
      paymentAccount: scenario.account.name,
      coverage: scenario.coverage ?? []
    },
    expected,
    ui,
    history,
    loanRepayment,
    loanRepaymentCleanup,
    observedCheckoutRequests,
    actual: after,
    before: baseline,
    errors: error ? [error] : [],
    cleanup
  }
  if (!passed) result.artifacts = {
    ...(failureScreenshot ? { screenshot: failureScreenshot } : { screenshot: await driver.pageScreenshot(scenario.id) }),
    ...(browserTracePath ? { trace: browserTracePath } : {})
  }
  run.results.push(result)
  run[passed ? 'passed' : 'failed'] += 1
  updateRun(run, { currentIndex: run.currentIndex + 1 })
  return result
}

async function correlateActivityTransaction(context, activitySetup, baseline) {
  const result = await context.supabase.schema('activities').from('activity_transaction_lines')
    .select('id,transaction_id,activity_id').eq('workspace_id', context.workspace.id).in('activity_id', activitySetup.ids)
  if (result.error) throw new Error(`Could not correlate a persisted Activities transaction: ${result.error.message}`)
  const priorLineIds = new Set(baseline.activityLineRows.map((row) => row.id))
  const transactionIds = [...new Set((result.data ?? []).filter((row) => !priorLineIds.has(row.id)).map((row) => row.transaction_id))]
  return transactionIds.length === 1 ? transactionIds[0] : null
}

async function runActivityScenario(run, context, setup, activitySetup, driver, scenario) {
  updateRun(run, { stage: 'scenario', currentScenario: scenario.name })
  scenario.workspaceId = context.workspace.id
  scenario.cashierId = context.user.id
  scenario.productIds = setup.productIds
  scenario.runId = run.id
  let baseline = null
  let ui = null
  let expected = null
  let actual = null
  let history = null
  let error = null
  let transactionId = null
  try {
    const businessBaseline = await captureScenarioBaseline(context, setup.fixtures, scenario)
    const activityBaseline = await captureActivityBaseline(context, activitySetup, scenario)
    baseline = { ...businessBaseline, ...activityBaseline }
    ui = await driver.performActivityCheckout(scenario, setup.fixtures)
    transactionId = ui.transactionId
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  if (!baseline) {
    try {
      const businessBaseline = await captureScenarioBaseline(context, setup.fixtures, scenario)
      const activityBaseline = await captureActivityBaseline(context, activitySetup, scenario)
      baseline = { ...businessBaseline, ...activityBaseline }
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  }
  if (!transactionId && baseline) transactionId = await correlateActivityTransaction(context, activitySetup, baseline).catch(() => null)
  if (transactionId && baseline) {
    try {
      expected = calculateExpectedActivityCheckout(context, activitySetup, scenario)
      actual = await reconcileActivityCheckout(context, activitySetup, scenario, transactionId, baseline, expected)
      if (!actual.passed) error = [error, JSON.stringify(actual.mismatches)].filter(Boolean).join('\n')
      if (ui?.displayedTotalText) {
        const total = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(expected.total)
        if (!ui.displayedTotalText.includes(total)) error = [error, `POS displayed total did not match expected ${total}: ${ui.displayedTotalText}`].filter(Boolean).join('\n')
      }
      if (ui?.uiSuccess) {
        expected.transactionNo = actual.transaction?.transaction_no ?? null
        history = await driver.verifySaleHistory(transactionId, expected, setup.fixtures, scenario)
        if (!history.passed) error = [error, `Activities Sales History UI reconciliation failed: ${JSON.stringify(history)}`].filter(Boolean).join('\n')
      }
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  } else if (baseline) {
    try {
      const noMutation = await reconcileNoMutation(context, setup, baseline, { ...scenario, account: null })
      actual = noMutation
      if (!noMutation.passed) error = [error, ...noMutation.errors].filter(Boolean).join('\n')
      if (!error) error = 'The Activities checkout did not persist the expected transaction and lines.'
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  }
  const observedActivityTransactionIds = [...new Set(driver.activityRequests.map((entry) => entry.transactionId))]
  if (observedActivityTransactionIds.length !== 1 || (transactionId && observedActivityTransactionIds.some((id) => id !== transactionId))) {
    error = [error, `Expected one logical Activities transaction ID, observed ${observedActivityTransactionIds.length}.`].filter(Boolean).join('\n')
  }
  if (ui?.uiSuccess && transactionId && expected && scenario.items.length === 1) {
    const line = expected.lines[0]
    const catalogBefore = baseline.activityCatalogRows.find((row) => row.id === line.activityId)
    if (!line.isInfinite) {
      const uiAfterReload = await driver.verifyReloadedActivityAvailability(scenario.source, setup.fixtures.get(line.activityId), Number(catalogBefore?.available_quantity ?? 0) - line.quantity)
        .catch((cause) => ({ passed: false, error: cause instanceof Error ? cause.message : String(cause) }))
      if (!uiAfterReload.passed) error = [error, `Reloaded Activities availability did not match: ${JSON.stringify(uiAfterReload)}`].filter(Boolean).join('\n')
      ui = { ...ui, afterReload: uiAfterReload }
    }
  }
  updateRun(run, { stage: 'cleanup' })
  const cleanup = baseline
    ? await cleanupActivityScenario(context, activitySetup, scenario, transactionId, baseline)
    : { completed: false, errors: ['Activities baseline was unavailable; cleanup could not be verified.'] }
  const failureScreenshot = !ui?.uiSuccess || !actual?.passed || !cleanup.completed || !!error
    ? await driver.pageScreenshot(scenario.id).catch(() => null)
    : null
  let browserTracePath = null
  await driver.resetPosContext(!ui?.uiSuccess || !actual?.passed || !cleanup.completed || !!error ? scenario.id : null, [], setup.fixtures).then((result) => {
    browserTracePath = result.tracePath
  }).catch((cause) => {
    error = [error, `Could not reload POS after Activities cleanup: ${cause instanceof Error ? cause.message : String(cause)}`].filter(Boolean).join('\n')
    cleanup.completed = false
    cleanup.errors.push(`Cleanup UI refresh failed: ${error}`)
  })
  const passed = !!ui?.uiSuccess && !!actual?.passed && cleanup.completed && !error
  const result = {
    id: scenario.id, name: scenario.name, status: passed ? 'passed' : 'failed',
    dimensions: { storage: scenario.source.name, itemTypes: scenario.itemTypes, modifiers: scenario.items.map((item) => ({ quantity: item.quantity, price: item.price })), paymentMethod: scenario.payment.label, paymentAccount: scenario.account.name, coverage: scenario.coverage ?? [] },
    expected, ui, history, actual, before: baseline, errors: error ? [error] : [], cleanup
  }
  if (!passed) result.artifacts = {
    ...(failureScreenshot ? { screenshot: failureScreenshot } : { screenshot: await driver.pageScreenshot(scenario.id) }),
    ...(browserTracePath ? { trace: browserTracePath } : {})
  }
  run.results.push(result)
  run[passed ? 'passed' : 'failed'] += 1
  updateRun(run, { currentIndex: run.currentIndex + 1 })
  return result
}

async function correlateQuickOrder(context, customer, baseline) {
  const result = await context.supabase.schema('crm').from('sales_orders').select('id,workspace_id,created_by,business_partner_id,customer_id,source_channel')
    .eq('workspace_id', context.workspace.id).eq('business_partner_id', customer.id)
  if (result.error) throw new Error(`Could not correlate the Quick Order persisted for this scenario: ${result.error.message}`)
  const created = (result.data ?? []).filter((row) => !baseline.orderIds.includes(row.id))
  if (created.length > 1) throw new Error(`A logical Quick Order produced multiple new orders: ${JSON.stringify(created)}`)
  return created[0]?.id ?? null
}

async function runQuickOrderScenario(run, context, setup, quickOrderSetup, driver, scenario, cleanupScenarioCustomer = false) {
  updateRun(run, { stage: 'quick-order-scenario', currentScenario: scenario.name })
  scenario.workspaceId = context.workspace.id
  scenario.cashierId = context.user.id
  scenario.runId = run.id
  let baseline = null
  let ui = null
  let expected = null
  let actual = null
  let orderId = null
  let error = null
  let loanRepayment = null
  try {
    baseline = await captureQuickOrderBaseline(context, quickOrderSetup, scenario)
    ui = await driver.performQuickOrder(scenario, setup.fixtures)
    orderId = ui.orderId ?? driver.quickOrderWrites.find((entry) => entry.orderId)?.orderId ?? null
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    orderId = driver.quickOrderWrites.find((entry) => entry.orderId)?.orderId ?? null
  }

  if (!baseline) {
    try { baseline = await captureQuickOrderBaseline(context, quickOrderSetup, scenario) }
    catch (cause) { error = [error, `Quick Order baseline could not be recovered: ${cause instanceof Error ? cause.message : String(cause)}`].filter(Boolean).join('\n') }
  }
  if (!orderId && baseline) {
    orderId = await correlateQuickOrder(context, quickOrderSetup.customer, baseline)
      .catch((cause) => {
        error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
        return null
      })
  }

  if (baseline && scenario.negative) {
    try {
      actual = await reconcileQuickOrderNoMutation(context, quickOrderSetup, scenario, baseline)
      if (!ui?.passed) error = [error, `Quick Order did not block the invalid submission as expected: ${JSON.stringify(ui?.actual ?? ui ?? null)}`].filter(Boolean).join('\n')
      if (!actual.passed) error = [error, ...actual.errors].filter(Boolean).join('\n')
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  } else if (baseline && orderId) {
    try {
      actual = await reconcileQuickOrder(context, quickOrderSetup, scenario, orderId, baseline)
      expected = actual.expected
      if (!actual.passed) error = [error, `Quick Order Supabase reconciliation failed: ${JSON.stringify(actual.mismatches)}`].filter(Boolean).join('\n')
      if (ui?.uiSuccess && scenario.orderStatus === 'completed') {
        const inventoryBefore = baseline.rows.inventory.find((row) => row.storage_id === scenario.source.id)
        const uiInventory = await driver.verifyReloadedInventory(scenario.source, setup.fixtures.get(scenario.fixtureId), Number(inventoryBefore?.quantity ?? 0) - 1)
        ui = { ...ui, afterReloadInventory: uiInventory }
        if (!uiInventory.passed) error = [error, `Quick Order inventory UI did not reflect the completed order after reload: ${JSON.stringify(uiInventory)}`].filter(Boolean).join('\n')
      }
      if (['loan', 'installments'].includes(scenario.method?.id) && scenario.orderStatus !== 'draft') {
        const actualOrder = actual.actual?.order
        const loan = actual.actual?.loans?.find((row) => !row.is_deleted)
        if (!actualOrder || !loan || actualOrder.linked_loan_id !== loan.id || loan.order_id !== orderId) {
          error = [error, `Quick Order financing relationship did not reconcile: ${JSON.stringify({ linkedLoanId: actualOrder?.linked_loan_id, loans: actual.actual?.loans })}`].filter(Boolean).join('\n')
        }
      }
      if (scenario.method?.id === 'loan' && scenario.orderStatus !== 'draft' && actual.passed) {
        updateRun(run, { stage: 'quick-order-loan-details', currentScenario: scenario.name })
        loanRepayment = await exerciseQuickOrderLoanRepayments(context, driver, scenario, orderId, actual.actual)
        if (!loanRepayment.passed) error = [error, `Quick Order loan details partial/full repayment checks failed: ${JSON.stringify(loanRepayment.errors)}`].filter(Boolean).join('\n')
      }
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  } else if (baseline) {
    try {
      actual = await reconcileQuickOrderNoMutation(context, quickOrderSetup, scenario, baseline)
      if (!actual.passed) error = [error, ...actual.errors].filter(Boolean).join('\n')
      if (!scenario.negative && !error) error = 'The valid Quick Order did not persist the expected order.'
    } catch (cause) {
      error = [error, cause instanceof Error ? cause.message : String(cause)].filter(Boolean).join('\n')
    }
  }

  updateRun(run, { stage: 'quick-order-cleanup', currentScenario: scenario.name })
  const cleanup = baseline
    ? await cleanupQuickOrderScenario(context, quickOrderSetup, scenario, orderId, baseline, {
      discardCustomer: cleanupScenarioCustomer,
      returnCompletedFinancedOrder: (completedOrderId) => driver.returnQuickOrderForCleanup(completedOrderId)
    })
    : { attempted: false, completed: false, errors: ['Quick Order baseline was unavailable; cleanup could not be safely scoped.'] }
  if (!cleanup.completed) error = [error, `Quick Order cleanup did not restore the captured baseline: ${JSON.stringify(cleanup.errors)}`].filter(Boolean).join('\n')
  const failure = scenario.negative ? !ui?.passed || !actual?.passed || !cleanup.completed || !!error
    : !ui?.uiSuccess || !actual?.passed || !cleanup.completed || !!error
  const failureScreenshot = failure ? await driver.pageScreenshot(scenario.id).catch(() => null) : null
  const targetInventory = cleanup.verification?.inventory?.filter((row) => row.product_id === setup.fixtures.get(scenario.fixtureId)?.id && row.storage_id === scenario.source.id) ?? []
  let browserTracePath = null
  let browserInventoryVerification = null
  await driver.resetPosContext(failure ? scenario.id : null, targetInventory, setup.fixtures).then((result) => {
    browserTracePath = result.tracePath
    browserInventoryVerification = result.inventoryVerification
  }).catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    error = [error, `Could not reload POS after Quick Order cleanup: ${message}`].filter(Boolean).join('\n')
    cleanup.completed = false
    cleanup.errors.push(`Cleanup UI refresh failed: ${message}`)
  })
  if (browserInventoryVerification) cleanup.verification = { ...(cleanup.verification ?? {}), uiInventory: browserInventoryVerification }
  if (browserInventoryVerification && !browserInventoryVerification.passed) {
    error = [error, `Quick Order cleanup inventory did not reconcile in the reloaded POS: ${JSON.stringify(browserInventoryVerification)}`].filter(Boolean).join('\n')
    cleanup.completed = false
  }

  // Deletion changes remote partner visibility while Hybrid keeps a local
  // mirror. Retain the isolated customer until the headed POS context closes;
  // final teardown will then soft-delete and verify it without racing its sync.
  if (cleanupScenarioCustomer) cleanup.customer = { attempted: false, completed: true, deferred: true, errors: [] }

  const passed = scenario.negative
    ? !!ui?.passed && !!actual?.passed && cleanup.completed && !error
    : !!ui?.uiSuccess && !!actual?.passed && cleanup.completed && !error
  const result = {
    id: scenario.id,
    name: scenario.name,
    status: passed ? 'passed' : 'failed',
    dimensions: {
      environment: 'POS Quick Order', storage: scenario.source.name, itemType: 'Product',
      paymentMethod: scenario.method?.label ?? 'Missing', paymentStatus: scenario.paymentStatus ?? 'Missing',
      paymentAccount: scenario.account?.name ?? 'No Account', orderStatus: scenario.orderStatus,
      coverage: scenario.coverage ?? [], negativeKind: scenario.negativeKind ?? null
    },
    expected: expected ?? scenario.expectedUi ?? null,
    ui,
    loanRepayment,
    orderId,
    before: baseline,
    actual,
    errors: error ? [error] : [],
    cleanup
  }
  if (!passed) result.artifacts = {
    ...(failureScreenshot ? { screenshot: failureScreenshot } : { screenshot: await driver.pageScreenshot(scenario.id) }),
    ...(browserTracePath ? { trace: browserTracePath } : {})
  }
  run.results.push(result)
  run[passed ? 'passed' : 'failed'] += 1
  updateRun(run, { currentIndex: run.currentIndex + 1 })
  return result
}

async function saveRunReport(run) {
  await mkdir(run.artifactsDirectory, { recursive: true })
  const report = {
    title: run.title,
    runId: run.id,
    status: run.status,
    target: run.target,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts: { total: run.totalScenarios, passed: run.passed, failed: run.failed, blocked: run.blocked },
    results: run.results,
    logs: run.logs,
    artifactsDirectory: run.artifactsDirectory,
    scenarioDimensions: run.scenarioDimensions ?? null,
    scenarioPlan: run.scenarioPlan ?? [],
    planOnly: run.planOnly ?? false,
    fixtureCleanup: run.fixtureCleanup,
    consoleDiagnostics: run.consoleDiagnostics ?? [],
    networkDiagnostics: run.networkDiagnostics ?? [],
    tracePath: run.tracePath ?? null
  }
  await writeFile(run.diagnosticsPath, JSON.stringify(report, null, 2), 'utf8')
}

async function executeCloudHybridRun(run, baseUrl, scenarioSelection, planOnly = false) {
  let context = null
  let setup = null
  let storageFixture = null
  let activitySetup = null
  let quickOrderSetup = null
  const quickOrderCustomersToCleanup = []
  const partialQuickOrderCustomersToCleanup = []
  let quickOrderSetupAttempted = false
  let driver = null
  let visibleOptions = []
  let runnerFailure = null
  let suiteFailed = false
  let fixtureCleanup = { completed: false, errors: [] }
  try {
    updateRun(run, { stage: 'authenticate' })
    context = await authenticateAndInspectWorkspace()
    run.target = context.target
    addLog(run, 'info', 'Authenticated against the configured Cloud/Hybrid workspace.', context.target)
    storageFixture = await prepareWorkspaceStorageFixture(context, run.id)
    if (storageFixture.created) {
      addLog(run, 'info', 'Created one uniquely marked POS storage for the empty Hybrid workspace.', {
        storageId: storageFixture.id,
        storageName: storageFixture.name
      })
    }
    updateRun(run, { stage: 'playwright-bootstrap' })
    driver = new CloudHybridPosDriver({
      baseUrl,
      email: context.config.email,
      password: context.config.password,
      expectedSupabaseHost: new URL(context.config.supabaseUrl).host,
      diagnosticSecrets: [context.config.email, context.config.password, context.config.supabaseKey],
      artifactDirectory: run.artifactsDirectory,
      onDiagnostic: (entry) => addLog(run, entry.level ?? 'info', entry.message, entry.details)
    })
    await driver.open()

    visibleOptions = await driver.storageOptions(storageFixture.expectedStorageIds)
    const visibleStorageIds = new Set(visibleOptions.map((option) => option.id))
    updateRun(run, { stage: 'test-data-setup' })
    const servicesAvailableInPos = visibleOptions.some((option) => option.id === '__atlas_services__')
    setup = await prepareOwnedFixtures(context, run.id, visibleStorageIds, { includeServices: servicesAvailableInPos })
    addLog(run, 'info', 'Prepared uniquely marked product, service, and inventory fixtures for POS-selectable storages.', {
      storageCount: setup.storages.length,
      servicePrepared: !!setup.service,
      paymentAccountCount: setup.paymentAccounts.length
    })
    // Fixtures are created directly in Supabase for controlled setup. Reload the
    // real POS so its own Cloud/Hybrid catalog and inventory hydrators see them.
    await driver.page.reload({ waitUntil: 'domcontentloaded' })
    await driver.waitForPosReady()
    for (const storage of setup.storages) {
      const fixture = [...setup.fixtures.values()].find((candidate) => candidate.itemType === 'Product' && candidate.storageId === storage.id)
      if (!fixture) throw new Error(`No test-owned POS product was prepared for storage ${storage.name}.`)
      await driver.verifyCatalogFixtureVisible(fixture, storage.id)
    }
    const physicalStorages = setup.storages
    const serviceSource = setup.service
      ? await driver.findServiceSource(setup.service.name, new Set(setup.storages.map((storage) => storage.id)))
      : null
    if (setup.service && serviceSource) await driver.verifyCatalogFixtureVisible(setup.service, serviceSource.id)
    const activityStorage = visibleOptions.find((option) => option.id === '__atlas_activities__')
    if (activityStorage) {
      try {
        activitySetup = await prepareOwnedActivities(context, run.id)
        for (const fixture of activitySetup.fixtures) setup.fixtures.set(fixture.id, fixture)
        await driver.page.reload({ waitUntil: 'domcontentloaded' })
        await driver.waitForPosReady()
      } catch (error) {
        suiteFailed = true
        run.blocked += 1
        run.results.push({
          id: 'activities-fixture-preparation',
          name: 'Activities | Test-owned fixture preparation',
          status: 'blocked',
          errors: [error instanceof Error ? error.message : String(error)],
          cleanup: { completed: false, errors: ['Partial Activities fixture cleanup will be checked after the POS run.'] }
        })
        updateRun(run, { currentIndex: run.currentIndex + 1 })
        addLog(run, 'error', 'Activities checkout coverage is blocked because isolated test-owned catalog data could not be prepared.')
      }
    }

    // Discover the account choices from the actual POS selector. Cash is restricted
    // to cash drawers; digital tender can expose any active selectable account.
    await driver.page.getByRole('button', { name: /Digital/i }).first().click()
    const selectableAccounts = await driver.selectablePaymentAccounts(setup.paymentAccounts)
    await driver.page.getByRole('button', { name: /^Cash$/i }).first().click()
    const availablePaymentMethods = await driver.discoverPaymentMethods()
    const { paymentMethods, selectedDigitalPaymentMethod } = selectPaymentMethodsForCloudHybridRun(
      availablePaymentMethods,
      scenarioSelection.digitalPaymentMethodId
    )
    updateRun(run, { stage: 'quick-order-bootstrap' })
    const quickOrderStorage = physicalStorages[0]
    const quickOrderFixture = [...(setup.productsByStorage.get(quickOrderStorage?.id) ?? [])]
      .find((fixture) => fixture.currency === setup.currency)
    if (!quickOrderStorage || !quickOrderFixture) throw new Error('Quick Order coverage requires one POS-selectable storage and its workspace-currency product fixture.')
    quickOrderSetupAttempted = true
    const preparedQuickOrderCustomer = await prepareQuickOrderCustomer(context, run.id, driver, quickOrderFixture, quickOrderStorage)
    const quickOrderDiscovery = preparedQuickOrderCustomer.discovery
    const quickOrderCustomer = { ...preparedQuickOrderCustomer }
    delete quickOrderCustomer.discovery
    quickOrderSetup = {
      customer: quickOrderCustomer,
      fixture: quickOrderFixture,
      source: quickOrderStorage,
      fixtures: setup.fixtures,
      paymentAccounts: []
    }
    const knownQuickMethods = new Set(['cash', 'bank_transfer', 'loan', 'installments', 'fib', 'qicard', 'zaincash', 'fastpay'])
    const quickOrderMethods = quickOrderDiscovery.options
      .filter(({ id }) => knownQuickMethods.has(id))
      .filter(({ id }) => !['fib', 'qicard', 'zaincash', 'fastpay'].includes(id) || id === selectedDigitalPaymentMethod?.id)
      .map(({ id, label }) => ({
        id,
        label,
        ui: id === 'cash' ? 'cash' : id === 'loan' ? 'loan' : id === 'installments' ? 'installments'
          : id === 'bank_transfer' ? 'bank_transfer' : 'digital',
        accountTypes: id === 'cash' ? ['cash_drawer'] : null
      }))
    const accountById = new Map(setup.paymentAccounts.map((account) => [account.id, account]))
    const quickOrderAccounts = quickOrderDiscovery.generalAccounts.map((row) => accountById.get(row.id)).filter(Boolean)
    const quickOrderCashAccounts = quickOrderDiscovery.cashAccounts.map((row) => accountById.get(row.id)).filter(Boolean)
    quickOrderSetup.paymentAccounts = quickOrderAccounts
    const quickOrderMatrix = buildQuickOrderScenarioMatrix({
      source: quickOrderStorage,
      fixture: quickOrderFixture,
      paymentMethods: quickOrderMethods,
      paymentAccounts: quickOrderAccounts,
      cashPaymentAccounts: quickOrderCashAccounts,
      customer: quickOrderCustomer
    })
    addLog(run, 'info', 'Prepared an owned Quick Order customer and discovered its available order-payment methods and accounts.', {
      storage: { id: quickOrderStorage.id, name: quickOrderStorage.name },
      product: { id: quickOrderFixture.id, name: quickOrderFixture.name, currency: quickOrderFixture.currency },
      paymentMethods: quickOrderMethods.map(({ id, label }) => ({ id, label })),
      selectedRandomDigitalMethod: quickOrderMatrix.selectedDigitalMethod?.id ?? null,
      cashAccountCount: quickOrderCashAccounts.length,
      otherPaymentAccountCount: quickOrderAccounts.length
    })
    const matrix = buildCloudHybridScenarioMatrix({
      storages: physicalStorages,
      serviceSource,
      productsByStorage: setup.productsByStorage,
      service: setup.service,
      services: setup.services,
      activitySource: activitySetup ? { id: activityStorage.id, name: activityStorage.label.replace(/\s*\(System\)\s*/i, '').trim() } : null,
      activities: activitySetup?.fixtures ?? [],
      paymentAccounts: selectableAccounts,
      paymentMethods,
      maxDiscountPercent: setup.maxDiscountPercent,
      settlementCurrency: setup.currency,
      currencyConversionEnabled: setup.currencyConversionEnabled
    })
    const negativeMatrix = buildNegativeScenarioMatrix({ storages: physicalStorages, productsByStorage: setup.productsByStorage })
    const duplicateSeed = matrix.find((scenario) => scenario.payment.id === 'cash' && !scenario.account.id && scenario.items.length === 1)
    if (duplicateSeed) matrix.push({
      ...structuredClone(duplicateSeed),
      id: 'duplicate-checkout-submit',
      duplicateSubmit: true,
      name: `${duplicateSeed.name} | Rapid Duplicate Submit`,
      coverage: [...(duplicateSeed.coverage ?? []), 'duplicate-submit-protection']
    })
    const allScenarios = [...matrix, ...negativeMatrix, ...quickOrderMatrix.positive, ...quickOrderMatrix.negative]
    const scenarioPlan = buildScenarioPlan(allScenarios, setup, serviceSource,
      activitySetup ? activityStorage : null, storageFixture)
    run.scenarioPlan = scenarioPlan
    if (planOnly && scenarioPlan.length === 0) {
      throw new Error('No compatible Cloud/Hybrid scenarios could be discovered in the configured live workspace.')
    }
    let scenariosToRun = planOnly ? [] : allScenarios
    if (!planOnly && scenarioSelection.mode !== 'all') {
      const selectedPlanIndex = scenarioPlan.findIndex((item) => item.id === scenarioSelection.scenarioId
        && item.signature === scenarioSelection.signature)
      if (selectedPlanIndex < 0) {
        throw new Error('The scenario matrix changed since the timeline was loaded. Refresh the timeline with a full run, then select the scenario again.')
      }
      if (scenarioSelection.digitalPaymentMethodId
          && selectedDigitalPaymentMethod?.id !== scenarioSelection.digitalPaymentMethodId) {
        throw new Error('The selected digital payment option is no longer available. Refresh the timeline with a full run, then select the scenario again.')
      }
      scenariosToRun = scenarioSelection.mode === 'from'
        ? allScenarios.slice(selectedPlanIndex)
        : [allScenarios[selectedPlanIndex]]
      const selectedIds = new Set(scenariosToRun.map((scenario) => scenario.id))
      for (const item of scenarioPlan) if (!selectedIds.has(item.id)) item.status = 'skipped'
    }
    const matrixCoverage = summarizeScenarioCoverage(matrix)
    run.totalScenarios = planOnly ? 0 : scenariosToRun.length + run.blocked
    run.scenarioDimensions = {
      stockStorages: physicalStorages.map(({ id, name }) => ({ id, name })),
      serviceSource: serviceSource ?? null,
      sellableTypes: ['Product', ...(serviceSource ? ['Service'] : []), ...(activitySetup ? ['Activity'] : [])],
      paymentMethods: paymentMethods.map(({ id, label }) => ({ id, label })),
      availableDigitalPaymentMethods: availablePaymentMethods
        .filter((method) => method.ui === 'digital')
        .map(({ id, label }) => ({ id, label })),
      selectedDigitalPaymentMethod: selectedDigitalPaymentMethod
        ? { id: selectedDigitalPaymentMethod.id, label: selectedDigitalPaymentMethod.label }
        : null,
      selectablePaymentAccounts: selectableAccounts.map(({ id, name, accountType }) => ({ id, name, accountType })),
      activitySource: activitySetup ? activityStorage.label : null,
      activityFixtures: activitySetup?.fixtures.map((fixture) => ({ name: fixture.name, finite: !fixture.isInfinite })) ?? [],
      negativeScenarios: negativeMatrix.map(({ name }) => name),
      quickOrder: {
        storage: { id: quickOrderStorage.id, name: quickOrderStorage.name },
        product: { id: quickOrderFixture.id, name: quickOrderFixture.name, currency: quickOrderFixture.currency },
        customer: { id: quickOrderCustomer.id, facetId: quickOrderCustomer.facetId, name: quickOrderCustomer.name },
        paymentMethods: quickOrderMethods.map(({ id, label }) => ({ id, label })),
        selectedRandomDigitalMethod: quickOrderMatrix.selectedDigitalMethod
          ? { id: quickOrderMatrix.selectedDigitalMethod.id, label: quickOrderMatrix.selectedDigitalMethod.label }
          : null,
        positiveScenarioCount: quickOrderMatrix.positive.length,
        negativeScenarios: quickOrderMatrix.negative.map(({ name }) => name)
      },
      matrixPlan: {
        ...matrixCoverage,
        negativeScenarioCount: negativeMatrix.length,
        quickOrderScenarioCount: quickOrderMatrix.positive.length + quickOrderMatrix.negative.length,
        totalRunScenarioCount: allScenarios.length,
        selectedRunScenarioCount: scenariosToRun.length,
        planOnly
      }
    }
    updateRun(run, { stage: planOnly ? 'scenario-planning' : 'running-matrix' })
    addLog(run, 'info', selectedDigitalPaymentMethod
      ? scenarioSelection.digitalPaymentMethodId
        ? `Reused the timeline's selected digital payment option for this run: ${selectedDigitalPaymentMethod.label}.`
        : `Randomly selected one digital payment option for this run: ${selectedDigitalPaymentMethod.label}.`
      : 'No digital payment options were available for this run.', {
      available: run.scenarioDimensions.availableDigitalPaymentMethods,
      selected: run.scenarioDimensions.selectedDigitalPaymentMethod
    })
    addLog(run, 'info', `Generated ${allScenarios.length} scenarios from explicit behavior coverage obligations.`, {
      ...run.scenarioDimensions.matrixPlan,
      selectedRun: run.scenarioSelection
    })
    if (planOnly) addLog(run, 'info', 'Scenario timeline prepared. No checkout scenarios were executed.')

    let primaryQuickOrderCustomerUsed = false
    for (const scenario of scenariosToRun) {
      if (run.cancelRequested) break
      let scenarioQuickOrderSetup = quickOrderSetup
      let cleanupScenarioCustomer = false
      if (scenario.domain === 'quick-order') {
        if (!primaryQuickOrderCustomerUsed) {
          primaryQuickOrderCustomerUsed = true
          cleanupScenarioCustomer = true
        } else {
          updateRun(run, { stage: 'quick-order-customer-setup', currentScenario: scenario.name })
          try {
            const preparedCustomer = await prepareQuickOrderCustomer(
              context,
              run.id,
              driver,
              quickOrderSetup.fixture,
              quickOrderSetup.source,
              scenario.id
            )
            const { discovery: _discovery, ...scenarioCustomer } = preparedCustomer
            scenario.customer = scenarioCustomer
            scenarioQuickOrderSetup = { ...quickOrderSetup, customer: scenarioCustomer }
            cleanupScenarioCustomer = true
            addLog(run, 'info', 'Prepared a scenario-owned Quick Order customer through the POS compact form.', {
              scenarioId: scenario.id,
              customerId: scenarioCustomer.id
            })
          } catch (cause) {
            partialQuickOrderCustomersToCleanup.push({ scenarioId: scenario.id })
            const message = cause instanceof Error ? cause.message : String(cause)
            const failure = {
              id: scenario.id,
              name: scenario.name,
              status: 'failed',
              dimensions: {
                environment: 'POS Quick Order',
                storage: scenario.source.name,
                itemType: 'Product',
                paymentMethod: scenario.method?.label ?? 'Missing',
                paymentStatus: scenario.paymentStatus ?? 'Missing',
                paymentAccount: scenario.account?.name ?? 'No Account',
                orderStatus: scenario.orderStatus,
                coverage: scenario.coverage ?? [],
                negativeKind: scenario.negativeKind ?? null
              },
              expected: 'Create and verify an isolated test-owned customer through the Quick Order compact form before executing this scenario.',
              ui: null,
              orderId: null,
              before: null,
              actual: {
                passed: false,
                errors: [message],
                partialCustomerCleanup: { attempted: false, completed: true, deferred: true, errors: [] }
              },
              errors: [`Quick Order customer setup failed: ${message}`],
              cleanup: {
                attempted: true,
                completed: true,
                deferred: true,
                errors: []
              }
            }
            run.results.push(failure)
            run.failed += 1
            const planEntry = run.scenarioPlan.find((item) => item.id === scenario.id)
            if (planEntry) planEntry.status = 'failed'
            updateRun(run, { currentIndex: run.currentIndex + 1 })
            suiteFailed = true
            addLog(run, 'error', `Scenario failed before checkout while creating its isolated Quick Order customer: ${scenario.name}`, {
              errors: failure.errors,
              cleanup: failure.cleanup
            })
            break
          }
        }
      }
      if (scenario.domain === 'quick-order' && cleanupScenarioCustomer) {
        if (scenarioQuickOrderSetup === quickOrderSetup) {
          const primary = quickOrderCustomersToCleanup.find((entry) => entry.customer.id === scenario.customer?.id)
          if (primary) primary.scenarioId = scenario.id
          else quickOrderCustomersToCleanup.push({ scenarioId: scenario.id, customer: scenario.customer })
        } else {
          quickOrderCustomersToCleanup.push({ scenarioId: scenario.id, customer: scenario.customer })
        }
      }
      const result = scenario.domain === 'quick-order'
        ? await runQuickOrderScenario(run, context, setup, scenarioQuickOrderSetup, driver, scenario, cleanupScenarioCustomer)
        : scenario.kind
        ? await runNegativeScenario(run, context, setup, driver, scenario)
        : scenario.domain === 'activity'
          ? await runActivityScenario(run, context, setup, activitySetup, driver, scenario)
          : await runCheckoutScenario(run, context, setup, driver, scenario)
      const planEntry = run.scenarioPlan.find((item) => item.id === scenario.id)
      if (planEntry) planEntry.status = result.status
      if (result.status === 'failed') {
        suiteFailed = true
        addLog(run, 'error', `Scenario failed: ${scenario.name}`, { errors: result.errors, cleanup: result.cleanup })
        if (result.cleanup?.completed === false) {
          addLog(run, 'error', 'The runner stopped because cleanup did not restore the scenario baseline.')
          break
        }
      }
    }
    const completedScenarioIds = new Set(run.results.map((result) => result.id))
    for (const scenario of scenariosToRun) {
      const planEntry = run.scenarioPlan.find((item) => item.id === scenario.id)
      if (planEntry?.status === 'pending' && run.cancelRequested && !completedScenarioIds.has(scenario.id)) {
        planEntry.status = 'cancelled'
      } else if (planEntry?.status === 'pending' && !completedScenarioIds.has(scenario.id)) {
        planEntry.status = 'skipped'
      }
    }
  } catch (error) {
    suiteFailed = true
    run.blocked += run.totalScenarios === 0 ? 1 : 0
    runnerFailure = {
      stage: run.stage,
      message: error instanceof Error ? error.message : 'Cloud/Hybrid Playwright preflight failed.',
      stack: error instanceof Error ? error.stack : null
    }
    addLog(run, 'error', runnerFailure.message, runnerFailure.stack ? { stack: runnerFailure.stack } : undefined)
  } finally {
    for (const item of run.scenarioPlan) {
      if (item.status !== 'pending') continue
      if (planOnly && !run.cancelRequested && !runnerFailure) continue
      item.status = run.cancelRequested ? 'cancelled' : runnerFailure ? 'blocked' : 'skipped'
    }
    updateRun(run, { stage: 'fixture-cleanup' })
    const transactionCleanupFailed = run.results.some((result) => result.cleanup?.completed === false)
    if (context && setup && transactionCleanupFailed) {
      fixtureCleanup = {
        completed: false,
        errors: ['Test-owned fixtures were retained because a scenario transaction could not be fully rolled back and verified.']
      }
      addLog(run, 'error', 'Fixture teardown was held because at least one scenario still has an unverified transaction cleanup.')
    } else if (context && setup) {
      fixtureCleanup = await cleanupOwnedFixtures(context, setup).catch((error) => ({ completed: false, errors: [error instanceof Error ? error.message : String(error)] }))
      if (!fixtureCleanup.completed) {
        suiteFailed = true
        addLog(run, 'error', 'Test-owned fixture cleanup did not complete.', fixtureCleanup.errors)
      }
    } else if (context) {
      fixtureCleanup = await cleanupPartialOwnedFixtures(context, run.id).catch((error) => ({ completed: false, errors: [error instanceof Error ? error.message : String(error)] }))
      if (!fixtureCleanup.completed) {
        suiteFailed = true
        addLog(run, 'error', 'Partial test-data setup cleanup did not complete.', fixtureCleanup.errors)
      }
    }
    if (context && quickOrderSetupAttempted && !quickOrderSetup) {
      partialQuickOrderCustomersToCleanup.push({ scenarioId: null })
    }
    if (context && activitySetup && transactionCleanupFailed) {
      fixtureCleanup = {
        completed: false,
        errors: [...(fixtureCleanup.errors ?? []), 'Test-owned activity fixtures were retained because a scenario transaction could not be fully rolled back and verified.']
      }
    } else if (context && activitySetup) {
      const activityCleanup = await cleanupOwnedActivities(context, activitySetup).catch((error) => ({ completed: false, errors: [error instanceof Error ? error.message : String(error)] }))
      fixtureCleanup = { completed: fixtureCleanup.completed && activityCleanup.completed, errors: [...(fixtureCleanup.errors ?? []), ...(activityCleanup.errors ?? [])] }
      if (!activityCleanup.completed) {
        suiteFailed = true
        addLog(run, 'error', 'Test-owned Activities fixture cleanup did not complete.', activityCleanup.errors)
      }
    } else if (context) {
      const activityCleanup = await cleanupPartialOwnedActivities(context, run.id).catch((error) => ({ completed: false, errors: [error instanceof Error ? error.message : String(error)] }))
      fixtureCleanup = { completed: fixtureCleanup.completed && activityCleanup.completed, errors: [...(fixtureCleanup.errors ?? []), ...(activityCleanup.errors ?? [])] }
      if (!activityCleanup.completed) {
        suiteFailed = true
        addLog(run, 'error', 'Partial Activities fixture cleanup did not complete.', activityCleanup.errors)
      }
    }
    if (context && storageFixture?.created && transactionCleanupFailed) {
      fixtureCleanup = {
        completed: false,
        errors: [...(fixtureCleanup.errors ?? []), 'The POS storage fixture was retained because a scenario transaction could not be fully rolled back and verified.']
      }
    } else if (context && storageFixture?.created) {
      const storageCleanup = await cleanupWorkspaceStorageFixture(context, storageFixture)
        .catch((error) => ({ completed: false, errors: [error instanceof Error ? error.message : String(error)] }))
      fixtureCleanup = {
        completed: fixtureCleanup.completed && storageCleanup.completed,
        errors: [...(fixtureCleanup.errors ?? []), ...(storageCleanup.errors ?? [])]
      }
      if (!storageCleanup.completed) {
        suiteFailed = true
        addLog(run, 'error', 'Test-owned POS storage cleanup did not restore its inactive baseline.', storageCleanup.errors)
      }
    }
    if (runnerFailure && run.results.length === 0) {
      run.totalScenarios = Math.max(1, run.totalScenarios)
      run.currentIndex = 1
      const screenshot = driver ? await driver.pageScreenshot('runner-bootstrap') : null
      run.results.push({
        id: 'runner-bootstrap',
        name: `${runnerFailure.stage} | POS bootstrap and source discovery`,
        status: 'blocked',
        errors: [runnerFailure.message],
        actual: { visiblePosSources: visibleOptions.map(({ id, label }) => ({ id, label })) },
        cleanup: fixtureCleanup,
        artifacts: screenshot ? { screenshot } : {}
      })
    }
    updateRun(run, { stage: 'artifacts' })
    if (driver) {
      run.consoleDiagnostics = driver.consoleDiagnostics
      run.networkDiagnostics = driver.getNetworkDiagnostics()
      run.tracePath = await driver.saveTrace().catch(() => null)
      await driver.close()
    }
    if (context) {
      const cleanupCustomer = async (entry) => {
        if (entry.customer) return cleanupQuickOrderCustomer(context, entry.customer)
        return cleanupPartialQuickOrderCustomer(context, run.id, entry.scenarioId)
      }
      for (const entry of quickOrderCustomersToCleanup) {
        const customerCleanup = await cleanupCustomer(entry)
          .catch((error) => ({ completed: false, errors: [error instanceof Error ? error.message : String(error)] }))
        fixtureCleanup = {
          completed: fixtureCleanup.completed && customerCleanup.completed,
          errors: [...(fixtureCleanup.errors ?? []), ...(customerCleanup.errors ?? [])]
        }
        const scenarioResult = entry.scenarioId
          ? run.results.find((result) => result.id === entry.scenarioId)
          : null
        if (scenarioResult) {
          scenarioResult.cleanup.customer = { attempted: true, ...customerCleanup, deferred: false }
          if (!customerCleanup.completed) {
            scenarioResult.cleanup.completed = false
            scenarioResult.cleanup.errors.push(...customerCleanup.errors)
            scenarioResult.errors.push(`Quick Order scenario customer cleanup failed: ${JSON.stringify(customerCleanup.errors)}`)
            if (scenarioResult.status === 'passed') {
              scenarioResult.status = 'failed'
              run.passed = Math.max(0, run.passed - 1)
              run.failed += 1
              const planEntry = run.scenarioPlan.find((item) => item.id === entry.scenarioId)
              if (planEntry) planEntry.status = 'failed'
            }
            suiteFailed = true
          }
        }
        if (!customerCleanup.completed) {
          suiteFailed = true
          addLog(run, 'error', 'Test-owned Quick Order customer cleanup did not complete.', customerCleanup.errors)
        }
      }
      for (const entry of partialQuickOrderCustomersToCleanup) {
        const partialCleanup = await cleanupPartialQuickOrderCustomer(context, run.id, entry.scenarioId)
          .catch((error) => ({ completed: false, errors: [error instanceof Error ? error.message : String(error)] }))
        fixtureCleanup = {
          completed: fixtureCleanup.completed && partialCleanup.completed,
          errors: [...(fixtureCleanup.errors ?? []), ...(partialCleanup.errors ?? [])]
        }
        const scenarioResult = entry.scenarioId
          ? run.results.find((result) => result.id === entry.scenarioId)
          : null
        if (scenarioResult) {
          scenarioResult.cleanup.partialCustomerCleanup = { attempted: true, ...partialCleanup, deferred: false }
          scenarioResult.cleanup.completed = scenarioResult.cleanup.completed && partialCleanup.completed
          if (!partialCleanup.completed) {
            scenarioResult.cleanup.errors.push(...partialCleanup.errors)
            scenarioResult.errors.push(`Partial Quick Order customer cleanup failed: ${JSON.stringify(partialCleanup.errors)}`)
            suiteFailed = true
          }
        }
        if (!partialCleanup.completed) {
          suiteFailed = true
          addLog(run, 'error', 'Partial Quick Order customer cleanup did not complete.', partialCleanup.errors)
        }
      }
    }
    await disposeLiveContext(context)
    run.fixtureCleanup = fixtureCleanup
    if (run.cancelRequested) updateRun(run, { status: 'cancelled', stage: 'cancelled', finishedAt: now() })
    else {
      const finalStatus = planOnly && !run.failed && !run.blocked && !suiteFailed && fixtureCleanup.completed
        ? 'planned'
        : run.failed > 0 ? 'failed' : run.blocked > 0 ? 'blocked' : suiteFailed ? 'failed' : 'passed'
      if (planOnly && finalStatus !== 'planned') {
        for (const item of run.scenarioPlan) if (item.status === 'pending') item.status = 'blocked'
      }
      updateRun(run, {
        status: finalStatus,
        stage: finalStatus === 'planned' ? 'scenario-plan-ready' : finalStatus === 'passed' ? 'completed' : finalStatus,
        finishedAt: now()
      })
    }
    await saveRunReport(run).catch((error) => addLog(run, 'error', `Could not save diagnostics report: ${error.message}`))
  }
}
