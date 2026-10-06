import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadLiveTestConfiguration, safeConfigurationSummary } from './config.mjs'

const TEST_MARKER = 'atlas-cloud-hybrid-playwright'
const FIXTURE_PRICE = 100
const MODIFIED_PRICE = 120
const INVENTORY_SEED = 100
const SUPPORTED_POS_CURRENCIES = ['usd', 'iqd', 'eur', 'try']
const ownedFixtureJournal = new Map()

function chunks(rows, size = 100) {
  const batches = []
  for (let index = 0; index < rows.length; index += size) batches.push(rows.slice(index, index + size))
  return batches
}

function sameInstant(left, right) {
  const leftTime = left ? new Date(left).getTime() : NaN
  const rightTime = right ? new Date(right).getTime() : NaN
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

function requireData(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

function createLiveClient(config) {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })
}

export async function authenticateAndInspectWorkspace() {
  const config = loadLiveTestConfiguration()
  const supabase = createLiveClient(config)
  const signedIn = await supabase.auth.signInWithPassword({ email: config.email, password: config.password })
  if (signedIn.error || !signedIn.data.user) throw new Error('The configured live-test account could not sign in to Supabase.')
  const user = signedIn.data.user
  const [workspaceResult, profileResult] = await Promise.all([
    supabase.from('workspaces')
      .select('id,name,data_mode,default_currency,pos_convert_to_workspace_currency,max_discount_percent,deleted_at')
      .eq('id', config.workspaceId).maybeSingle(),
    supabase.from('profiles')
      .select('id,workspace_id,current_workspace,role')
      .eq('id', user.id).maybeSingle()
  ])
  const workspace = requireData(workspaceResult, 'Could not verify the configured workspace')
  const profile = requireData(profileResult, 'Could not inspect the authenticated profile')
  if (!workspace || workspace.deleted_at) throw new Error('The configured live-test workspace is missing or deleted.')
  if (!['cloud', 'hybrid'].includes(String(workspace.data_mode).toLowerCase())) {
    throw new Error(`The configured workspace is in ${workspace.data_mode} mode; Cloud/Hybrid mode is required.`)
  }
  if (profile && profile.workspace_id && profile.workspace_id !== workspace.id
      && profile.current_workspace !== workspace.id) {
    throw new Error('The configured live-test account is not scoped to the target workspace.')
  }
  return { config, supabase, user, workspace, profile, target: safeConfigurationSummary(config, workspace) }
}

/**
 * A fresh Hybrid workspace may not have a physical POS storage yet. Create one
 * uniquely owned fixture in that case so the real POS can be exercised. The
 * caller must retire it after its product and transaction fixtures are cleaned.
 */
export async function prepareWorkspaceStorageFixture(context, runId) {
  const { supabase, workspace } = context
  const existing = await supabase.from('storages').select('id')
    .eq('workspace_id', workspace.id).eq('is_deleted', false).limit(1)
  if (existing.error) throw new Error(`Could not inspect active workspace storages: ${existing.error.message}`)
  if (existing.data?.length) return { created: false, expectedStorageIds: existing.data.map((row) => row.id) }

  const id = randomUUID()
  const name = `CHPW ${runId.slice(0, 8)} Storage`
  const createdAt = new Date().toISOString()
  const row = {
    id,
    workspace_id: workspace.id,
    name,
    is_system: false,
    is_protected: false,
    is_primary: true,
    is_marketplace: true,
    created_at: createdAt,
    updated_at: createdAt,
    is_deleted: false
  }
  const inserted = await supabase.from('storages').insert(row)
    .select('id,workspace_id,name,is_system,is_protected,is_primary,is_marketplace,created_at,is_deleted').maybeSingle()
  if (inserted.error || !inserted.data) {
    const recovered = await supabase.from('storages')
      .select('id,workspace_id,name,is_system,is_protected,is_primary,is_marketplace,created_at,is_deleted')
      .eq('id', id).eq('workspace_id', workspace.id).maybeSingle()
    if (recovered.error || !recovered.data || recovered.data.name !== name) {
      throw new Error(`Could not prepare a test-owned POS storage: ${inserted.error?.message ?? 'no row returned'}`)
    }
    return { created: true, id, workspaceId: workspace.id, name, createdAt: recovered.data.created_at, expectedStorageIds: [id] }
  }
  return { created: true, id, workspaceId: workspace.id, name, createdAt: inserted.data.created_at, expectedStorageIds: [id] }
}

export async function cleanupWorkspaceStorageFixture(context, fixture) {
  if (!fixture?.created) return { completed: true, errors: [] }
  const { supabase, workspace } = context
  const errors = []
  const current = await supabase.from('storages')
    .select('id,workspace_id,name,is_system,is_protected,is_primary,is_marketplace,created_at,is_deleted')
    .eq('id', fixture.id).eq('workspace_id', workspace.id).maybeSingle()
  if (current.error) return { completed: false, errors: [`Could not inspect the test-owned storage during cleanup: ${current.error.message}`] }
  if (!current.data) return { completed: true, errors: [] }
  if (current.data.name !== fixture.name || current.data.workspace_id !== fixture.workspaceId
      || current.data.is_system || current.data.is_protected
      || new Date(current.data.created_at).getTime() !== new Date(fixture.createdAt).getTime()) {
    return { completed: false, errors: ['Storage cleanup was skipped because ownership could not be proven from its ID, workspace, unique run marker, and creation timestamp.'] }
  }
  if (!current.data.is_deleted) {
    const retired = await supabase.from('storages').update({
      is_deleted: true,
      is_primary: false,
      is_marketplace: false,
      updated_at: new Date().toISOString()
    }).eq('id', fixture.id).eq('workspace_id', workspace.id).eq('name', fixture.name)
      .eq('created_at', fixture.createdAt).eq('is_system', false).eq('is_protected', false)
      .select('id,is_deleted,is_primary,is_marketplace').maybeSingle()
    if (retired.error || !retired.data) errors.push(`Could not retire the test-owned storage: ${retired.error?.message ?? 'no row returned'}`)
    else if (!retired.data.is_deleted || retired.data.is_primary || retired.data.is_marketplace) {
      errors.push('The test-owned storage did not verify as inactive after cleanup.')
    }
  }
  const verification = await supabase.from('storages')
    .select('id,is_deleted,is_primary,is_marketplace')
    .eq('id', fixture.id).eq('workspace_id', workspace.id).eq('name', fixture.name).maybeSingle()
  if (verification.error) errors.push(`Could not verify test-owned storage cleanup: ${verification.error.message}`)
  else if (verification.data && (!verification.data.is_deleted || verification.data.is_primary || verification.data.is_marketplace)) {
    errors.push('Test-owned storage remains active or selected after cleanup.')
  }
  return { completed: errors.length === 0, errors, storageId: fixture.id, restoredToBaseline: errors.length === 0 }
}

async function insertChecked(supabase, table, value, label) {
  const result = await supabase.from(table).insert(value).select('*').single()
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

export async function prepareOwnedFixtures(context, runId, posSelectableStorageIds = [], { includeServices = false } = {}) {
  const { supabase, workspace, user } = context
  const countResult = await supabase.from('storages').select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspace.id).eq('is_deleted', false)
  if (countResult.error) throw new Error(`Could not count active workspace stock storages: ${countResult.error.message}`)
  const selectableIds = [...new Set(posSelectableStorageIds)]
    .filter((id) => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
  const storages = []
  for (const storageIds of chunks(selectableIds)) {
    const result = await supabase.from('storages').select('id,name,is_system,is_primary,is_deleted,workspace_id')
      .eq('workspace_id', workspace.id).eq('is_deleted', false).in('id', storageIds)
    storages.push(...(requireData(result, 'Could not resolve POS-selectable stock storages') ?? []))
  }
  if (storages.length === 0) {
    throw new Error(`The POS UI exposed no active stock storage, while Supabase contains ${countResult.count ?? 'an unknown number of'} active storages for this workspace.`)
  }

  const marker = `${runId}`
  const journal = []
  ownedFixtureJournal.set(marker, journal)
  const currencyConversionEnabled = workspace.pos_convert_to_workspace_currency !== false
  const workspaceCurrency = String(workspace.default_currency ?? 'usd').toLowerCase()
  const fixtureCurrencies = currencyConversionEnabled
    ? SUPPORTED_POS_CURRENCIES
    : [String(workspace.default_currency ?? 'usd').toLowerCase()]
  const ownedIds = new Set()
  const productsByStorage = new Map()
  const fixtures = new Map()
  const productRows = []
  const inventorySeeds = []
  const productsToCreate = []

  for (const storage of storages) {
    const storageProducts = []
    for (const currency of fixtureCurrencies) {
      // One catalog fixture per source currency is sufficient for conversion
      // coverage. Keep exactly one same-currency companion for the dedicated
      // multi-product-cart case instead of duplicating every currency fixture.
      const productNumbers = currency === workspaceCurrency ? [1, 2] : [1]
      for (const productNumber of productNumbers) {
        const id = randomUUID()
        const name = `CHPW ${marker.slice(0, 8)} ${currency.toUpperCase()} Product ${productNumber} ${storage.name}`
        const product = {
          id,
          workspace_id: workspace.id,
          created_by: user.id,
          sku: `CHPW-${marker.slice(0, 10)}-${id.slice(0, 8)}`,
          name,
          description: `${TEST_MARKER}:${marker}`,
          category: 'Playwright test fixture',
          price: FIXTURE_PRICE,
          minimum_selling_price: 0,
          cost_price: 10,
          quantity: INVENTORY_SEED,
          min_stock_level: 0,
          unit: 'pcs',
          currency,
          storage_id: storage.id,
          is_service: false,
          is_deleted: false
        }
        productsToCreate.push(product)
        inventorySeeds.push({
          workspace_id: workspace.id,
          product_id: id,
          storage_id: storage.id,
          quantity: INVENTORY_SEED,
          version: 1,
          is_deleted: false
        })
        ownedIds.add(product.id)
        fixtures.set(product.id, {
          id: product.id, name: product.name, itemType: 'Product', storageId: storage.id,
          price: FIXTURE_PRICE, modifiedPrice: MODIFIED_PRICE, costPrice: 10,
          currency
        })
        storageProducts.push(fixtures.get(product.id))
      }
    }
    productsByStorage.set(storage.id, storageProducts)
  }

  const servicesToCreate = []
  if (includeServices) for (const currency of fixtureCurrencies) {
    const serviceId = randomUUID()
    const service = {
      id: serviceId,
      workspace_id: workspace.id,
      created_by: user.id,
      sku: null,
      name: `CHPW ${marker.slice(0, 8)} ${currency.toUpperCase()} Service`,
      description: `${TEST_MARKER}:${marker}`,
      category: 'Playwright test fixture',
      price: FIXTURE_PRICE,
      minimum_selling_price: 0,
      cost_price: 10,
      quantity: 0,
      min_stock_level: 0,
      unit: null,
      currency,
      storage_id: null,
      is_service: true,
      is_deleted: false
    }
    servicesToCreate.push(service)
    productsToCreate.push(service)
    ownedIds.add(service.id)
    fixtures.set(service.id, {
      id: service.id, name: service.name, itemType: 'Service', storageId: null,
      price: FIXTURE_PRICE, modifiedPrice: MODIFIED_PRICE, costPrice: 10,
      currency
    })
  }

  for (const batch of chunks(productsToCreate)) {
    const inserted = await supabase.from('products').insert(batch).select('*')
    if (inserted.error || inserted.data?.length !== batch.length) {
      const persisted = await supabase.from('products').select('id,workspace_id,created_by,description')
        .eq('workspace_id', workspace.id).eq('created_by', user.id).in('id', batch.map((row) => row.id))
      if (!persisted.error) journal.push(...(persisted.data ?? [])
        .filter((row) => row.description === `${TEST_MARKER}:${marker}`).map((row) => row.id))
      throw new Error(`Could not create a test-owned catalog batch: ${inserted.error?.message ?? 'not every requested row was returned'}`)
    }
    journal.push(...inserted.data.map((row) => row.id))
    productRows.push(...inserted.data)
  }
  for (const batch of chunks(inventorySeeds)) {
    const inserted = await supabase.from('inventory').insert(batch).select('id')
    if (inserted.error || inserted.data?.length !== batch.length) {
      throw new Error(`Could not seed a test-owned inventory batch: ${inserted.error?.message ?? 'not every requested row was returned'}`)
    }
  }

  const accountsResult = await supabase.schema('payment_accounts').from('accounts')
    .select('id,name,account_type,is_active,is_deleted,workspace_id')
    .eq('workspace_id', workspace.id)
    .eq('is_active', true)
    .eq('is_deleted', false)
    .order('name')
  const paymentAccounts = (requireData(accountsResult, 'Could not discover selectable payment accounts') ?? [])
    .map((account) => ({ id: account.id, name: account.name, accountType: account.account_type }))

  return {
    runId: marker,
    marker: `${TEST_MARKER}:${marker}`,
    storages,
    productsByStorage,
    service: servicesToCreate[0] ?? null,
    services: servicesToCreate,
    fixtures,
    paymentAccounts,
    productIds: [...ownedIds],
    productRows,
    maxDiscountPercent: Number(workspace.max_discount_percent ?? 100),
    currency: String(workspace.default_currency ?? 'usd').toLowerCase(),
    currencyConversionEnabled,
    fixtureCurrencies
  }
}

async function queryChecked(builder, label) {
  const result = await builder
  return requireData(result, label) ?? []
}

export async function captureScenarioBaseline(context, fixtures, scenario) {
  const { supabase, workspace } = context
  const productIds = [...new Set([...(scenario.items ?? []).map((item) => item.fixtureId), ...(scenario.productIds ?? [])])]
  if (!productIds.length) throw new Error('Cannot capture a scenario baseline without test-owned product IDs.')
  const productRows = await queryChecked(supabase.from('products')
    .select('id,workspace_id,created_by,description,quantity,version,updated_at,is_deleted')
    .eq('workspace_id', workspace.id).in('id', productIds), 'Could not capture product baseline')
  const inventoryRows = await queryChecked(supabase.from('inventory')
    .select('id,workspace_id,product_id,storage_id,quantity,version,updated_at,is_deleted')
    .eq('workspace_id', workspace.id).in('product_id', productIds), 'Could not capture inventory baseline')
  const batchRows = await queryChecked(supabase.from('stock_batches')
    .select('id,workspace_id,product_id,storage_id,batch_number,quantity,version,updated_at,is_deleted')
    .eq('workspace_id', workspace.id).in('product_id', productIds), 'Could not capture stock-batch baseline')
  const relatedSaleItems = await queryChecked(supabase.from('sale_items')
    .select('id,sale_id,product_id,storage_id,quantity,unit_price,total_price,created_at,updated_at')
    .eq('workspace_id', workspace.id).in('product_id', productIds), 'Could not capture related sale-item baseline')
  const relatedSaleIds = [...new Set(relatedSaleItems.map((row) => row.sale_id))]
  const relatedSales = relatedSaleIds.length
    ? await queryChecked(supabase.from('sales')
      .select('id,workspace_id,cashier_id,total_amount,created_at,origin,is_archived')
      .eq('workspace_id', workspace.id).in('id', relatedSaleIds), 'Could not capture related sale baseline')
    : []
  const accountId = scenario.account?.id
  const accountRows = accountId
    ? await queryChecked(supabase.schema('payment_accounts').from('accounts')
      .select('id,workspace_id,name,account_type,is_active,is_deleted,version,updated_at')
      .eq('workspace_id', workspace.id).eq('id', accountId), 'Could not capture payment-account baseline')
    : []
  const accountBalancesQuery = supabase.schema('payment_accounts').from('account_balances')
    .select('id,workspace_id,account_id,currency,balance_amount,version,updated_at,is_deleted')
    .eq('workspace_id', workspace.id)
  const accountBalances = await queryChecked(
    accountId ? accountBalancesQuery.eq('account_id', accountId) : accountBalancesQuery,
    'Could not capture account balance baseline'
  )
  const inventoryTransactions = await queryChecked(supabase.from('inventory_transactions')
    .select('id,workspace_id,product_id,storage_id,transaction_type,quantity_delta,previous_quantity,new_quantity,reference_id,reference_type,version,is_deleted')
    .eq('workspace_id', workspace.id).in('product_id', productIds), 'Could not capture inventory movement baseline')
  const accountMovements = scenario.account?.id
    ? await queryChecked(supabase.schema('payment_accounts').from('account_movements')
      .select('id,workspace_id,account_id,payment_transaction_id,direction,amount,delta_amount,currency,is_deleted')
      .eq('workspace_id', workspace.id).eq('account_id', scenario.account.id), 'Could not capture account movement baseline')
    : []
  const relatedPaymentIds = relatedSales.map((row) => row.id)
  const relatedPayments = relatedPaymentIds.length
    ? await queryChecked(supabase.from('payment_transactions')
      .select('id,workspace_id,source_type,source_record_id,account_id,amount,currency,direction,is_deleted,reversal_of_transaction_id')
      .eq('workspace_id', workspace.id).in('source_record_id', relatedPaymentIds), 'Could not capture related payment baseline')
    : []
  return { productRows, inventoryRows, batchRows, relatedSaleItems, relatedSales, relatedPayments, accountRows, accountBalances, accountMovements, inventoryTransactions }
}

export async function reconcileSuccessfulScenario(context, fixtures, scenario, saleId, baseline, expected) {
  const { supabase, workspace, user } = context
  const sales = await queryChecked(supabase.from('sales')
    .select('*').eq('workspace_id', workspace.id).eq('id', saleId), 'Could not read the persisted sale')
  const items = await queryChecked(supabase.from('sale_items')
    .select('*').eq('sale_id', saleId), 'Could not read persisted sale items')
  const paymentRows = await queryChecked(supabase.from('payment_transactions')
    .select('*').eq('workspace_id', workspace.id).eq('source_record_id', saleId), 'Could not read the POS payment transactions')
  const productIds = [...new Set([...expected.lines.map((line) => line.productId), ...baseline.productRows.map((row) => row.id)])]
  const inventoryAfter = await queryChecked(supabase.from('inventory')
    .select('*').eq('workspace_id', workspace.id).in('product_id', productIds), 'Could not read post-sale inventory')
  const batchesAfter = await queryChecked(supabase.from('stock_batches')
    .select('*').eq('workspace_id', workspace.id).in('product_id', productIds), 'Could not read post-sale stock batches')
  const inventoryTransactionsAfter = await queryChecked(supabase.from('inventory_transactions')
    .select('*').eq('workspace_id', workspace.id).in('product_id', productIds), 'Could not read post-sale inventory movements')
  const exchangeRows = await queryChecked(supabase.from('sales_exchange')
    .select('*').eq('workspace_id', workspace.id).eq('sale_id', saleId), 'Could not read sale exchange snapshots')
  const accountId = expected.paymentAccountId
  const accountMovements = await queryChecked(supabase.schema('payment_accounts').from('account_movements')
    .select('*').eq('workspace_id', workspace.id).eq('payment_transaction_id', saleId), 'Could not read account movement')
  const accountBalancesQuery = supabase.schema('payment_accounts').from('account_balances')
    .select('*').eq('workspace_id', workspace.id)
  const accountBalances = await queryChecked(
    accountId ? accountBalancesQuery.eq('account_id', accountId) : accountBalancesQuery,
    'Could not read post-sale account balances'
  )

  const mismatches = []
  if (sales.length !== 1) mismatches.push({ field: 'saleCount', expected: 1, actual: sales.length })
  const sale = sales[0]
  if (sale) {
    const checks = [
      ['sale.id', saleId, sale.id], ['sale.workspace_id', workspace.id, sale.workspace_id],
      ['sale.cashier_id', user.id, sale.cashier_id], ['sale.origin', expected.origin, sale.origin],
      ['sale.settlement_currency', expected.currency, sale.settlement_currency],
      ['sale.currency', expected.currency, String(sale.currency ?? '').toLowerCase()],
      ['sale.payment_method', expected.paymentMethod, sale.payment_method],
      ['sale.is_archived', false, Boolean(sale.is_archived)],
      ['sale.customer_id', null, sale.customer_id ?? null]
    ]
    for (const [field, expectedValue, actualValue] of checks) if (expectedValue !== actualValue) mismatches.push({ field, expected: expectedValue, actual: actualValue })
    if (Math.abs(Number(sale.total_amount) - expected.total) > 0.000001) mismatches.push({ field: 'sale.total_amount', expected: expected.total, actual: sale.total_amount })
    if (sale.original_total_amount != null && Math.abs(Number(sale.original_total_amount) - expected.originalTotal) > 0.000001) {
      mismatches.push({ field: 'sale.original_total_amount', expected: expected.originalTotal, actual: sale.original_total_amount })
    }
  }
  if (items.length !== expected.lines.length) mismatches.push({ field: 'saleItems.count', expected: expected.lines.length, actual: items.length })
  for (const expectedLine of expected.lines) {
    const matched = items.filter((row) => row.product_id === expectedLine.productId)
    if (matched.length !== 1) {
      mismatches.push({ field: `saleItems.${expectedLine.productId}.count`, expected: 1, actual: matched.length })
      continue
    }
    const actual = matched[0]
    const checks = [
      ['sale_id', saleId, actual.sale_id], ['product_id', expectedLine.productId, actual.product_id],
      ['workspace_id', workspace.id, actual.workspace_id], ['storage_id', expectedLine.storageId, actual.storage_id],
      ['quantity', expectedLine.quantity, Number(actual.quantity)], ['unit_price', expectedLine.effectiveSourceUnitPrice, Number(actual.unit_price)],
      ['total_price', expectedLine.sourceTotal, Number(actual.total_price)], ['original_currency', expectedLine.currency, actual.original_currency],
      ['original_unit_price', expectedLine.originalUnitPrice, Number(actual.original_unit_price)],
      ['converted_unit_price', expectedLine.convertedUnitPrice, Number(actual.converted_unit_price)],
      ['cost_price', expectedLine.expectedCostPrice, Number(actual.cost_price)],
      ['converted_cost_price', expectedLine.expectedConvertedCostPrice, Number(actual.converted_cost_price)],
      ['inventory_snapshot', expectedLine.inventorySnapshot ?? null, actual.inventory_snapshot == null ? null : Number(actual.inventory_snapshot)],
      ['unit_factor', 1, Number(actual.unit_factor ?? 1)],
      ['settlement_currency', expected.currency, actual.settlement_currency]
    ]
    for (const [field, expectedValue, actualValue] of checks) {
      const numeric = typeof expectedValue === 'number'
      if (numeric ? Math.abs(expectedValue - Number(actualValue)) > 0.000001 : expectedValue !== actualValue) {
        mismatches.push({ field: `saleItems.${expectedLine.productId}.${field}`, expected: expectedValue, actual: actualValue })
      }
    }
    if (expectedLine.negotiatedPrice === null ? actual.negotiated_price != null
      : Math.abs(Number(actual.negotiated_price) - expectedLine.negotiatedPrice) > 0.000001) {
      mismatches.push({ field: `saleItems.${expectedLine.productId}.negotiated_price`, expected: expectedLine.negotiatedPrice, actual: actual.negotiated_price })
    }
    if (expectedLine.customName) {
      const suffix = actual.metadata?.posServiceName?.suffix
      const name = actual.metadata?.posServiceName?.displayNameSnapshot
      if (suffix !== expectedLine.customName || name !== `${fixtures.get(expectedLine.productId).name} - ${expectedLine.customName}`) {
        mismatches.push({ field: `saleItems.${expectedLine.productId}.serviceNameSnapshot`, expected: expectedLine.customName, actual: actual.metadata?.posServiceName ?? null })
      }
    }
  }

  const paymentExpected = expected.total > 0 && expected.paymentMethod !== 'loan'
  if (paymentExpected) {
    if (paymentRows.length !== 1) mismatches.push({ field: 'paymentTransactions.count', expected: 1, actual: paymentRows.length })
    const payment = paymentRows[0]
    if (payment) {
      for (const [field, expectedValue, actualValue] of [
        ['workspace_id', workspace.id, payment.workspace_id], ['source_module', 'sales', payment.source_module],
        ['source_type', 'pos_sale', payment.source_type], ['source_record_id', saleId, payment.source_record_id],
        ['direction', 'incoming', payment.direction], ['currency', expected.currency, payment.currency],
        ['payment_method', expected.paymentMethod, payment.payment_method], ['account_id', expected.paymentAccountId, payment.account_id],
        ['account_name_snapshot', expected.paymentAccountId ? expected.paymentAccountName : null, payment.account_name_snapshot ?? null]
      ]) if (expectedValue !== actualValue) mismatches.push({ field: `payment.${field}`, expected: expectedValue, actual: actualValue })
      if (Math.abs(Number(payment.amount) - expected.total) > 0.000001) mismatches.push({ field: 'payment.amount', expected: expected.total, actual: payment.amount })
      if (expected.checkoutTimestamp && !sameInstant(payment.paid_at, expected.checkoutTimestamp)) {
        mismatches.push({ field: 'payment.paid_at', expected: expected.checkoutTimestamp, actual: payment.paid_at })
      }
    }
  } else if (paymentRows.length !== 0) {
    mismatches.push({ field: 'paymentTransactions.count', expected: 0, actual: paymentRows.length })
  }
  if (expected.paymentAccountId && paymentExpected) {
    if (accountMovements.length !== 1) mismatches.push({ field: 'paymentAccountMovements.count', expected: 1, actual: accountMovements.length })
    const movement = accountMovements[0]
    if (movement && (movement.direction !== 'incoming' || Math.abs(Number(movement.amount) - expected.total) > 0.000001
      || Math.abs(Number(movement.delta_amount) - expected.total) > 0.000001
      || movement.account_id !== expected.paymentAccountId || movement.currency !== expected.currency || movement.is_deleted)) {
      mismatches.push({ field: 'paymentAccountMovement', expected: { account_id: expected.paymentAccountId, direction: 'incoming', amount: expected.total, delta: expected.total, currency: expected.currency, is_deleted: false }, actual: movement })
    }
    const currencies = new Set([...baseline.accountBalances.map((row) => row.currency), ...accountBalances.map((row) => row.currency), expected.currency])
    for (const currency of currencies) {
      const beforeBalance = Number(baseline.accountBalances.find((row) => row.currency === currency)?.balance_amount ?? 0)
      const afterBalance = Number(accountBalances.find((row) => row.currency === currency)?.balance_amount ?? 0)
      const expectedBalance = beforeBalance + (currency === expected.currency ? expected.total : 0)
      if (Math.abs(afterBalance - expectedBalance) > 0.000001) mismatches.push({ field: `paymentAccountBalance.${currency}`, expected: expectedBalance, actual: afterBalance })
      const beforeRow = baseline.accountBalances.find((row) => row.currency === currency)
      const afterRow = accountBalances.find((row) => row.currency === currency)
      const expectedVersion = Number(beforeRow?.version ?? 0) + (currency === expected.currency ? 1 : 0)
      if (afterRow && Number(afterRow.version) !== expectedVersion) mismatches.push({ field: `paymentAccountBalance.${currency}.version`, expected: expectedVersion, actual: afterRow.version })
    }
  } else if (accountMovements.length !== 0) {
    mismatches.push({ field: 'paymentAccountMovements.count', expected: 0, actual: accountMovements.length })
  }
  if (!accountId) {
    const beforeBalances = new Map(baseline.accountBalances.map((row) => [`${row.account_id}:${row.currency}`, row]))
    const afterBalances = new Map(accountBalances.map((row) => [`${row.account_id}:${row.currency}`, row]))
    const allBalanceKeys = new Set([...beforeBalances.keys(), ...afterBalances.keys()])
    for (const key of allBalanceKeys) {
      const before = beforeBalances.get(key)
      const after = afterBalances.get(key)
      if (!before || !after || Number(before.balance_amount) !== Number(after.balance_amount)
        || Number(before.version ?? 0) !== Number(after.version ?? 0)) {
        mismatches.push({ field: `paymentAccountBalance.${key}`, expected: before ? { amount: before.balance_amount, version: before.version } : null, actual: after ? { amount: after.balance_amount, version: after.version } : null })
      }
    }
  }

  if (expected.paymentMethod === 'loan') {
    const loans = await queryChecked(supabase.from('loans').select('*')
      .eq('workspace_id', workspace.id).eq('sale_id', saleId).eq('source', 'pos'), 'Could not read the linked POS loan')
    if (loans.length !== 1) mismatches.push({ field: 'posLoans.count', expected: 1, actual: loans.length })
    else {
      const loan = loans[0]
      for (const [field, expectedValue, actualValue] of [
        ['sale_id', saleId, loan.sale_id], ['workspace_id', workspace.id, loan.workspace_id],
        ['created_by', user.id, loan.created_by], ['source', 'pos', loan.source],
        ['borrower_name', 'Atlas POS test borrower', loan.borrower_name],
        ['principal_amount', expected.total, Number(loan.principal_amount)],
        ['balance_amount', expected.total, Number(loan.balance_amount)],
        ['settlement_currency', expected.currency, loan.settlement_currency]
      ]) if (expectedValue !== actualValue) mismatches.push({ field: `posLoan.${field}`, expected: expectedValue, actual: actualValue })
      const installments = await queryChecked(supabase.from('loan_installments').select('*')
        .eq('workspace_id', workspace.id).eq('loan_id', loan.id), 'Could not read POS loan installments')
      if (installments.length !== 1 || Math.abs(Number(installments[0]?.planned_amount) - expected.total) > 0.000001
        || Math.abs(Number(installments[0]?.balance_amount) - expected.total) > 0.000001) {
        mismatches.push({ field: 'posLoan.installments', expected: { count: 1, planned: expected.total, balance: expected.total }, actual: installments })
      }
    }
  }

  const baselineInventoryByPosition = new Map(baseline.inventoryRows.map((row) => [`${row.product_id}:${row.storage_id}`, row]))
  const expectedInventoryPositions = new Map()
  for (const expectedLine of expected.lines) {
    if (!expectedLine.storageId) continue
    expectedInventoryPositions.set(`${expectedLine.productId}:${expectedLine.storageId}`, expectedLine.inventoryQuantity)
  }
  for (const before of baseline.inventoryRows) {
    const key = `${before.product_id}:${before.storage_id}`
    const sold = expectedInventoryPositions.get(key) ?? 0
    const after = inventoryAfter.find((row) => row.id === before.id)
    const expectedQuantity = Number(before.quantity) - sold
    if (!after || Math.abs(Number(after.quantity) - expectedQuantity) > 0.000001) {
      mismatches.push({ field: `inventory.${key}`, expected: expectedQuantity, actual: after?.quantity ?? null })
    } else {
      const expectedVersion = Number(before.version ?? 0) + (sold > 0 ? 1 : 0)
      if (Number(after.version ?? 0) !== expectedVersion) mismatches.push({ field: `inventory.${key}.version`, expected: expectedVersion, actual: after.version })
    }
  }
  for (const expectedLine of expected.lines) {
    if (!expectedLine.storageId) continue
    const before = baselineInventoryByPosition.get(`${expectedLine.productId}:${expectedLine.storageId}`)
    if (!before) mismatches.push({ field: `inventoryBaseline.${expectedLine.productId}.${expectedLine.storageId}`, expected: 'one baseline row', actual: null })
  }
  for (const fixture of fixtures.values()) {
    if (fixture.itemType === 'Service' && inventoryAfter.some((row) => row.product_id === fixture.id)) {
      mismatches.push({ field: `serviceInventory.${fixture.id}`, expected: 'no inventory rows', actual: inventoryAfter.filter((row) => row.product_id === fixture.id) })
    }
  }
  const baselineMovementIds = new Set(baseline.inventoryTransactions.map((row) => row.id))
  const newInventoryMovements = inventoryTransactionsAfter.filter((row) => !baselineMovementIds.has(row.id) && !row.is_deleted)
  const expectedMovementLines = expected.lines.filter((line) => line.storageId && line.inventoryQuantity > 0)
  if (newInventoryMovements.length !== expectedMovementLines.length) {
    mismatches.push({ field: 'inventoryTransactions.count', expected: expectedMovementLines.length, actual: newInventoryMovements.length, actualRows: newInventoryMovements })
  }
  const matchedMovementIds = new Set()
  for (const line of expectedMovementLines) {
    const movement = newInventoryMovements.filter((row) => row.product_id === line.productId && row.storage_id === line.storageId)
    if (movement.length !== 1) {
      mismatches.push({ field: `inventoryTransaction.${line.productId}.count`, expected: 1, actual: movement })
      continue
    }
    const actual = movement[0]
    matchedMovementIds.add(actual.id)
    const before = baselineInventoryByPosition.get(`${line.productId}:${line.storageId}`)
    const expectedFields = {
      workspace_id: workspace.id,
      quantity_delta: -line.inventoryQuantity,
      previous_quantity: Number(before?.quantity ?? 0),
      new_quantity: Number(before?.quantity ?? 0) - line.inventoryQuantity,
      transaction_type: 'sale',
      reference_id: saleId,
      reference_type: 'pos_sale',
      is_deleted: false
    }
    for (const [field, expectedValue] of Object.entries(expectedFields)) {
      const actualValue = ['quantity_delta', 'previous_quantity', 'new_quantity'].includes(field)
        ? Number(actual[field])
        : actual[field] ?? null
      if (actualValue !== expectedValue) {
        mismatches.push({ field: `inventoryTransaction.${line.productId}.${field}`, expected: expectedValue, actual: actualValue, row: actual })
      }
    }
  }
  const unexpectedMovements = newInventoryMovements.filter((row) => !matchedMovementIds.has(row.id))
  if (unexpectedMovements.length) mismatches.push({ field: 'inventoryTransactions.unexpectedRows', expected: [], actual: unexpectedMovements })
  if (exchangeRows.length !== expected.exchangeRows.length) mismatches.push({ field: 'sales_exchange.count', expected: expected.exchangeRows.length, actual: exchangeRows.length })
  for (const expectedExchange of expected.exchangeRows) {
    const actual = exchangeRows.find((row) => row.base_currency === expectedExchange.base_currency && row.quote_currency === expectedExchange.quote_currency)
    if (!actual || Number(actual.base_amount) !== Number(expectedExchange.base_amount)
      || Number(actual.quote_amount) !== Number(expectedExchange.quote_amount)
      || actual.source !== expectedExchange.source || actual.rate_side !== (expectedExchange.rate_side ?? 'mid')
      || (expectedExchange.source_price_id ?? null) !== (actual.source_price_id ?? null)
      || (expectedExchange.source_price_updated_at ?? null) !== (actual.source_price_updated_at ?? null)) {
      mismatches.push({ field: `sales_exchange.${expectedExchange.base_currency}_${expectedExchange.quote_currency}`, expected: expectedExchange, actual: actual ?? null })
    }
  }

  if (baseline.accountRows.length) {
    const accountId = baseline.accountRows[0].id
    const accountAfter = await queryChecked(supabase.schema('payment_accounts').from('accounts').select('*')
      .eq('workspace_id', workspace.id).eq('id', accountId), 'Could not read post-checkout payment-account state')
    const before = baseline.accountRows[0]
    const after = accountAfter[0]
    if (!after || ['name', 'account_type', 'is_active', 'is_deleted', 'version'].some((field) => after[field] !== before[field])) {
      mismatches.push({ field: 'paymentAccount.entityState', expected: before, actual: after ?? null })
    }
  }

  const currentBatchRows = batchesAfter
  for (const before of baseline.batchRows) {
    const after = currentBatchRows.find((row) => row.id === before.id)
    if (!after || Number(after.quantity) !== Number(before.quantity)) mismatches.push({ field: `stockBatch.${before.id}.quantity`, expected: before.quantity, actual: after?.quantity ?? null })
  }
  const baselineBatchIds = new Set(baseline.batchRows.map((row) => row.id))
  const unexpectedBatches = currentBatchRows.filter((row) => !baselineBatchIds.has(row.id))
  if (unexpectedBatches.length) mismatches.push({ field: 'stockBatch.unexpectedRows', expected: [], actual: unexpectedBatches })

  return {
    passed: mismatches.length === 0,
    sale,
    items,
    paymentRows,
    inventoryAfter,
    batchesAfter,
    inventoryTransactionsAfter,
    exchangeRows,
    accountMovements,
    accountBalances,
    mismatches,
    baseline
  }
}

async function cleanupScenarioSingle(context, fixtures, scenario, saleId, baseline, { finalizeState = true, verifySaleMovements = true } = {}) {
  const { supabase, workspace, user } = context
  const report = { attempted: true, completed: false, retainedAuditRows: [], errors: [], verification: null }
  let inventoryRowsAfterCleanup = null
  const productIds = [...new Set([...(scenario.items ?? []).map((item) => item.fixtureId), ...(scenario.productIds ?? [])])]
  if (saleId) {
    const saleResult = await supabase.from('sales').select('id,workspace_id,cashier_id,origin,payment_method,is_archived,return_status,total_amount,original_total_amount,returned_amount')
      .eq('id', saleId).eq('workspace_id', workspace.id).maybeSingle()
    if (saleResult.error) report.errors.push(`Could not verify sale ownership: ${saleResult.error.message}`)
    else if (saleResult.data) {
      const sale = saleResult.data
      const originalSaleAmount = Number(sale.original_total_amount ?? (Number(sale.total_amount ?? 0) + Number(sale.returned_amount ?? 0)))
      report.expectedFullReturnAmount = originalSaleAmount
      const itemsResult = await supabase.from('sale_items').select('id,workspace_id,product_id,sale_id,quantity,returned_quantity')
        .eq('workspace_id', workspace.id).eq('sale_id', saleId)
      const ownItems = itemsResult.data ?? []
      const canProveOwnership = sale.workspace_id === workspace.id && sale.cashier_id === user.id
        && sale.origin === 'pos' && !itemsResult.error
        && ownItems.every((item) => fixtures.has(item.product_id))
      if (!canProveOwnership) {
        report.errors.push('Cleanup stopped because sale ownership could not be proven from workspace, cashier, origin, and test-owned product links.')
      } else {
        const unreturnedItems = ownItems.filter((item) => Number(item.quantity) - Number(item.returned_quantity ?? 0) > 0)
        if (sale.return_status !== 'full' && unreturnedItems.length > 0) {
          const returnId = randomUUID()
          // Cleanup always returns every remaining line in one operation. For
          // a full POS loan return, process_sale_return owns the cancellation
          // trigger. The loan-aware wrapper is an invoker function that reads
          // a private aggregate without an execute grant on some deployments;
          // using the base full-return RPC retains the database cancellation
          // and refund triggers without depending on that wrapper.
          const returned = await supabase.rpc('process_sale_return', {
            p_return_id: returnId,
            p_sale_id: saleId,
            p_items: unreturnedItems.map((item) => ({ id: randomUUID(), sale_item_id: item.id, quantity: Number(item.quantity) - Number(item.returned_quantity ?? 0) })),
            p_return_reason: `Cloud/Hybrid Playwright cleanup ${scenario.id}`,
            p_refund_method: null
          })
          if (returned.error || returned.data?.success !== true) {
            report.errors.push(`Could not return the complete test-owned sale during cleanup: ${returned.error?.message ?? 'the return was not confirmed'}`)
          } else {
            report.returnId = returnId
            report.retainedAuditRows.push(`sale_returns:${returnId}:full-return`)
          }
        }

        if (!report.errors.length && sale.payment_method !== 'loan') {
          const paymentResult = await supabase.from('payment_transactions').select('*')
            .eq('id', saleId).eq('workspace_id', workspace.id).eq('source_type', 'pos_sale')
            .eq('source_record_id', saleId).maybeSingle()
          if (paymentResult.error) report.errors.push(`Could not verify payment ownership: ${paymentResult.error.message}`)
          else if (paymentResult.data && !paymentResult.data.is_deleted) {
            const payment = paymentResult.data
            const reversalResult = await supabase.from('payment_transactions').select('id,amount,reversal_of_transaction_id,is_deleted')
              .eq('workspace_id', workspace.id).eq('reversal_of_transaction_id', payment.id)
              .eq('is_deleted', false)
            if (reversalResult.error) report.errors.push(`Could not inspect payment reversals: ${reversalResult.error.message}`)
            else {
              const reversedAmount = (reversalResult.data ?? []).reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0)
              const remaining = Number(payment.amount) + reversedAmount
              if (remaining < -0.000001) {
                report.errors.push(`Existing counter-entries over-reverse test payment ${payment.id}.`)
              } else if (remaining > 0.000001) {
              const reversalId = randomUUID()
              const reversal = await supabase.from('payment_transactions').insert({
                id: reversalId,
                workspace_id: payment.workspace_id,
                source_module: payment.source_module,
                source_type: payment.source_type,
                source_record_id: payment.source_record_id,
                source_subrecord_id: payment.source_subrecord_id,
                direction: payment.direction,
                amount: -remaining,
                currency: payment.currency,
                payment_method: payment.payment_method,
                paid_at: new Date().toISOString(),
                counterparty_name: payment.counterparty_name,
                reference_label: payment.reference_label,
                note: `Cloud/Hybrid Playwright cleanup reversal ${scenario.id}`,
                created_by: user.id,
                reversal_of_transaction_id: payment.id,
                metadata: { ...(payment.metadata ?? {}), reversal: true, cloudHybridPlaywrightRun: scenario.runId ?? null },
                account_id: payment.account_id,
                account_name_snapshot: payment.account_name_snapshot
              }).select('id').maybeSingle()
              if (reversal.error || !reversal.data) report.errors.push(`Could not post the linked cleanup counter-entry: ${reversal.error?.message ?? 'no row returned'}`)
              else {
                report.reversalId = reversalId
                report.retainedAuditRows.push(`payment_transactions:${payment.id}:original`)
                report.retainedAuditRows.push(`payment_transactions:${reversalId}:counter-entry`)
              }
              }
            }
          }
        }

        if (!report.errors.length) {
          const archived = await supabase.from('sales').update({ is_archived: true })
            .eq('id', saleId).eq('workspace_id', workspace.id).eq('cashier_id', user.id).select('id').maybeSingle()
          if (archived.error || !archived.data) report.errors.push(`Could not archive the test-owned sale: ${archived.error?.message ?? 'no row returned'}`)
          else report.retainedAuditRows.push(`sales:${saleId}:archived`)
        }
      }
    }
  }

  if (finalizeState) {
  // The POS return RPC normally restores these values. If an interrupted
  // failure left a difference, restore only rows whose IDs/product/storage
  // all match this runner's captured test-owned baseline.
  for (const before of baseline.inventoryRows) {
    const current = await supabase.from('inventory').select('id,quantity')
      .eq('id', before.id).eq('workspace_id', workspace.id).eq('product_id', before.product_id).eq('storage_id', before.storage_id).maybeSingle()
    if (current.error) report.errors.push(`Could not inspect test-owned inventory row ${before.id}: ${current.error.message}`)
    else if (current.data && Math.abs(Number(current.data.quantity) - Number(before.quantity)) > 0.000001) {
      const restore = await supabase.from('inventory').update({ quantity: before.quantity })
        .eq('id', before.id).eq('workspace_id', workspace.id).eq('product_id', before.product_id).eq('storage_id', before.storage_id).select('id').maybeSingle()
      if (restore.error || !restore.data) report.errors.push(`Could not restore test-owned inventory row ${before.id}: ${restore.error?.message ?? 'no row returned'}`)
    }
  }
  for (const before of baseline.batchRows) {
    const current = await supabase.from('stock_batches').select('id,quantity')
      .eq('id', before.id).eq('workspace_id', workspace.id).eq('product_id', before.product_id).eq('storage_id', before.storage_id).maybeSingle()
    if (current.error) report.errors.push(`Could not inspect test-owned batch ${before.id}: ${current.error.message}`)
    else if (current.data && Math.abs(Number(current.data.quantity) - Number(before.quantity)) > 0.000001) {
      const restore = await supabase.from('stock_batches').update({ quantity: before.quantity })
        .eq('id', before.id).eq('workspace_id', workspace.id).eq('product_id', before.product_id).eq('storage_id', before.storage_id).select('id').maybeSingle()
      if (restore.error || !restore.data) report.errors.push(`Could not restore test-owned batch ${before.id}: ${restore.error?.message ?? 'no row returned'}`)
    }
  }
  for (const before of baseline.productRows) {
    if (!fixtures.has(before.id)) continue
    const current = await supabase.from('products').select('id,quantity,is_deleted,created_by,description')
      .eq('id', before.id).eq('workspace_id', workspace.id).maybeSingle()
    if (current.error) report.errors.push(`Could not inspect test-owned product ${before.id}: ${current.error.message}`)
    else if (current.data?.created_by === user.id && String(current.data.description).startsWith(`${TEST_MARKER}:`)
      && (Number(current.data.quantity) !== Number(before.quantity) || current.data.is_deleted !== before.is_deleted)) {
      const restore = await supabase.from('products').update({ quantity: before.quantity, is_deleted: before.is_deleted })
        .eq('id', before.id).eq('workspace_id', workspace.id).eq('created_by', user.id).select('id').maybeSingle()
      if (restore.error || !restore.data) report.errors.push(`Could not restore test-owned product ${before.id}: ${restore.error?.message ?? 'no row returned'}`)
    }
  }
  const inventoryResult = await supabase.from('inventory').select('id,product_id,storage_id,quantity')
    .eq('workspace_id', workspace.id).in('product_id', productIds)
  inventoryRowsAfterCleanup = inventoryResult.data ?? null
  if (inventoryResult.error) report.errors.push(`Could not verify inventory cleanup: ${inventoryResult.error.message}`)
  else {
    for (const before of baseline.inventoryRows) {
      const after = (inventoryResult.data ?? []).find((row) => row.id === before.id)
      if (!after || Math.abs(Number(after.quantity) - Number(before.quantity)) > 0.000001) {
        report.errors.push(`Inventory cleanup mismatch for ${before.product_id} in storage ${before.storage_id}.`)
      }
    }
  }
  const productCleanup = await supabase.from('products').select('id,quantity,is_deleted')
    .eq('workspace_id', workspace.id).in('id', productIds)
  if (productCleanup.error) report.errors.push(`Could not verify product cleanup: ${productCleanup.error.message}`)
  else for (const before of baseline.productRows) {
    const after = productCleanup.data?.find((row) => row.id === before.id)
    if (!after || Number(after.quantity) !== Number(before.quantity) || after.is_deleted !== before.is_deleted) {
      report.errors.push(`Product cleanup mismatch for ${before.id}.`)
    }
  }
  const movementCleanup = await supabase.from('inventory_transactions')
    .select('id,workspace_id,product_id,storage_id,transaction_type,quantity_delta,previous_quantity,new_quantity,reference_id,reference_type,is_deleted')
    .eq('workspace_id', workspace.id).in('product_id', productIds)
  if (movementCleanup.error) report.errors.push(`Could not verify retained inventory audit rows: ${movementCleanup.error.message}`)
  else {
    const baselineMovementIds = new Set(baseline.inventoryTransactions.map((row) => row.id))
    const newMovementRows = (movementCleanup.data ?? []).filter((row) => !baselineMovementIds.has(row.id) && !row.is_deleted)
    const netByPosition = new Map()
    for (const movement of newMovementRows) {
      const key = `${movement.product_id}:${movement.storage_id}`
      netByPosition.set(key, (netByPosition.get(key) ?? 0) + Number(movement.quantity_delta))
    }
    for (const before of baseline.inventoryRows) {
      const key = `${before.product_id}:${before.storage_id}`
      if (Math.abs(netByPosition.get(key) ?? 0) > 0.000001) {
        report.errors.push(`Inventory movement audit rows did not return to the baseline for ${key}: net ${netByPosition.get(key)}.`)
      }
    }
    if (saleId && verifySaleMovements) {
      const expectedLines = new Map()
      for (const item of scenario.items ?? []) {
        const fixture = fixtures.get(item.fixtureId)
        if (!fixture || fixture.itemType !== 'Product' || !fixture.storageId) continue
        const key = `${fixture.id}:${fixture.storageId}`
        expectedLines.set(key, (expectedLines.get(key) ?? 0) + Number(item.quantity ?? 0))
      }
      for (const [key, quantity] of expectedLines) {
        const rows = newMovementRows.filter((row) => `${row.product_id}:${row.storage_id}` === key)
        const saleMovements = rows.filter((row) => row.transaction_type === 'sale' && row.reference_id === saleId)
        const returnMovements = rows.filter((row) => row.transaction_type === 'return' && row.reference_id === report.returnId)
        const baselineRow = baseline.inventoryRows.find((row) => `${row.product_id}:${row.storage_id}` === key)
        const sale = saleMovements[0]
        const returned = returnMovements[0]
        const expectedRollback = saleMovements.length === 1 && returnMovements.length === 1
          && !!baselineRow
          && Number(sale.quantity_delta) < 0
          && Math.abs(Number(returned.quantity_delta) + Number(sale.quantity_delta)) <= 0.000001
          && Math.abs(Number(sale.previous_quantity) - Number(baselineRow.quantity)) <= 0.000001
          && Math.abs(Number(returned.previous_quantity) - Number(sale.new_quantity)) <= 0.000001
          && Math.abs(Number(returned.new_quantity) - Number(baselineRow.quantity)) <= 0.000001
        if (rows.length !== 2 || !expectedRollback) {
          report.errors.push(`Cleanup inventory history for ${key} must retain one sale movement and one exactly matching return to the captured baseline (scenario quantity ${quantity}); actual ${JSON.stringify(rows)}.`)
        }
      }
    }
    report.retainedAuditRows.push(...newMovementRows.map((row) => `inventory_transactions:${row.id}:${row.transaction_type}`))
    report.verification = { ...(report.verification ?? {}), inventoryMovementRows: newMovementRows, inventoryMovementNet: Object.fromEntries(netByPosition) }
  }
  if (scenario.account?.id) {
    const balances = await supabase.schema('payment_accounts').from('account_balances').select('currency,balance_amount')
      .eq('workspace_id', workspace.id).eq('account_id', scenario.account.id)
    if (balances.error) report.errors.push(`Could not verify account cleanup: ${balances.error.message}`)
    else for (const before of baseline.accountBalances) {
      const after = balances.data?.find((row) => row.currency === before.currency)
      if (Math.abs(Number(after?.balance_amount ?? 0) - Number(before.balance_amount)) > 0.000001) {
        report.errors.push(`Payment-account balance cleanup mismatch for account ${scenario.account.id}, currency ${before.currency}.`)
      }
    }
    const movementRows = await supabase.schema('payment_accounts').from('account_movements')
      .select('id,payment_transaction_id,direction,amount,delta_amount,currency,is_deleted')
      .eq('workspace_id', workspace.id).eq('account_id', scenario.account.id)
    if (movementRows.error) report.errors.push(`Could not verify account-movement cleanup: ${movementRows.error.message}`)
    else if (saleId) {
      const related = (movementRows.data ?? []).filter((row) => row.payment_transaction_id === saleId || row.payment_transaction_id === report.reversalId)
      const net = related.reduce((sum, row) => sum + Number(row.delta_amount ?? 0), 0)
      if (Math.abs(net) > 0.000001) report.errors.push(`Payment-account counter-entry cleanup did not net to zero (actual ${net}).`)
    }
  }
  }
  if (saleId) {
    const saleCheck = await supabase.from('sales').select('id,is_archived,return_status,total_amount,original_total_amount,returned_amount')
      .eq('id', saleId).eq('workspace_id', workspace.id).maybeSingle()
    if (saleCheck.error) report.errors.push(`Could not verify returned sale cleanup: ${saleCheck.error.message}`)
    else if (saleCheck.data) {
      const expectedReturn = report.expectedFullReturnAmount
        ?? Number(saleCheck.data.original_total_amount ?? (Number(saleCheck.data.total_amount ?? 0) + Number(saleCheck.data.returned_amount ?? 0)))
      const returned = Number(saleCheck.data.returned_amount ?? 0)
      const remaining = Number(saleCheck.data.total_amount ?? 0)
      if (!saleCheck.data.is_archived || saleCheck.data.return_status !== 'full'
          || Math.abs(returned - expectedReturn) > 0.000001 || Math.abs(remaining) > 0.000001
          || Math.abs(Number(saleCheck.data.original_total_amount ?? expectedReturn) - expectedReturn) > 0.000001) {
        report.errors.push(`Sale cleanup did not fully archive/return the test sale to its original gross amount ${expectedReturn}: ${JSON.stringify(saleCheck.data)}`)
      }
      report.expectedFullReturnAmount = expectedReturn
    }
    if (scenario.payment?.id === 'loan') {
      const loanRows = await supabase.from('loans').select('id,status,is_deleted,principal_amount,balance_amount')
        .eq('workspace_id', workspace.id).eq('sale_id', saleId).eq('source', 'pos')
      if (loanRows.error) report.errors.push(`Could not verify POS loan cleanup: ${loanRows.error.message}`)
      else if (loanRows.data?.length !== 1 || loanRows.data.some((row) => !row.is_deleted && row.status !== 'cancelled')) {
        report.errors.push(`The POS loan remains active after the full sale return: ${JSON.stringify(loanRows.data)}`)
      } else report.retainedAuditRows.push(`loans:${loanRows.data[0].id}:cancelled`)
    }
    if (saleCheck.data) report.retainedAuditRows.push(`sales:${saleId}:verified`)
    const linkedPayments = await supabase.from('payment_transactions').select('id,account_id,amount,reversal_of_transaction_id,source_type,is_deleted')
      .eq('workspace_id', workspace.id).eq('source_record_id', saleId)
    if (linkedPayments.error) report.errors.push(`Could not verify payment/counter-entry cleanup: ${linkedPayments.error.message}`)
    else {
      const originals = (linkedPayments.data ?? []).filter((row) => row.source_type === 'pos_sale' && !row.reversal_of_transaction_id && !row.is_deleted)
      if (saleCheck.data && saleCheck.data.return_status === 'full' && scenario.payment?.id !== 'loan') {
        if (originals.length !== 1) report.errors.push(`Expected one retained original POS payment after cleanup; found ${originals.length}.`)
        else {
          const original = originals[0]
          const reversals = (linkedPayments.data ?? []).filter((row) => row.reversal_of_transaction_id === original.id && !row.is_deleted)
          const net = Number(original.amount) + reversals.reduce((sum, row) => sum + Number(row.amount), 0)
          if (Math.abs(net) > 0.000001) report.errors.push(`POS payment and its linked counter-entries do not net to zero (actual ${net}).`)
          if (original.account_id !== (scenario.account?.id ?? null)) report.errors.push(`Retained POS payment account differs from the expected selection: expected ${scenario.account?.id ?? null}, actual ${original.account_id ?? null}.`)
          const paymentIds = [original.id, ...reversals.map((row) => row.id)]
          const movements = await supabase.schema('payment_accounts').from('account_movements').select('payment_transaction_id,delta_amount,is_deleted')
            .eq('workspace_id', workspace.id).in('payment_transaction_id', paymentIds)
          if (movements.error) report.errors.push(`Could not verify linked account movements after cleanup: ${movements.error.message}`)
          else {
            const activeMovements = movements.data ?? []
            const movementNet = activeMovements.filter((row) => !row.is_deleted).reduce((sum, row) => sum + Number(row.delta_amount), 0)
            const expectedMovementCount = original.account_id ? paymentIds.length : 0
            if (activeMovements.filter((row) => !row.is_deleted).length !== expectedMovementCount || Math.abs(movementNet) > 0.000001) {
              report.errors.push(`Payment-account movements did not return to baseline: expected ${expectedMovementCount} rows net 0, actual ${JSON.stringify(activeMovements)}.`)
            }
          }
        }
      } else if (saleCheck.data && scenario.payment?.id === 'loan' && originals.length) {
        report.errors.push(`A POS loan created an unexpected cash payment transaction: ${JSON.stringify(originals)}`)
      }
    }
  }
  report.verification = { inventoryRows: inventoryRowsAfterCleanup, accountBalancesRestored: report.errors.length === 0 }
  report.completed = report.errors.length === 0
  return report
}

export async function cleanupScenario(context, fixtures, scenario, saleIdOrIds, baseline) {
  const saleIds = [...new Set((Array.isArray(saleIdOrIds) ? saleIdOrIds : [saleIdOrIds]).filter(Boolean))]
  if (!saleIds.length) return cleanupScenarioSingle(context, fixtures, scenario, null, baseline)

  const sales = []
  for (let index = 0; index < saleIds.length; index += 1) {
    sales.push(await cleanupScenarioSingle(context, fixtures, scenario, saleIds[index], baseline, {
      finalizeState: index === saleIds.length - 1,
      verifySaleMovements: saleIds.length === 1
    }))
  }
  const errors = sales.flatMap((result) => result.errors ?? [])
  const finalState = sales.at(-1)
  return {
    attempted: true,
    completed: errors.length === 0 && !!finalState?.completed,
    sales,
    retainedAuditRows: [...new Set(sales.flatMap((result) => result.retainedAuditRows ?? []))],
    errors,
    verification: finalState?.verification ?? null
  }
}

export async function cleanupOwnedFixtures(context, setup) {
  const { supabase, workspace, user } = context
  const errors = []
  const fixtureIds = [...new Set(setup.productIds ?? [])]
  const batches = []
  for (let index = 0; index < fixtureIds.length; index += 100) batches.push(fixtureIds.slice(index, index + 100))
  for (const ids of batches) {
    const verified = await supabase.from('products').select('id,workspace_id,created_by,description')
      .eq('workspace_id', workspace.id).in('id', ids)
    if (verified.error) { errors.push(`Could not prove fixture ownership for a ${ids.length}-record batch: ${verified.error.message}`); continue }
    const owned = (verified.data ?? []).filter((row) => row.created_by === user.id
      && String(row.description).startsWith(`${TEST_MARKER}:${setup.runId}`))
    if (owned.length !== ids.length) {
      errors.push(`A fixture batch was retained because ownership could not be proven for every requested record (${owned.length}/${ids.length}).`)
      continue
    }
    const ownedIds = owned.map((row) => row.id)
    const inventory = await supabase.from('inventory').delete().eq('workspace_id', workspace.id).in('product_id', ownedIds).select('id')
    if (inventory.error) {
      const retiredInventory = await supabase.from('inventory').update({ is_deleted: true, quantity: 0 })
        .eq('workspace_id', workspace.id).in('product_id', ownedIds).select('id,is_deleted,quantity')
      if (retiredInventory.error) errors.push(`Could not remove or retire test-owned inventory batch: ${retiredInventory.error.message}`)
      else if ((retiredInventory.data ?? []).some((row) => !row.is_deleted || Number(row.quantity) !== 0)) {
        errors.push('Test-owned inventory batch did not verify as deleted with zero quantity.')
      }
    }
    const batchRows = await supabase.from('stock_batches').select('id')
      .eq('workspace_id', workspace.id).in('product_id', ownedIds)
    if (batchRows.error) errors.push(`Could not inspect test-owned stock-batch rows: ${batchRows.error.message}`)
    else for (const batchIds of chunks((batchRows.data ?? []).map((row) => row.id))) {
      const removedBatches = await supabase.from('stock_batches').delete()
        .eq('workspace_id', workspace.id).in('id', batchIds).select('id')
      if (removedBatches.error) errors.push(`Could not remove test-owned stock-batch rows: ${removedBatches.error.message}`)
    }
    const product = await supabase.from('products').delete().eq('workspace_id', workspace.id)
      .eq('created_by', user.id).like('description', `${TEST_MARKER}:${setup.runId}`).in('id', ownedIds).select('id')
    if (product.error) {
      const retired = await supabase.from('products').update({ is_deleted: true })
        .eq('workspace_id', workspace.id).eq('created_by', user.id)
        .like('description', `${TEST_MARKER}:${setup.runId}`).in('id', ownedIds).select('id,is_deleted')
      if (retired.error || (retired.data ?? []).length !== ownedIds.length || retired.data.some((row) => !row.is_deleted)) {
        errors.push(`Could not remove or retire a test-owned catalog batch: ${retired.error?.message ?? product.error.message}`)
      }
    }
  }
  for (const ids of batches) {
    const finalFixtures = await supabase.from('products').select('id,is_deleted,created_by,description')
      .eq('workspace_id', workspace.id).in('id', ids)
    if (finalFixtures.error) errors.push(`Could not verify final catalog-fixture cleanup: ${finalFixtures.error.message}`)
    else for (const row of finalFixtures.data ?? []) {
      if (row.created_by !== user.id || !String(row.description).startsWith(`${TEST_MARKER}:${setup.runId}`) || !row.is_deleted) {
        errors.push(`A test-created fixture remains active or has unexpected ownership: ${row.id}.`)
      }
    }
    const remainingInventory = await supabase.from('inventory').select('id,is_deleted,quantity')
      .eq('workspace_id', workspace.id).in('product_id', ids)
    if (remainingInventory.error) errors.push(`Could not verify inventory cleanup: ${remainingInventory.error.message}`)
    else if ((remainingInventory.data ?? []).some((row) => !row.is_deleted || Number(row.quantity) !== 0)) {
      errors.push('Test-owned inventory remains active or has a nonzero quantity after cleanup.')
    }
  }
  ownedFixtureJournal.delete(setup.runId)
  return { completed: errors.length === 0, errors }
}

export async function cleanupPartialOwnedFixtures(context, runId) {
  const productIds = ownedFixtureJournal.get(runId) ?? []
  if (!productIds.length) {
    ownedFixtureJournal.delete(runId)
    return { completed: true, errors: [], partialFixtureIds: [] }
  }
  const result = await cleanupOwnedFixtures(context, { runId, productIds })
  return { ...result, partialFixtureIds: productIds }
}

export async function disposeLiveContext(context) {
  await context?.supabase?.auth?.signOut().catch(() => {})
}
