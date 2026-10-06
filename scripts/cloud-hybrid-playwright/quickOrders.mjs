import { createHash, randomUUID } from 'node:crypto'

const MARKER = 'atlas-cloud-hybrid-playwright:quick-order'
const AMOUNT_EPSILON = 0.001
const QUANTITY_EPSILON = 0.000001

function failIfError(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data ?? []
}

async function visibleBusinessPartners(context) {
  return failIfError(await context.supabase.schema('crm').rpc('list_visible_business_partners', {
    p_workspace_id: context.workspace.id
  }), 'Could not read the workspace-scoped business-partner directory')
}

async function visibleCustomers(context) {
  return failIfError(await context.supabase.schema('crm').rpc('list_visible_customers', {
    p_workspace_id: context.workspace.id
  }), 'Could not read the workspace-scoped customer directory')
}

async function syncPartnerEntity(context, entity, operation = 'upsert') {
  const table = entity.customerFacet ? 'customers' : 'business_partners'
  const functionName = table === 'customers' ? 'sync_customer' : 'sync_business_partner'
  const { customerFacet: _customerFacet, ...payload } = entity
  const result = await context.supabase.schema('crm').rpc(functionName, {
    p_operation: operation,
    p_entity_id: entity.id,
    p_workspace_id: context.workspace.id,
    p_payload: operation === 'soft_delete' ? { id: entity.id } : payload
  })
  if (result.error) throw new Error(`Could not ${operation === 'upsert' ? 'save' : 'retire'} the owned ${table} record: ${result.error.message}`)
  return result.data
}

function closeAmount(left, right, epsilon = AMOUNT_EPSILON) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= epsilon
}

function value(row, camel, snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)) {
  return row?.[snake] ?? row?.[camel] ?? null
}

function accountBalancesFor(rows, accountIds, currency) {
  return (rows ?? []).filter((row) => accountIds.includes(row.account_id)
    && String(row.currency).toLowerCase() === String(currency).toLowerCase())
}

function mutationDiff(beforeRows, afterRows) {
  const beforeIds = new Set((beforeRows ?? []).map((row) => row.id))
  return (afterRows ?? []).filter((row) => !beforeIds.has(row.id))
}

function quickOrderCustomerOwnership(runId, scenarioId = null) {
  const identity = `${runId}:${scenarioId ?? 'discovery'}`
  const compactId = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  const suffix = String(BigInt(`0x${compactId}`) % 10_000_000_000n).padStart(10, '0')
  const scenarioLabel = scenarioId
    ? ` ${scenarioId.replace(/^quick-order-/, '').replace(/[^a-z0-9-]/gi, '-').slice(0, 28)}`
    : ''
  const marker = `${MARKER}:${runId}:${scenarioId ?? 'discovery'}`
  return {
    name: `CHPW ${runId.slice(0, 8)}${scenarioLabel} Quick Order Customer`,
    phone: `+964${suffix}`,
    address: `Cloud Hybrid Playwright owned customer ${runId}`,
    marker
  }
}

export async function prepareQuickOrderCustomer(context, runId, driver, fixture, storage, scenarioId = null) {
  const { workspace, user } = context
  const ownership = quickOrderCustomerOwnership(runId, scenarioId)
  const [partnersBefore, customersBefore] = await Promise.all([visibleBusinessPartners(context), visibleCustomers(context)])
  if (partnersBefore.some((row) => row.partner_name === ownership.name || row.phone === ownership.phone)
    || customersBefore.some((row) => row.partner_name === ownership.name || row.phone === ownership.phone)) {
    throw new Error('The unique Quick Order customer identity already exists before this run; refusing to reuse it.')
  }

  const discovery = await driver.prepareQuickOrderDiscovery(fixture, storage.id, ownership)
  let partner
  let customerFacet
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [partners, customers] = await Promise.all([visibleBusinessPartners(context), visibleCustomers(context)])
    const matchingPartners = partners.filter((row) => row.partner_name === ownership.name
      && row.phone === ownership.phone && row.address === ownership.address
      && row.workspace_id === workspace.id && row.role === 'customer')
    if (matchingPartners.length > 1) throw new Error('Quick Order customer creation produced duplicate workspace partner rows.')
    partner = matchingPartners[0]
    if (partner?.customer_facet_id) customerFacet = customers.find((row) => row.id === partner.customer_facet_id)
    if (partner && customerFacet?.business_partner_id === partner.id) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!partner || !customerFacet || customerFacet.business_partner_id !== partner.id
    || customerFacet.workspace_id !== workspace.id || customerFacet.partner_name !== ownership.name
    || customerFacet.phone !== ownership.phone || customerFacet.address !== ownership.address) {
    throw new Error('The customer created in Quick Order did not appear as a correctly linked workspace-scoped customer in Supabase.')
  }

  const [verifiedPartners, verifiedCustomers] = await Promise.all([visibleBusinessPartners(context), visibleCustomers(context)])
  partner = verifiedPartners.find((row) => row.id === partner.id)
  customerFacet = verifiedCustomers.find((row) => row.id === customerFacet.id)
  if (!partner || !customerFacet
    || partner.workspace_id !== workspace.id || partner.role !== 'customer'
    || partner.partner_name !== ownership.name || partner.phone !== ownership.phone || partner.address !== ownership.address
    || customerFacet.workspace_id !== workspace.id || customerFacet.partner_name !== ownership.name
    || customerFacet.phone !== ownership.phone || customerFacet.address !== ownership.address
    || partner.customer_facet_id !== customerFacet.id || customerFacet.business_partner_id !== partner.id) {
    throw new Error('The Quick Order customer identity or workspace-scoped customer relationship failed Supabase verification.')
  }
  return {
    id: partner.id,
    facetId: customerFacet.id,
    name: ownership.name,
    phone: ownership.phone,
    address: ownership.address,
    // Kept only as a transaction cleanup reference. Ownership is proven from
    // the unique workspace/name/phone/address tuple, not a remote marker write.
    marker: ownership.marker,
    createdAt: partner.created_at,
    createdBy: user.id,
    workspaceId: workspace.id,
    currency: String(workspace.default_currency ?? 'usd').toLowerCase(),
    baseline: { partner, customer: customerFacet },
    discovery
  }
}

export function buildQuickOrderScenarioMatrix({ source, fixture, paymentMethods, paymentAccounts, cashPaymentAccounts = paymentAccounts, customer }) {
  const methodById = new Map((paymentMethods ?? []).map((method) => [method.id, method]))
  const cash = methodById.get('cash')
  if (!cash) throw new Error('Quick Order payment-method discovery did not expose Cash.')
  const selectedDigital = (paymentMethods ?? []).find((method) => method.ui === 'digital') ?? null
  const bankTransfer = methodById.get('bank_transfer') ?? null
  const loan = methodById.get('loan') ?? null
  const installments = methodById.get('installments') ?? null
  const accounts = paymentAccounts ?? []
  const cashDrawer = (cashPaymentAccounts ?? []).find((account) => account.accountType === 'cash_drawer') ?? null
  const anyAccount = accounts[0] ?? null
  const due = new Date()
  due.setDate(due.getDate() + 14)
  const firstDueDate = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
  const cases = []

  const add = (id, method, status, paymentStatus, account, fields = {}) => {
    if (!method) return
    const accountName = account?.name ?? 'No Account'
    const paymentStatusLabel = paymentStatus === 'partial' ? 'Partially Paid' : paymentStatus === 'paid' ? 'Paid' : 'Unpaid'
    const terms = []
    if (Number(fields.initialPaymentAmount ?? 0) > 0) terms.push(`Initial Payment ${fields.initialPaymentAmount} ${fixture.currency.toUpperCase()}`)
    if (method.id === 'installments') terms.push(`${fields.installmentCount ?? 3} × ${fields.installmentFrequency ?? 'monthly'}`)
    if (fields.firstDueDate) terms.push(`First Due ${fields.firstDueDate}`)
    cases.push({
      id: `quick-order-${id}`,
      domain: 'quick-order',
      source,
      fixtureId: fixture.id,
      customer,
      method: { id: method.id, label: method.label },
      orderStatus: status,
      paymentStatus,
      account: account ? { id: account.id, name: account.name, accountType: account.accountType } : null,
      initialPaymentAmount: fields.initialPaymentAmount ?? 0,
      installmentCount: fields.installmentCount ?? 3,
      installmentFrequency: fields.installmentFrequency ?? 'monthly',
      firstDueDate: fields.firstDueDate ?? null,
      negative: fields.negative ?? null,
      name: `Quick Order | ${source.name} | Product | ${method.label} | ${status[0].toUpperCase()}${status.slice(1)} | ${paymentStatusLabel}${terms.length ? ` | ${terms.join(' | ')}` : ''} | ${accountName}`,
      coverage: fields.coverage ?? []
    })
  }

  add('cash-completed-paid-ledger-only', cash, 'completed', 'paid', null, { coverage: ['cash', 'completed', 'paid', 'no-account'] })
  if (cashDrawer) add('cash-completed-paid-cash-drawer', cash, 'completed', 'paid', cashDrawer, { coverage: ['cash', 'payment-account', 'cash-drawer'] })
  if (selectedDigital) add('random-digital-completed-paid-ledger-only', selectedDigital, 'completed', 'paid', null, { coverage: ['random-digital-method', 'completed', 'paid', 'no-account'] })
  if (bankTransfer) add('bank-transfer-completed-paid', bankTransfer, 'completed', 'paid', anyAccount, { coverage: ['bank-transfer', 'completed', 'paid', anyAccount ? 'payment-account' : 'no-account'] })
  if (selectedDigital) add('random-digital-pending-unpaid', selectedDigital, 'pending', 'unpaid', null, { coverage: ['random-digital-method', 'pending', 'unpaid'] })
  add('cash-draft-unpaid', cash, 'draft', 'unpaid', null, { coverage: ['cash', 'draft', 'unpaid'] })
  if (loan) {
    add('loan-completed-unpaid', loan, 'completed', 'unpaid', null, { coverage: ['loan', 'unpaid', 'linked-loan', 'loan-details-repayment'] })
    add('loan-completed-partial-ledger-only', loan, 'completed', 'partial', null, { initialPaymentAmount: 25, firstDueDate, coverage: ['loan', 'partial-initial-payment', 'no-account', 'due-date', 'loan-details-repayment'] })
    if (anyAccount) add('loan-completed-partial-account', loan, 'completed', 'partial', anyAccount, { initialPaymentAmount: 25, firstDueDate, coverage: ['loan', 'partial-initial-payment', 'payment-account', 'due-date', 'loan-details-repayment'] })
  }
  if (installments) {
    add('installments-completed-zero-initial-payment', installments, 'completed', 'unpaid', null, {
      initialPaymentAmount: 0, firstDueDate,
      coverage: ['installments', 'zero-initial-payment', 'due-date']
    })
    if (anyAccount) add('installments-completed-partial-initial-payment', installments, 'completed', 'unpaid', anyAccount, {
      initialPaymentAmount: 25, firstDueDate,
      coverage: ['installments', 'partial-initial-payment', 'payment-account', 'due-date']
    })
  }

  const negatives = [
    {
      id: 'quick-order-negative-missing-customer', domain: 'quick-order', negative: true, negativeKind: 'missing-customer',
      source, fixtureId: fixture.id, customer, method: cash, orderStatus: 'completed', paymentStatus: 'paid', account: null,
      name: `Quick Order | ${source.name} | Product | Cash | Completed | Paid | Missing Customer`,
      expectedUi: 'Save Order stays disabled because the required customer is missing.'
    },
    {
      id: 'quick-order-negative-missing-payment-method', domain: 'quick-order', negative: true, negativeKind: 'missing-payment-method',
      source, fixtureId: fixture.id, customer, method: null, orderStatus: 'completed', paymentStatus: null, account: null,
      name: `Quick Order | ${source.name} | Product | Missing Payment Method | Completed`,
      expectedUi: 'Save Order stays disabled because the required payment method is missing.'
    }
  ]
  if (loan) negatives.push({
    id: 'quick-order-negative-invalid-loan-initial-payment', domain: 'quick-order', negative: true, negativeKind: 'invalid-loan-initial-payment',
    source, fixtureId: fixture.id, customer, method: loan, orderStatus: 'completed', paymentStatus: 'partial', account: null,
    initialPaymentAmount: fixture.price, name: `Quick Order | ${source.name} | Product | Loan | Partial | Initial Payment Equals Total`,
    expectedUi: 'Save Order stays disabled because the initial loan repayment must be below the total.'
  })
  if (installments) negatives.push({
    id: 'quick-order-negative-missing-installment-due-date', domain: 'quick-order', negative: true, negativeKind: 'missing-installment-due-date',
    source, fixtureId: fixture.id, customer, method: installments, orderStatus: 'completed', paymentStatus: 'unpaid', account: null,
    initialPaymentAmount: 0, name: `Quick Order | ${source.name} | Product | Installments | Missing First Due Date`,
    expectedUi: 'Save Order stays disabled until the required first installment due date is selected.'
  })
  return { positive: cases, negative: negatives, selectedDigitalMethod: selectedDigital }
}

async function queryQuickOrderRows(context, customer, fixture, accountIds = []) {
  const { supabase, workspace } = context
  const [orders, inventory, inventoryTransactions, products, batches, partner, customerFacet, accountBalances, accountMovements] = await Promise.all([
    supabase.schema('crm').from('sales_orders').select('*').eq('workspace_id', workspace.id).eq('business_partner_id', customer.id),
    supabase.from('inventory').select('*').eq('workspace_id', workspace.id).eq('product_id', fixture.id),
    supabase.from('inventory_transactions').select('*').eq('workspace_id', workspace.id).eq('product_id', fixture.id),
    supabase.from('products').select('id,workspace_id,quantity,is_deleted,version').eq('workspace_id', workspace.id).eq('id', fixture.id),
    supabase.from('stock_batches').select('*').eq('workspace_id', workspace.id).eq('product_id', fixture.id),
    visibleBusinessPartners(context).then((rows) => ({ data: rows.filter((row) => row.id === customer.id), error: null })),
    visibleCustomers(context).then((rows) => ({ data: rows.filter((row) => row.id === customer.facetId), error: null })),
    accountIds.length
      ? supabase.schema('payment_accounts').from('account_balances').select('*').eq('workspace_id', workspace.id).in('account_id', accountIds)
      : Promise.resolve({ data: [], error: null }),
    accountIds.length
      ? supabase.schema('payment_accounts').from('account_movements').select('*').eq('workspace_id', workspace.id).in('account_id', accountIds)
      : Promise.resolve({ data: [], error: null })
  ])
  for (const [result, label] of [
    [orders, 'sales orders'], [inventory, 'inventory'], [inventoryTransactions, 'inventory transactions'],
    [products, 'products'], [batches, 'stock batches'], [partner, 'business partner'], [customerFacet, 'customer facet'],
    [accountBalances, 'payment-account balances'], [accountMovements, 'payment-account movements']
  ]) if (result.error) throw new Error(`Could not capture Quick Order ${label} state: ${result.error.message}`)

  const orderIds = (orders.data ?? []).map((row) => row.id)
  const [orderPayments, loans] = await Promise.all([
    orderIds.length
      ? supabase.from('payment_transactions').select('*').eq('workspace_id', workspace.id).eq('source_type', 'sales_order').in('source_record_id', orderIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('loans').select('*').eq('workspace_id', workspace.id).eq('order_type', 'sales').in('order_id', orderIds.length ? orderIds : ['00000000-0000-0000-0000-000000000000'])
  ])
  if (orderPayments.error) throw new Error(`Could not capture Quick Order payment baseline: ${orderPayments.error.message}`)
  if (loans.error) throw new Error(`Could not capture linked-loan baseline: ${loans.error.message}`)
  return {
    orders: orders.data ?? [], inventory: inventory.data ?? [], inventoryTransactions: inventoryTransactions.data ?? [],
    products: products.data ?? [], batches: batches.data ?? [], partner: partner.data?.[0] ?? null,
    customerFacet: customerFacet.data?.[0] ?? null, accountBalances: accountBalances.data ?? [],
    accountMovements: accountMovements.data ?? [], orderPayments: orderPayments.data ?? [], loans: loans.data ?? []
  }
}

export async function captureQuickOrderBaseline(context, setup, scenario) {
  const fixture = setup.fixtures.get(scenario.fixtureId)
  if (!fixture) throw new Error(`Quick Order fixture ${scenario.fixtureId} is missing.`)
  const accountIds = [...new Set([...(setup.paymentAccounts ?? []).map((account) => account.id), scenario.account?.id].filter(Boolean))]
  const rows = await queryQuickOrderRows(context, scenario.customer, fixture, accountIds)
  if (rows.inventory.length !== 1) throw new Error(`Expected one isolated inventory row for Quick Order fixture ${fixture.id}; found ${rows.inventory.length}.`)
  if (rows.products.length !== 1 || rows.products[0].is_deleted) throw new Error(`Quick Order fixture ${fixture.id} is not an active workspace product.`)
  return {
    capturedAt: new Date().toISOString(),
    scenarioId: scenario.id,
    workspaceId: context.workspace.id,
    cashierId: context.user.id,
    customer: { id: scenario.customer.id, facetId: scenario.customer.facetId, name: scenario.customer.name },
    fixture: { id: fixture.id, name: fixture.name, storageId: scenario.source.id, price: fixture.price, currency: fixture.currency },
    orderIds: rows.orders.map((row) => row.id),
    accountIds,
    accountCurrency: String(context.workspace.default_currency ?? 'usd').toLowerCase(),
    rows
  }
}

async function readOrderActual(context, scenario, setup, orderId, baseline) {
  const fixture = setup.fixtures.get(scenario.fixtureId)
  const { supabase, workspace } = context
  const orderQuery = await supabase.schema('crm').from('sales_orders').select('*')
    .eq('workspace_id', workspace.id).eq('id', orderId).maybeSingle()
  if (orderQuery.error) throw new Error(`Could not read Quick Order ${orderId}: ${orderQuery.error.message}`)
  const [afterState, payments, loans] = await Promise.all([
    queryQuickOrderRows(context, scenario.customer, fixture, baseline.accountIds),
    supabase.from('payment_transactions').select('*').eq('workspace_id', workspace.id).eq('source_type', 'sales_order').eq('source_record_id', orderId),
    supabase.from('loans').select('*').eq('workspace_id', workspace.id).eq('order_id', orderId).eq('order_type', 'sales')
  ])
  if (payments.error) throw new Error(`Could not read Quick Order ${orderId} payments: ${payments.error.message}`)
  if (loans.error) throw new Error(`Could not read Quick Order ${orderId} financing: ${loans.error.message}`)
  const paymentRows = payments.data ?? []
  const loanRows = loans.data ?? []
  const relatedLoanIds = loanRows.map((row) => row.id)
  const [loanInstallments, loanPayments, loanTransactions, orderInstallments] = await Promise.all([
    relatedLoanIds.length ? supabase.from('loan_installments').select('*').eq('workspace_id', workspace.id).in('loan_id', relatedLoanIds) : Promise.resolve({ data: [], error: null }),
    relatedLoanIds.length ? supabase.from('loan_payments').select('*').eq('workspace_id', workspace.id).in('loan_id', relatedLoanIds) : Promise.resolve({ data: [], error: null }),
    relatedLoanIds.length ? supabase.from('payment_transactions').select('*').eq('workspace_id', workspace.id).eq('source_module', 'loans').in('source_record_id', relatedLoanIds) : Promise.resolve({ data: [], error: null }),
    supabase.schema('crm').from('order_installments').select('*').eq('workspace_id', workspace.id).eq('order_id', orderId).eq('order_type', 'sales')
  ])
  for (const [result, label] of [[loanInstallments, 'loan installments'], [loanPayments, 'loan payments'], [loanTransactions, 'loan transactions'], [orderInstallments, 'order installments']]) {
    if (result.error) throw new Error(`Could not inspect Quick Order ${label}: ${result.error.message}`)
  }
  const transactionIds = [...new Set([
    ...paymentRows.map((row) => row.id),
    ...(loanTransactions.data ?? []).map((row) => row.id)
  ])]
  const accountMovementRows = transactionIds.length
    ? failIfError(await supabase.schema('payment_accounts').from('account_movements').select('*')
      .eq('workspace_id', workspace.id).in('payment_transaction_id', transactionIds), 'Could not inspect Quick Order account movements')
    : []
  const allObservedAccountMovements = new Map([...(afterState.accountMovements ?? []), ...accountMovementRows].map((row) => [row.id, row]))
  return {
    order: orderQuery.data,
    ...afterState,
    payments: paymentRows,
    accountMovements: [...allObservedAccountMovements.values()],
    loans: loanRows,
    loanInstallments: loanInstallments.data ?? [],
    loanPayments: loanPayments.data ?? [],
    loanTransactions: loanTransactions.data ?? [],
    orderInstallments: orderInstallments.data ?? []
  }
}

function partialLoanPaymentAmount(loan) {
  const balance = Number(loan.balance_amount)
  const currency = String(loan.settlement_currency ?? '').toLowerCase()
  const amount = currency === 'iqd'
    ? Math.floor(balance / 2)
    : Math.round((balance / 2 + Number.EPSILON) * 100) / 100
  if (!(amount > AMOUNT_EPSILON && amount < balance)) {
    throw new Error(`Could not choose a positive partial repayment below the ${currency.toUpperCase()} Quick Order loan balance ${balance}.`)
  }
  return amount
}

async function readQuickOrderLoanState(context, orderId) {
  const { supabase, workspace } = context
  const loans = failIfError(await supabase.from('loans').select('*')
    .eq('workspace_id', workspace.id).eq('order_id', orderId).eq('order_type', 'sales').eq('source', 'order'),
  'Could not read the Quick Order linked-loan state')
  const loanIds = loans.map((row) => row.id)
  if (!loanIds.length) return { loans, installments: [], payments: [], transactions: [], accountMovements: [] }
  const [installments, payments, transactions] = await Promise.all([
    supabase.from('loan_installments').select('*').eq('workspace_id', workspace.id).in('loan_id', loanIds),
    supabase.from('loan_payments').select('*').eq('workspace_id', workspace.id).in('loan_id', loanIds).order('sequence_no', { ascending: true }),
    supabase.from('payment_transactions').select('*').eq('workspace_id', workspace.id).eq('source_module', 'loans').in('source_record_id', loanIds)
  ])
  for (const [result, label] of [[installments, 'installments'], [payments, 'repayment rows'], [transactions, 'ledger transactions']]) {
    if (result.error) throw new Error(`Could not read Quick Order linked-loan ${label}: ${result.error.message}`)
  }
  const transactionIds = (transactions.data ?? []).map((row) => row.id)
  const accountMovements = transactionIds.length
    ? failIfError(await supabase.schema('payment_accounts').from('account_movements').select('*')
      .eq('workspace_id', workspace.id).in('payment_transaction_id', transactionIds),
    'Could not inspect Quick Order loan payment-account movements')
    : []
  return {
    loans,
    installments: installments.data ?? [],
    payments: payments.data ?? [],
    transactions: transactions.data ?? [],
    accountMovements
  }
}

function compareQuickOrderLoanStage(context, baseline, actual, { partialAmount, finalAmount, completedCount, requestPayloads }) {
  const errors = []
  const { loan, installments: baselineInstallments, payments: baselinePayments, transactions: baselineTransactions } = baseline
  const activeLoans = actual.loans.filter((row) => !row.is_deleted)
  if (activeLoans.length !== 1) {
    errors.push(`Expected exactly one active Quick Order loan, found ${activeLoans.length}.`)
    return errors
  }
  const loanAfter = activeLoans[0]
  const receivedAfterRun = partialAmount + (completedCount === 2 ? finalAmount : 0)
  const expectedPaid = Number(loan.total_paid_amount) + receivedAfterRun
  const expectedBalance = Math.max(0, Number(loan.balance_amount) - receivedAfterRun)
  const dueDate = loanAfter.next_due_date ? String(loanAfter.next_due_date).slice(0, 10) : null
  const expectedStatus = expectedBalance <= AMOUNT_EPSILON ? 'completed'
    : dueDate && dueDate < new Date().toISOString().slice(0, 10) ? 'overdue' : 'active'
  for (const [field, wanted, observed] of [
    ['workspace_id', context.workspace.id, loanAfter.workspace_id], ['order_id', baseline.orderId, loanAfter.order_id],
    ['order_type', 'sales', loanAfter.order_type], ['source', 'order', loanAfter.source],
    ['created_by', context.user.id, loanAfter.created_by], ['loan_category', 'simple', loanAfter.loan_category],
    ['direction', 'lent', loanAfter.direction], ['status', expectedStatus, loanAfter.status],
    ['settlement_currency', loan.settlement_currency, loanAfter.settlement_currency]
  ]) if (wanted !== observed) errors.push(`Quick Order loan ${field}: expected ${wanted}, actual ${observed}.`)
  for (const [field, wanted, observed] of [
    ['principal_amount', loan.principal_amount, loanAfter.principal_amount], ['total_paid_amount', expectedPaid, loanAfter.total_paid_amount],
    ['balance_amount', expectedBalance, loanAfter.balance_amount]
  ]) if (!closeAmount(wanted, observed)) errors.push(`Quick Order loan ${field}: expected ${wanted}, actual ${observed}.`)
  if (Number(loanAfter.version) !== Number(loan.version) + completedCount) errors.push(`Quick Order loan version: expected ${Number(loan.version) + completedCount}, actual ${loanAfter.version}.`)

  const oldPaymentIds = new Set(baselinePayments.map((row) => row.id))
  const createdPayments = actual.payments.filter((row) => !oldPaymentIds.has(row.id))
  const activeCreatedPayments = createdPayments.filter((row) => !row.is_deleted)
  if (createdPayments.length !== completedCount || activeCreatedPayments.length !== completedCount) {
    errors.push(`Quick Order loan repayment row count: expected ${completedCount} new active rows, actual ${JSON.stringify(createdPayments)}.`)
  }
  for (const [index, payment] of activeCreatedPayments.entries()) {
    const request = requestPayloads[index] ?? null
    const wantedAmount = index === 0 ? partialAmount : finalAmount
    for (const [field, wanted, observed] of [
      ['workspace_id', context.workspace.id, payment.workspace_id], ['loan_id', loan.id, payment.loan_id],
      ['sequence_no', baselinePayments.length + index + 1, Number(payment.sequence_no)],
      ['payment_method', 'cash', payment.payment_method], ['created_by', context.user.id, payment.created_by],
      ['is_deleted', false, Boolean(payment.is_deleted)], ['reversed_amount', 0, Number(payment.reversed_amount)],
      ['reversal_transaction_id', null, payment.reversal_transaction_id ?? null]
    ]) if (wanted !== observed) errors.push(`Quick Order loan payment ${payment.id}.${field}: expected ${wanted}, actual ${observed}.`)
    if (!closeAmount(wantedAmount, payment.amount)) errors.push(`Quick Order loan payment ${payment.id}.amount: expected ${wantedAmount}, actual ${payment.amount}.`)
    if (request?.id && payment.id !== request.id) errors.push(`Quick Order loan payment id ${payment.id} did not match the UI request id ${request.id}.`)
  }

  const oldTransactionIds = new Set(baselineTransactions.map((row) => row.id))
  const createdTransactions = actual.transactions.filter((row) => !oldTransactionIds.has(row.id))
  const activeTransactions = createdTransactions.filter((row) => !row.is_deleted && !row.reversal_of_transaction_id)
  if (createdTransactions.length !== completedCount || activeTransactions.length !== completedCount) {
    errors.push(`Quick Order loan payment ledger count: expected ${completedCount} new active transactions, actual ${JSON.stringify(createdTransactions)}.`)
  }
  for (const payment of activeCreatedPayments) {
    const linked = activeTransactions.filter((row) => row.id === payment.payment_transaction_id
      && row.metadata?.loanPaymentId === payment.id)
    if (linked.length !== 1) {
      errors.push(`Quick Order loan payment ${payment.id} must have exactly one linked ledger transaction; found ${linked.length}.`)
      continue
    }
    const transaction = linked[0]
    const request = requestPayloads.find((payload) => payload?.id === payment.id)
    if (request?.payment_transaction_id && transaction.id !== request.payment_transaction_id) {
      errors.push(`Quick Order repayment ledger id ${transaction.id} did not match the UI request id ${request.payment_transaction_id}.`)
    }
    for (const [field, wanted, observed] of [
      ['workspace_id', context.workspace.id, transaction.workspace_id], ['source_module', 'loans', transaction.source_module],
      ['source_type', 'simple_loan', transaction.source_type], ['source_record_id', loan.id, transaction.source_record_id],
      ['source_subrecord_id', payment.id, transaction.source_subrecord_id], ['direction', 'incoming', transaction.direction],
      ['currency', String(loan.settlement_currency).toLowerCase(), String(transaction.currency).toLowerCase()],
      ['payment_method', 'cash', transaction.payment_method], ['account_id', null, transaction.account_id ?? null],
      ['created_by', context.user.id, transaction.created_by], ['reversal_of_transaction_id', null, transaction.reversal_of_transaction_id ?? null]
    ]) if (wanted !== observed) errors.push(`Quick Order loan ledger ${transaction.id}.${field}: expected ${wanted}, actual ${observed}.`)
    if (!closeAmount(payment.amount, transaction.amount)) errors.push(`Quick Order loan ledger ${transaction.id}.amount did not match repayment ${payment.id}.`)
  }

  if (actual.installments.length !== baselineInstallments.length) errors.push(`Quick Order loan installment row count changed from ${baselineInstallments.length} to ${actual.installments.length}.`)
  for (const before of baselineInstallments) {
    const after = actual.installments.find((row) => row.id === before.id)
    if (!after) continue
    const expectedPaidAmount = Number(before.paid_amount) + receivedAfterRun
    const expectedBalanceAmount = Math.max(0, Number(before.balance_amount) - receivedAfterRun)
    const expectedInstallmentStatus = expectedBalanceAmount <= AMOUNT_EPSILON ? 'paid' : 'partial'
    for (const [field, wanted, observed] of [
      ['workspace_id', context.workspace.id, after.workspace_id], ['loan_id', loan.id, after.loan_id],
      ['status', expectedInstallmentStatus, after.status], ['is_deleted', false, Boolean(after.is_deleted)]
    ]) if (wanted !== observed) errors.push(`Quick Order installment ${after.id}.${field}: expected ${wanted}, actual ${observed}.`)
    for (const [field, wanted, observed] of [
      ['paid_amount', expectedPaidAmount, after.paid_amount], ['balance_amount', expectedBalanceAmount, after.balance_amount]
    ]) if (!closeAmount(wanted, observed)) errors.push(`Quick Order installment ${after.id}.${field}: expected ${wanted}, actual ${observed}.`)
    if (Number(after.version) !== Number(before.version) + completedCount) errors.push(`Quick Order installment ${after.id}.version: expected ${Number(before.version) + completedCount}, actual ${after.version}.`)
  }
  const expectedNewTransactionIds = new Set(activeTransactions.map((row) => row.id))
  const unexpectedAccountMovements = actual.accountMovements.filter((row) => expectedNewTransactionIds.has(row.payment_transaction_id) && !row.is_deleted)
  if (unexpectedAccountMovements.length) errors.push(`No-account Quick Order loan repayments created payment-account movements: ${JSON.stringify(unexpectedAccountMovements)}.`)
  return errors
}

async function pollQuickOrderLoanStage(context, baseline, expected) {
  const deadline = Date.now() + 30000
  let actual = null
  let errors = []
  do {
    actual = await readQuickOrderLoanState(context, baseline.orderId)
    errors = compareQuickOrderLoanStage(context, baseline, actual, expected)
    if (!errors.length) return { passed: true, errors: [], actual }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 350))
  } while (Date.now() <= deadline)
  return { passed: false, errors, actual }
}

export async function exerciseQuickOrderLoanRepayments(context, driver, scenario, orderId, checkoutActual) {
  const report = { passed: false, orderId, loanId: null, before: null, partialPayment: null, finalPayment: null, errors: [] }
  try {
    const loanRows = (checkoutActual?.loans ?? []).filter((row) => !row.is_deleted)
    if (loanRows.length !== 1) throw new Error(`Expected one active loan linked to Quick Order ${orderId}; found ${loanRows.length}.`)
    const loan = loanRows[0]
    if (loan.source !== 'order' || loan.order_type !== 'sales' || loan.order_id !== orderId
      || loan.loan_category !== 'simple' || loan.direction !== 'lent' || loan.created_by !== context.user.id
      || loan.workspace_id !== context.workspace.id) {
      throw new Error(`Quick Order loan did not match its exact source and owner: ${JSON.stringify(loan)}`)
    }
    const state = await readQuickOrderLoanState(context, orderId)
    const activePayments = state.payments.filter((row) => !row.is_deleted)
    const activeInstallments = state.installments.filter((row) => !row.is_deleted)
    if (state.loans.length !== 1 || state.installments.length !== 1 || activeInstallments.length !== 1) {
      throw new Error(`Expected one loan and one active repayment schedule for Quick Order ${orderId}: ${JSON.stringify(state)}`)
    }
    if (Number(loan.balance_amount) <= AMOUNT_EPSILON) throw new Error(`Quick Order loan ${loan.id} has no remaining balance to test.`)
    const baseline = { orderId, loan, installments: state.installments, payments: state.payments, transactions: state.transactions, accountMovements: state.accountMovements }
    report.loanId = loan.id
    report.before = baseline
    const initialInstallmentStatus = Number(activeInstallments[0].paid_amount) > AMOUNT_EPSILON ? 'partial' : 'unpaid'
    const details = await driver.openQuickOrderLoanDetails(loan, orderId, {
      totalRepaid: Number(loan.total_paid_amount),
      balance: Number(loan.balance_amount),
      paymentActivityCount: activePayments.length,
      installmentStatus: initialInstallmentStatus
    })
    report.loanDetails = details
    if (!details.passed) throw new Error(`Quick Order's linked Loans details page did not match Supabase: ${JSON.stringify(details.errors)}`)

    const partialAmount = partialLoanPaymentAmount(loan)
    const remainingAmount = Number(loan.balance_amount) - partialAmount
    const partialAction = await driver.submitLoanPayment(partialAmount, loan.settlement_currency, loan.id)
    const partialDatabase = await pollQuickOrderLoanStage(context, baseline, {
      partialAmount, finalAmount: remainingAmount, completedCount: 1,
      requestPayloads: [partialAction.payload].filter(Boolean)
    })
    const partialUi = await driver.waitForLoanDetailsState({
      totalRepaid: Number(loan.total_paid_amount) + partialAmount,
      balance: remainingAmount,
      paymentActivityCount: activePayments.length + 1,
      installmentStatus: 'partial'
    })
    report.partialPayment = { requestedAmount: partialAmount, action: partialAction, database: partialDatabase, ui: partialUi }
    if (!partialAction.passed || !partialDatabase.passed || !partialUi.passed) {
      throw new Error(`Partial Quick Order loan repayment did not reconcile: ${JSON.stringify({ action: partialAction.errors, database: partialDatabase.errors, ui: partialUi.errors })}`)
    }

    const finalAction = await driver.submitLoanPayment(remainingAmount, loan.settlement_currency, loan.id)
    const finalDatabase = await pollQuickOrderLoanStage(context, baseline, {
      partialAmount, finalAmount: remainingAmount, completedCount: 2,
      requestPayloads: [partialAction.payload, finalAction.payload].filter(Boolean)
    })
    const finalUi = await driver.waitForLoanDetailsState({
      totalRepaid: Number(loan.total_paid_amount) + Number(loan.balance_amount),
      balance: 0,
      paymentActivityCount: activePayments.length + 2,
      installmentStatus: 'paid'
    })
    report.finalPayment = { requestedAmount: remainingAmount, action: finalAction, database: finalDatabase, ui: finalUi }
    if (!finalAction.passed || !finalDatabase.passed || !finalUi.passed) {
      throw new Error(`Full Quick Order loan repayment did not reconcile: ${JSON.stringify({ action: finalAction.errors, database: finalDatabase.errors, ui: finalUi.errors })}`)
    }
    report.passed = true
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
  }
  return report
}

function expectedAmounts(scenario, fixture) {
  const total = Number(fixture.price)
  const financed = scenario.method.id === 'loan' || scenario.method.id === 'installments'
  const paid = financed ? Number(scenario.initialPaymentAmount ?? 0) : scenario.paymentStatus === 'paid' ? total : 0
  return {
    total,
    paid,
    balance: total - paid,
    paymentStatus: paid >= total - AMOUNT_EPSILON ? 'paid' : paid > AMOUNT_EPSILON ? 'partial' : 'unpaid',
    isPaid: paid >= total - AMOUNT_EPSILON
  }
}

function reconcileQuickOrderExpected(context, scenario, setup, orderId, baseline, actual) {
  const fixture = setup.fixtures.get(scenario.fixtureId)
  const expected = expectedAmounts(scenario, fixture)
  const mismatches = []
  const order = actual.order
  if (!order) return { passed: false, expected, actual, mismatches: [{ field: 'order.exists', expected: true, actual: false }] }
  const orderExpectations = [
    ['workspace_id', context.workspace.id, order.workspace_id], ['created_by', context.user.id, order.created_by],
    ['customer_id', scenario.customer.facetId, order.customer_id], ['business_partner_id', scenario.customer.id, order.business_partner_id],
    ['customer_name', scenario.customer.name, order.customer_name], ['source_channel', 'manual', order.source_channel],
    ['status', scenario.orderStatus, order.status], ['payment_status', expected.paymentStatus, order.payment_status],
    ['payment_method', scenario.method.id, order.payment_method], ['currency', fixture.currency, String(order.currency).toLowerCase()],
    ['is_paid', expected.isPaid, Boolean(order.is_paid)], ['is_deleted', false, Boolean(order.is_deleted)],
    ['installment_count', scenario.method.id === 'installments' ? scenario.installmentCount : scenario.method.id === 'loan' && scenario.firstDueDate ? 1 : 0, Number(order.installment_count ?? 0)],
    ['installment_frequency', scenario.installmentFrequency ?? 'monthly', order.installment_frequency ?? 'monthly'],
    ['first_due_date', scenario.firstDueDate ?? null, order.first_due_date ?? null],
    ['next_due_date', scenario.firstDueDate ?? null, order.next_due_date ?? null],
    ['linked_loan_id_reference', scenario.method.id === 'loan' || scenario.method.id === 'installments' ? 'linked loan' : null,
      order.linked_loan_id ? 'linked loan' : null]
  ]
  for (const [field, wanted, observed] of orderExpectations) {
    if (wanted !== observed) mismatches.push({ field: `sales_orders.${field}`, expected: wanted, actual: observed })
  }
  for (const [field, wanted, observed] of [
    ['subtotal', expected.total, order.subtotal], ['discount', 0, order.discount], ['tax', 0, order.tax],
    ['total', expected.total, order.total], ['paid_amount', expected.paid, order.paid_amount], ['balance_amount', expected.balance, order.balance_amount]
  ]) if (!closeAmount(wanted, observed)) mismatches.push({ field: `sales_orders.${field}`, expected: wanted, actual: observed })
  if (!order.id || order.id !== orderId || baseline.orderIds.includes(order.id)) {
    mismatches.push({ field: 'sales_orders.identity', expected: { id: orderId, newForTestCustomer: true }, actual: order.id })
  }
  if (!order.order_number || !String(order.order_number).startsWith('SO-')) {
    mismatches.push({ field: 'sales_orders.order_number', expected: 'assigned sales-order number', actual: order.order_number })
  }

  const newOrders = actual.orders.filter((row) => !baseline.orderIds.includes(row.id))
  if (newOrders.length !== 1 || newOrders[0]?.id !== orderId) {
    mismatches.push({ field: 'sales_orders.new_customer_orders', expected: [orderId], actual: newOrders.map((row) => row.id) })
  }
  const lines = Array.isArray(order.items) ? order.items : []
  if (lines.length !== 1) mismatches.push({ field: 'sales_orders.items.count', expected: 1, actual: lines.length })
  const line = lines[0]
  if (line) {
    const lineExpectations = [
      ['productId', fixture.id, value(line, 'productId')], ['productName', fixture.name, value(line, 'productName')],
      ['storageId', scenario.source.id, value(line, 'storageId')], ['quantity', 1, value(line, 'quantity')],
      ['originalUnitPrice', Number(fixture.price), value(line, 'originalUnitPrice')],
      ['convertedUnitPrice', Number(fixture.price), value(line, 'convertedUnitPrice')],
      ['lineTotal', expected.total, value(line, 'lineTotal')], ['originalCurrency', fixture.currency, String(value(line, 'originalCurrency') ?? '').toLowerCase()],
      ['settlementCurrency', fixture.currency, String(value(line, 'settlementCurrency') ?? '').toLowerCase()]
    ]
    for (const [field, wanted, observed] of lineExpectations) {
      if (field === 'quantity' || field.endsWith('Price') || field === 'lineTotal') {
        if (!closeAmount(wanted, observed)) mismatches.push({ field: `sales_orders.items[0].${field}`, expected: wanted, actual: observed })
      } else if (wanted !== observed) mismatches.push({ field: `sales_orders.items[0].${field}`, expected: wanted, actual: observed })
    }
    if (!Number.isFinite(Number(value(line, 'costPrice'))) || Number(value(line, 'costPrice')) !== Number(fixture.costPrice)) {
      mismatches.push({ field: 'sales_orders.items[0].costPrice', expected: fixture.costPrice, actual: value(line, 'costPrice') })
    }
  }

  const isFinanced = scenario.method.id === 'loan' || scenario.method.id === 'installments'
  const expectedOrderPaymentAmount = scenario.method.id === 'installments' ? expected.paid
    : !isFinanced && expected.isPaid ? expected.total : 0
  const activeOrderPayments = actual.payments.filter((row) => !row.is_deleted && !row.reversal_of_transaction_id)
  if ((expectedOrderPaymentAmount > AMOUNT_EPSILON && activeOrderPayments.length !== 1)
    || (expectedOrderPaymentAmount <= AMOUNT_EPSILON && activeOrderPayments.length !== 0)) {
    mismatches.push({ field: 'payment_transactions.order_count', expected: expectedOrderPaymentAmount > AMOUNT_EPSILON ? 1 : 0, actual: activeOrderPayments.length, rows: activeOrderPayments })
  }
  for (const payment of activeOrderPayments) {
    const expectedPaymentMethod = isFinanced ? 'cash' : scenario.method.id
    for (const [field, wanted, observed] of [
      ['workspace_id', context.workspace.id, payment.workspace_id], ['source_module', 'orders', payment.source_module],
      ['source_type', 'sales_order', payment.source_type], ['source_record_id', orderId, payment.source_record_id],
      ['source_subrecord_id', null, payment.source_subrecord_id ?? null], ['direction', 'incoming', payment.direction],
      ['currency', fixture.currency, String(payment.currency).toLowerCase()], ['payment_method', expectedPaymentMethod, payment.payment_method],
      ['account_id', scenario.account?.id ?? null, payment.account_id ?? null], ['created_by', context.user.id, payment.created_by],
      ['is_deleted', false, Boolean(payment.is_deleted)], ['reversal_of_transaction_id', null, payment.reversal_of_transaction_id ?? null]
    ]) if (wanted !== observed) mismatches.push({ field: `payment_transactions.${payment.id}.${field}`, expected: wanted, actual: observed })
    if (!closeAmount(expectedOrderPaymentAmount, payment.amount)) mismatches.push({ field: `payment_transactions.${payment.id}.amount`, expected: expectedOrderPaymentAmount, actual: payment.amount })
  }

  const expectedLoans = isFinanced && scenario.orderStatus !== 'draft' ? 1 : 0
  const activeLoans = actual.loans.filter((row) => !row.is_deleted)
  if (activeLoans.length !== expectedLoans) mismatches.push({ field: 'loans.order_link_count', expected: expectedLoans, actual: activeLoans.length, rows: activeLoans })
  if (expectedLoans) {
    const loan = activeLoans[0]
    const expectedPrincipal = scenario.method.id === 'loan' ? expected.total : expected.balance
    if (loan) {
      for (const [field, wanted, observed] of [
        ['workspace_id', context.workspace.id, loan.workspace_id], ['order_id', orderId, loan.order_id], ['order_type', 'sales', loan.order_type],
        ['source', 'order', loan.source], ['created_by', context.user.id, loan.created_by], ['direction', 'lent', loan.direction],
        ['loan_category', scenario.method.id === 'loan' ? 'simple' : 'standard', loan.loan_category],
        ['linked_party_id', scenario.customer.id, loan.linked_party_id], ['linked_party_type', 'business_partner', loan.linked_party_type],
        ['settlement_currency', fixture.currency, String(loan.settlement_currency).toLowerCase()], ['is_deleted', false, Boolean(loan.is_deleted)],
        ['installment_count', scenario.method.id === 'installments' ? scenario.installmentCount : 1, Number(loan.installment_count ?? 0)],
        ['installment_frequency', scenario.installmentFrequency ?? 'monthly', loan.installment_frequency ?? 'monthly'],
        ['first_due_date', scenario.firstDueDate ?? null, loan.first_due_date ?? null],
        ['next_due_date', scenario.firstDueDate ?? null, loan.next_due_date ?? null]
      ]) if (wanted !== observed) mismatches.push({ field: `loans.${loan.id}.${field}`, expected: wanted, actual: observed })
      if (!closeAmount(expectedPrincipal, loan.principal_amount)) mismatches.push({ field: `loans.${loan.id}.principal_amount`, expected: expectedPrincipal, actual: loan.principal_amount })
      if (!closeAmount(expected.balance, loan.balance_amount)) mismatches.push({ field: `loans.${loan.id}.balance_amount`, expected: expected.balance, actual: loan.balance_amount })
      if (!closeAmount(expected.paid, loan.total_paid_amount)) mismatches.push({ field: `loans.${loan.id}.total_paid_amount`, expected: expected.paid, actual: loan.total_paid_amount })
      const expectedScheduleCount = scenario.method.id === 'installments' ? scenario.installmentCount : 1
      const activeSchedule = actual.loanInstallments.filter((row) => !row.is_deleted)
      if (activeSchedule.length !== expectedScheduleCount) mismatches.push({ field: 'loan_installments.count', expected: expectedScheduleCount, actual: activeSchedule.length, rows: activeSchedule })
      const scheduleCurrency = String(loan.settlement_currency).toLowerCase()
      const scheduleBase = scheduleCurrency === 'iqd'
        ? Math.round(expectedPrincipal / Math.max(1, expectedScheduleCount))
        : Math.round((expectedPrincipal / Math.max(1, expectedScheduleCount) + Number.EPSILON) * 100) / 100
      for (let index = 0; index < activeSchedule.length; index += 1) {
        const schedule = activeSchedule.find((row) => Number(row.installment_no) === index + 1)
        if (!schedule) {
          mismatches.push({ field: `loan_installments.installment_${index + 1}`, expected: 'one numbered schedule row', actual: activeSchedule })
          continue
        }
        const lastAmount = expectedPrincipal - scheduleBase * (expectedScheduleCount - 1)
        const planned = expectedScheduleCount === 1 || index === expectedScheduleCount - 1 ? lastAmount : scheduleBase
        let dueDate = scenario.firstDueDate ?? null
        if (scenario.method.id === 'installments' && dueDate && index > 0) {
          const date = new Date(`${dueDate}T00:00:00.000Z`)
          if (scenario.installmentFrequency === 'weekly') date.setUTCDate(date.getUTCDate() + index * 7)
          else if (scenario.installmentFrequency === 'biweekly') date.setUTCDate(date.getUTCDate() + index * 14)
          else {
            const originalDay = date.getUTCDate()
            const targetMonth = date.getUTCMonth() + index
            date.setUTCDate(1)
            date.setUTCMonth(targetMonth)
            const finalDayOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
            date.setUTCDate(Math.min(originalDay, finalDayOfMonth))
          }
          dueDate = date.toISOString().slice(0, 10)
        }
        const paid = scenario.method.id === 'loan' ? expected.paid : 0
        const balance = Math.max(0, planned - paid)
        const dueIsPast = dueDate && dueDate < new Date().toISOString().slice(0, 10)
        const status = balance <= AMOUNT_EPSILON ? 'paid'
          : paid > AMOUNT_EPSILON ? 'partial' : dueIsPast ? 'overdue' : 'unpaid'
        for (const [field, wanted, observed] of [
          ['workspace_id', context.workspace.id, schedule.workspace_id], ['loan_id', loan.id, schedule.loan_id],
          ['installment_no', index + 1, Number(schedule.installment_no)], ['due_date', dueDate, schedule.due_date ?? null],
          ['status', status, schedule.status], ['is_deleted', false, Boolean(schedule.is_deleted)]
        ]) if (wanted !== observed) mismatches.push({ field: `loan_installments.${schedule.id}.${field}`, expected: wanted, actual: observed })
        for (const [field, wanted, observed] of [
          ['planned_amount', planned, schedule.planned_amount], ['paid_amount', paid, schedule.paid_amount], ['balance_amount', balance, schedule.balance_amount]
        ]) if (!closeAmount(wanted, observed)) mismatches.push({ field: `loan_installments.${schedule.id}.${field}`, expected: wanted, actual: observed })
      }
      if (scenario.method.id === 'loan') {
        const initialLoanPayments = actual.loanPayments.filter((row) => !row.is_deleted)
        const expectedPaymentCount = expected.paid > AMOUNT_EPSILON ? 1 : 0
        if (initialLoanPayments.length !== expectedPaymentCount || actual.loanPayments.length !== expectedPaymentCount) {
          mismatches.push({ field: 'loan_payments.initial_repayment_count', expected: expectedPaymentCount, actual: actual.loanPayments })
        }
        if (expectedPaymentCount) {
          const initialPayment = initialLoanPayments[0]
          if (!closeAmount(expected.paid, initialPayment?.amount)) {
            mismatches.push({ field: 'loan_payments.initial_repayment_amount', expected: expected.paid, actual: initialPayment?.amount ?? null })
          }
          const transaction = actual.loanTransactions.find((row) => row.id === initialPayment?.payment_transaction_id)
          if (!transaction || actual.loanTransactions.filter((row) => !row.is_deleted && !row.reversal_of_transaction_id).length !== 1) {
            mismatches.push({ field: 'loan_payments.initial_repayment_transaction', expected: 'one linked transaction', actual: actual.loanTransactions })
          } else {
            for (const [field, wanted, observed] of [
              ['workspace_id', context.workspace.id, transaction.workspace_id], ['source_module', 'loans', transaction.source_module],
              ['source_type', 'simple_loan', transaction.source_type], ['source_record_id', loan.id, transaction.source_record_id],
              ['source_subrecord_id', initialPayment.id, transaction.source_subrecord_id ?? null], ['direction', 'incoming', transaction.direction],
              ['currency', fixture.currency, String(transaction.currency).toLowerCase()], ['payment_method', 'cash', transaction.payment_method],
              ['account_id', scenario.account?.id ?? null, transaction.account_id ?? null], ['created_by', context.user.id, transaction.created_by],
              ['is_deleted', false, Boolean(transaction.is_deleted)]
            ]) if (wanted !== observed) mismatches.push({ field: `payment_transactions.${transaction.id}.${field}`, expected: wanted, actual: observed })
            if (!closeAmount(expected.paid, transaction.amount)) mismatches.push({ field: `payment_transactions.${transaction.id}.amount`, expected: expected.paid, actual: transaction.amount })
          }
        } else if (actual.loanTransactions.filter((row) => !row.is_deleted && !row.reversal_of_transaction_id).length) {
          mismatches.push({ field: 'payment_transactions.unexpected_initial_loan_repayment', expected: [], actual: actual.loanTransactions })
        }
      }
    }
  }

  const baselineInventory = baseline.rows.inventory[0]
  const expectedInventoryQuantity = Number(baselineInventory.quantity) - (scenario.orderStatus === 'completed' ? 1 : 0)
  const actualInventory = actual.inventory.find((row) => row.id === baselineInventory.id)
  if (!actualInventory || !closeAmount(expectedInventoryQuantity, actualInventory.quantity, QUANTITY_EPSILON)) {
    mismatches.push({ field: 'inventory.quantity', expected: expectedInventoryQuantity, actual: actualInventory?.quantity ?? null })
  }
  const baselineProduct = baseline.rows.products[0]
  const actualProduct = actual.products.find((row) => row.id === fixture.id)
  const expectedProductQuantity = Number(baselineProduct.quantity) - (scenario.orderStatus === 'completed' ? 1 : 0)
  if (!actualProduct || !closeAmount(expectedProductQuantity, actualProduct.quantity, QUANTITY_EPSILON)
    || Boolean(actualProduct.is_deleted) !== Boolean(baselineProduct.is_deleted)) {
    mismatches.push({
      field: 'products.quantity_summary',
      expected: { quantity: expectedProductQuantity, is_deleted: baselineProduct.is_deleted },
      actual: actualProduct ? { quantity: actualProduct.quantity, is_deleted: actualProduct.is_deleted } : null
    })
  }
  const newInventoryTransactions = mutationDiff(baseline.rows.inventoryTransactions, actual.inventoryTransactions)
  if (scenario.orderStatus === 'completed') {
    const saleMovements = newInventoryTransactions.filter((row) => row.transaction_type === 'sale'
      && String(row.reference_id) === orderId && row.reference_type === 'sales_order')
    if (saleMovements.length !== 1) mismatches.push({ field: 'inventory_transactions.sale_count', expected: 1, actual: saleMovements })
    for (const movement of saleMovements) {
      if (!closeAmount(-1, movement.quantity_delta, QUANTITY_EPSILON)
        || !closeAmount(baselineInventory.quantity, movement.previous_quantity, QUANTITY_EPSILON)
        || !closeAmount(expectedInventoryQuantity, movement.new_quantity, QUANTITY_EPSILON)
        || movement.storage_id !== scenario.source.id || movement.product_id !== fixture.id) {
        mismatches.push({ field: `inventory_transactions.${movement.id}.sale_movement`, expected: { quantity_delta: -1, previous_quantity: baselineInventory.quantity, new_quantity: expectedInventoryQuantity, storage_id: scenario.source.id, product_id: fixture.id }, actual: movement })
      }
    }
  } else if (newInventoryTransactions.length) {
    mismatches.push({ field: 'inventory_transactions.unexpected', expected: [], actual: newInventoryTransactions })
  }
  const newBatches = mutationDiff(baseline.rows.batches, actual.batches)
  for (const before of baseline.rows.batches) {
    const after = actual.batches.find((row) => row.id === before.id)
    if (!after || Number(after.quantity) !== Number(before.quantity) || Boolean(after.is_deleted) !== Boolean(before.is_deleted)) {
      mismatches.push({ field: `stock_batches.${before.id}`, expected: { quantity: before.quantity, is_deleted: before.is_deleted }, actual: after ?? null })
    }
  }
  if (newBatches.length) mismatches.push({ field: 'stock_batches.unexpected', expected: [], actual: newBatches })

  const expectedPaymentIds = [...activeOrderPayments.map((row) => row.id), ...actual.loanPayments.filter((row) => !row.is_deleted).map((row) => row.payment_transaction_id).filter(Boolean)]
  const allNewAccountMovements = mutationDiff(baseline.rows.accountMovements, actual.accountMovements)
  const testPaymentTransactionIds = new Set(expectedPaymentIds)
  const newAccountMovements = allNewAccountMovements.filter((row) => testPaymentTransactionIds.has(row.payment_transaction_id))
  const expectedAccountMovementIds = new Set(expectedPaymentIds.filter((id) => {
    const transaction = [...actual.payments, ...actual.loanTransactions].find((row) => row.id === id)
    return transaction?.account_id
  }))
  const actualMovementTransactionIds = new Set(newAccountMovements.filter((row) => !row.is_deleted).map((row) => row.payment_transaction_id))
  for (const id of expectedAccountMovementIds) if (!actualMovementTransactionIds.has(id)) mismatches.push({ field: `payment_accounts.account_movements.missing_for_${id}`, expected: id, actual: [...actualMovementTransactionIds] })
  const expectedMovementCount = expectedAccountMovementIds.size
  const activeNewMovements = newAccountMovements.filter((row) => !row.is_deleted)
  if (activeNewMovements.length !== expectedMovementCount) mismatches.push({ field: 'payment_accounts.account_movements.count', expected: expectedMovementCount, actual: activeNewMovements.length, rows: activeNewMovements })
  for (const movement of activeNewMovements) {
    const transaction = [...actual.payments, ...actual.loanTransactions].find((row) => row.id === movement.payment_transaction_id)
    if (!transaction || transaction.account_id !== movement.account_id || String(transaction.currency).toLowerCase() !== String(movement.currency).toLowerCase()
      || !closeAmount(Math.abs(Number(transaction.amount)), movement.amount ?? Math.abs(Number(movement.delta_amount)))
      || !closeAmount(Number(transaction.amount) * (transaction.direction === 'outgoing' ? -1 : 1), movement.delta_amount)) {
      mismatches.push({ field: `payment_accounts.account_movements.${movement.id}.integrity`, expected: transaction ?? 'linked payment transaction', actual: movement })
    }
  }
  const beforeBalances = accountBalancesFor(baseline.rows.accountBalances, baseline.accountIds, baseline.accountCurrency)
  const afterBalances = accountBalancesFor(actual.accountBalances, baseline.accountIds, baseline.accountCurrency)
  const expectedAccountDelta = [...actual.payments, ...actual.loanTransactions]
    .filter((row) => row.account_id && !row.is_deleted && !row.reversal_of_transaction_id)
    .reduce((sum, row) => sum + Number(row.amount) * (row.direction === 'outgoing' ? -1 : 1), 0)
  for (const accountId of baseline.accountIds) {
    const before = Number(beforeBalances.find((row) => row.account_id === accountId)?.balance_amount ?? 0)
    const after = Number(afterBalances.find((row) => row.account_id === accountId)?.balance_amount ?? 0)
    const expectedFromAllMovements = allNewAccountMovements
      .filter((row) => row.account_id === accountId && String(row.currency).toLowerCase() === baseline.accountCurrency && !row.is_deleted)
      .reduce((sum, row) => sum + Number(row.delta_amount), 0)
    if (!closeAmount(after - before, expectedFromAllMovements)) mismatches.push({ field: `payment_accounts.balance_ledger_reconciliation.${accountId}`, expected: before + expectedFromAllMovements, actual: after })
    const scenarioMovementDelta = newAccountMovements
      .filter((row) => row.account_id === accountId && String(row.currency).toLowerCase() === baseline.accountCurrency && !row.is_deleted)
      .reduce((sum, row) => sum + Number(row.delta_amount), 0)
    const expectedScenarioDelta = [...actual.payments, ...actual.loanTransactions]
      .filter((row) => row.account_id === accountId && !row.is_deleted && !row.reversal_of_transaction_id)
      .reduce((sum, row) => sum + Number(row.amount) * (row.direction === 'outgoing' ? -1 : 1), 0)
    if (!closeAmount(scenarioMovementDelta, expectedScenarioDelta)) mismatches.push({ field: `payment_accounts.scenario_delta.${accountId}`, expected: expectedScenarioDelta, actual: scenarioMovementDelta })
  }
  const unexpectedPayments = actual.payments.filter((row) => !baseline.rows.orderPayments.some((before) => before.id === row.id)
    && !row.is_deleted && !row.reversal_of_transaction_id)
  if (unexpectedPayments.length !== activeOrderPayments.length) mismatches.push({ field: 'payment_transactions.duplicate_or_orphan_order_rows', expected: activeOrderPayments, actual: unexpectedPayments })

  const summary = {
    partner: actual.partner,
    customer: actual.customerFacet,
    baselinePartner: baseline.rows.partner,
    baselineCustomer: baseline.rows.customerFacet,
    expectedPaid: expected.paid,
    expectedBalance: expected.balance,
    expectedStatus: expected.paymentStatus,
    accountDelta: expectedAccountDelta,
    unrelatedConcurrentAccountMovements: allNewAccountMovements.filter((row) => !testPaymentTransactionIds.has(row.payment_transaction_id))
  }
  if (!actual.partner || !actual.customerFacet) mismatches.push({ field: 'customer_relationships', expected: 'customer facet linked to owned business partner', actual: { partner: actual.partner, customer: actual.customerFacet } })
  else if (actual.customerFacet.business_partner_id !== scenario.customer.id || actual.partner.customer_facet_id !== scenario.customer.facetId
    || actual.partner.workspace_id !== context.workspace.id || actual.customerFacet.workspace_id !== context.workspace.id) {
    mismatches.push({ field: 'customer_relationships', expected: { partnerId: scenario.customer.id, customerId: scenario.customer.facetId, workspaceId: context.workspace.id }, actual: { partnerId: actual.partner.id, customerId: actual.customerFacet.id, businessPartnerId: actual.customerFacet.business_partner_id, partnerFacetId: actual.partner.customer_facet_id, partnerWorkspace: actual.partner.workspace_id, customerWorkspace: actual.customerFacet.workspace_id } })
  }
  if (actual.partner && actual.customerFacet) {
    const completedValue = scenario.orderStatus === 'completed' ? expected.total : 0
    const activeCount = 1
    const outstanding = ['pending', 'completed'].includes(scenario.orderStatus) ? expected.balance : 0
    const isFinancedLoan = expectedLoans === 1
    const loanOutstanding = isFinancedLoan ? expected.balance : 0
    const partnerExpected = {
      total_sales_orders: Number(baseline.rows.partner?.total_sales_orders ?? 0) + activeCount,
      total_sales_value: Number(baseline.rows.partner?.total_sales_value ?? 0) + completedValue,
      receivable_balance: Number(baseline.rows.partner?.receivable_balance ?? 0) + outstanding,
      total_loan_count: Number(baseline.rows.partner?.total_loan_count ?? 0) + (isFinancedLoan ? 1 : 0),
      loan_outstanding_balance: Number(baseline.rows.partner?.loan_outstanding_balance ?? 0) + loanOutstanding,
      net_exposure: Number(baseline.rows.partner?.net_exposure ?? 0) + outstanding
    }
    const customerExpected = {
      total_orders: Number(baseline.rows.customerFacet?.total_orders ?? 0) + activeCount,
      total_spent: Number(baseline.rows.customerFacet?.total_spent ?? 0) + completedValue,
      outstanding_balance: Number(baseline.rows.customerFacet?.outstanding_balance ?? 0) + outstanding
    }
    for (const [field, wanted] of Object.entries(partnerExpected)) {
      if (!closeAmount(wanted, actual.partner[field])) mismatches.push({ field: `business_partners.${field}`, expected: wanted, actual: actual.partner[field] })
    }
    for (const [field, wanted] of Object.entries(customerExpected)) {
      if (!closeAmount(wanted, actual.customerFacet[field])) mismatches.push({ field: `customers.${field}`, expected: wanted, actual: actual.customerFacet[field] })
    }
  }
  return { passed: mismatches.length === 0, expected, actual, mismatches, summary }
}

export async function reconcileQuickOrder(context, setup, scenario, orderId, baseline, { poll = true } = {}) {
  if (!orderId) return { passed: false, expected: 'one correlated sales order', actual: null, mismatches: [{ field: 'sales_orders.correlation', expected: 'one order id from Quick Order UI', actual: null }] }
  const deadline = Date.now() + (poll ? 30000 : 0)
  let reconciled = null
  do {
    const actual = await readOrderActual(context, scenario, setup, orderId, baseline)
    reconciled = reconcileQuickOrderExpected(context, scenario, setup, orderId, baseline, actual)
    if (reconciled.passed) return reconciled
    if (!poll || Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 350))
  } while (Date.now() <= deadline)
  return reconciled
}

export async function reconcileQuickOrderNoMutation(context, setup, scenario, baseline) {
  const fixture = setup.fixtures.get(scenario.fixtureId)
  const actual = await queryQuickOrderRows(context, scenario.customer, fixture, baseline.accountIds)
  const errors = []
  const newOrders = actual.orders.filter((row) => !baseline.orderIds.includes(row.id))
  if (newOrders.length) errors.push(`Rejected Quick Order left sales-order row(s): ${JSON.stringify(newOrders.map(({ id, status, is_deleted }) => ({ id, status, is_deleted })))}`)
  for (const before of baseline.rows.inventory) {
    const after = actual.inventory.find((row) => row.id === before.id)
    if (!after || !closeAmount(before.quantity, after.quantity, QUANTITY_EPSILON) || Boolean(before.is_deleted) !== Boolean(after.is_deleted)) {
      errors.push(`Inventory changed after rejected Quick Order for product ${before.product_id}, storage ${before.storage_id}.`)
    }
  }
  const newMovements = mutationDiff(baseline.rows.inventoryTransactions, actual.inventoryTransactions)
  if (newMovements.length) errors.push(`Rejected Quick Order created inventory movement(s): ${JSON.stringify(newMovements)}`)
  const newPayments = mutationDiff(baseline.rows.orderPayments, actual.orderPayments)
  if (newPayments.length) errors.push(`Rejected Quick Order created payment transaction(s): ${JSON.stringify(newPayments)}`)
  for (const before of baseline.rows.products) {
    const after = actual.products.find((row) => row.id === before.id)
    const expectedQuantity = Number(before.quantity)
    if (!after || !closeAmount(after.quantity, expectedQuantity, QUANTITY_EPSILON) || Boolean(after.is_deleted) !== Boolean(before.is_deleted)) {
      errors.push(`Product summary changed after rejected Quick Order for product ${before.id}: expected ${expectedQuantity}, actual ${after?.quantity ?? null}.`)
    }
  }
  for (const before of baseline.rows.accountBalances) {
    const after = actual.accountBalances.find((row) => row.account_id === before.account_id && row.currency === before.currency)
    if (!closeAmount(after?.balance_amount ?? 0, before.balance_amount)) errors.push(`Payment account ${before.account_id} changed after rejected Quick Order.`)
  }
  const newAccountMovements = mutationDiff(baseline.rows.accountMovements, actual.accountMovements)
  const newAccountPaymentIds = new Set(newAccountMovements.map((row) => row.payment_transaction_id))
  const newAccountPayments = actual.orderPayments.filter((row) => newAccountPaymentIds.has(row.id))
  if (newAccountPayments.length) errors.push(`Rejected Quick Order created account-linked payment transaction(s): ${JSON.stringify(newAccountPayments)}`)
  for (const before of baseline.rows.accountBalances) {
    const after = actual.accountBalances.find((row) => row.account_id === before.account_id && row.currency === before.currency)
    const movementDelta = newAccountMovements.filter((row) => row.account_id === before.account_id && row.currency === before.currency && !row.is_deleted)
      .reduce((sum, row) => sum + Number(row.delta_amount), 0)
    if (!closeAmount(Number(after?.balance_amount ?? 0) - Number(before.balance_amount), movementDelta)) {
      errors.push(`Payment account ${before.account_id} balance did not reconcile to its persisted movements after rejected Quick Order.`)
    }
  }
  for (const [field, before, after] of [
    ['business_partner.total_sales_orders', baseline.rows.partner?.total_sales_orders, actual.partner?.total_sales_orders],
    ['business_partner.total_sales_value', baseline.rows.partner?.total_sales_value, actual.partner?.total_sales_value],
    ['business_partner.receivable_balance', baseline.rows.partner?.receivable_balance, actual.partner?.receivable_balance],
    ['business_partner.total_loan_count', baseline.rows.partner?.total_loan_count, actual.partner?.total_loan_count],
    ['business_partner.loan_outstanding_balance', baseline.rows.partner?.loan_outstanding_balance, actual.partner?.loan_outstanding_balance],
    ['business_partner.net_exposure', baseline.rows.partner?.net_exposure, actual.partner?.net_exposure],
    ['customer.total_orders', baseline.rows.customerFacet?.total_orders, actual.customerFacet?.total_orders],
    ['customer.total_spent', baseline.rows.customerFacet?.total_spent, actual.customerFacet?.total_spent],
    ['customer.outstanding_balance', baseline.rows.customerFacet?.outstanding_balance, actual.customerFacet?.outstanding_balance]
  ]) if (before != null && !closeAmount(before, after)) errors.push(`${field} changed after rejected Quick Order: expected ${before}, actual ${after}.`)
  const actualState = { orders: newOrders, inventory: actual.inventory, inventoryTransactions: newMovements, payments: newPayments, accountBalances: actual.accountBalances, accountMovements: newAccountMovements }
  return { passed: errors.length === 0, expected: 'No sales order, payment, inventory or account mutation.', actual: actualState, errors }
}

async function proveOwnedOrder(context, customer, orderId) {
  const row = await context.supabase.schema('crm').from('sales_orders').select('*')
    .eq('workspace_id', context.workspace.id).eq('id', orderId).maybeSingle()
  if (row.error) throw new Error(`Could not verify Quick Order ownership before cleanup: ${row.error.message}`)
  const order = row.data
  if (!order) return null
  if (order.workspace_id !== context.workspace.id || order.created_by !== context.user.id
    || order.business_partner_id !== customer.id || order.customer_id !== customer.facetId
    || order.source_channel !== 'manual') {
    throw new Error(`Refusing to clean Quick Order ${orderId}: workspace, cashier, customer, or source ownership did not match the run.`)
  }
  return order
}

async function reverseOrderPayment(context, payment, marker) {
  const { supabase, workspace, user } = context
  const existingReversals = failIfError(await supabase.from('payment_transactions').select('*')
    .eq('workspace_id', workspace.id).eq('reversal_of_transaction_id', payment.id), 'Could not check existing Quick Order payment reversals')
  const reversedAmount = existingReversals.filter((row) => !row.is_deleted).reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0)
  const remaining = Number(payment.amount) - reversedAmount
  if (remaining <= AMOUNT_EPSILON) return { reversalRows: existingReversals, created: false }
  if (remaining < Number(payment.amount) - AMOUNT_EPSILON) throw new Error(`Refusing incomplete Quick Order payment cleanup: payment ${payment.id} has a prior partial reversal.`)
  const reversal = {
    id: randomUUID(), workspace_id: workspace.id, source_module: payment.source_module, source_type: payment.source_type,
    source_record_id: payment.source_record_id, source_subrecord_id: payment.source_subrecord_id ?? null,
    direction: payment.direction, amount: -Number(payment.amount), currency: payment.currency,
    payment_method: payment.payment_method, paid_at: new Date().toISOString(), counterparty_name: payment.counterparty_name ?? null,
    reference_label: payment.reference_label ?? null, note: `${marker} cleanup reversal`, created_by: user.id,
    account_id: payment.account_id ?? null, account_name_snapshot: payment.account_name_snapshot ?? null,
    reversal_of_transaction_id: payment.id, metadata: { ...(payment.metadata ?? {}), reversal: true, cleanupMarker: marker },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1, is_deleted: false
  }
  const inserted = await supabase.from('payment_transactions').insert(reversal).select('*').single()
  if (inserted.error) throw new Error(`Could not post the Quick Order payment reversal: ${inserted.error.message}`)
  return { reversalRows: [...existingReversals, inserted.data], created: true }
}

async function restoreOwnedInventory(context, fixture, expectedCurrentQuantity, baselineQuantity, orderId, marker) {
  const { supabase, workspace, user } = context
  const rows = failIfError(await supabase.from('inventory').select('id,workspace_id,product_id,storage_id,quantity,is_deleted,version')
    .eq('workspace_id', workspace.id).eq('product_id', fixture.id).eq('storage_id', fixture.storageId), 'Could not inspect Quick Order cleanup inventory')
  if (rows.length !== 1 || rows[0].is_deleted || Math.abs(Number(rows[0].quantity) - expectedCurrentQuantity) > QUANTITY_EPSILON) {
    throw new Error(`Refusing to restore Quick Order inventory because it no longer matches the scenario's exact expected quantity (${expectedCurrentQuantity}): ${JSON.stringify(rows)}.`)
  }
  const delta = Number(baselineQuantity) - Number(rows[0].quantity)
  if (Math.abs(delta) <= QUANTITY_EPSILON) return { restored: false, row: rows[0] }
  if (delta < 0) throw new Error(`Refusing to reduce test inventory during cleanup; computed adjustment ${delta}.`)
  const transaction = {
    id: randomUUID(), workspace_id: workspace.id, product_id: fixture.id, storage_id: fixture.storageId,
    transaction_type: 'stock_adjustment', quantity_delta: delta,
    previous_quantity: Number(rows[0].quantity), new_quantity: Number(baselineQuantity),
    adjustment_reason: 'return', reference_id: orderId, reference_type: 'cloud_hybrid_playwright_cleanup',
    notes: `${marker} owned inventory restoration`, created_by: user.id, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), version: 1, is_deleted: false
  }
  const applied = await supabase.rpc('apply_stock_adjustment', { p_transaction: transaction })
  if (applied.error) throw new Error(`Could not restore owned Quick Order inventory through the stock-adjustment ledger: ${applied.error.message}`)
  return { restored: true, transaction: applied.data?.transaction ?? null, inventory: applied.data?.inventory ?? null }
}

async function restoreCustomerSummaryBaseline(context, customer, baseline) {
  const { supabase, workspace } = context
  if (!baseline.rows.partner || !baseline.rows.customerFacet) return
  const updatedAt = new Date().toISOString()
  await Promise.all([
    syncPartnerEntity(context, {
      ...baseline.rows.partner,
      id: customer.id,
      workspace_id: workspace.id,
      notes: customer.marker,
      total_sales_orders: baseline.rows.partner.total_sales_orders,
      total_sales_value: baseline.rows.partner.total_sales_value,
      receivable_balance: baseline.rows.partner.receivable_balance,
      total_loan_count: baseline.rows.partner.total_loan_count,
      loan_outstanding_balance: baseline.rows.partner.loan_outstanding_balance,
      net_exposure: baseline.rows.partner.net_exposure,
      updated_at: updatedAt,
      version: Number(baseline.rows.partner.version ?? 1) + 1
    }),
    syncPartnerEntity(context, {
      ...baseline.rows.customerFacet,
      id: customer.facetId,
      workspace_id: workspace.id,
      business_partner_id: customer.id,
      notes: customer.marker,
      total_orders: baseline.rows.customerFacet.total_orders,
      total_spent: baseline.rows.customerFacet.total_spent,
      outstanding_balance: baseline.rows.customerFacet.outstanding_balance,
      updated_at: updatedAt,
      version: Number(baseline.rows.customerFacet.version ?? 1) + 1,
      customerFacet: true
    })
  ])
  const [partners, customers] = await Promise.all([visibleBusinessPartners(context), visibleCustomers(context)])
  const restoredPartner = partners.find((row) => row.id === customer.id)
  const restoredCustomer = customers.find((row) => row.id === customer.facetId)
  if (!restoredPartner || !restoredCustomer
    || restoredPartner.notes !== customer.marker || restoredCustomer.notes !== customer.marker
    || !closeAmount(restoredPartner.total_sales_orders, baseline.rows.partner.total_sales_orders)
    || !closeAmount(restoredCustomer.total_orders, baseline.rows.customerFacet.total_orders)) {
    throw new Error('Could not verify test-owned Quick Order customer summary restoration through scoped Supabase reads.')
  }
}

export async function cleanupQuickOrderScenario(context, setup, scenario, orderId, baseline, {
  discardCustomer = false,
  returnCompletedFinancedOrder = null
} = {}) {
  const report = { attempted: true, completed: false, orderId: orderId ?? null, reversals: [], inventory: null, financing: null, errors: [], verification: null }
  try {
    const fixture = setup.fixtures.get(scenario.fixtureId)
    const order = orderId ? await proveOwnedOrder(context, scenario.customer, orderId) : null
    let actualBeforeCleanup = null
    let completedFinancedReturn = null
    if (order) actualBeforeCleanup = await readOrderActual(context, scenario, setup, orderId, baseline)
    if (order) {
      if (scenario.method?.id === 'loan' || scenario.method?.id === 'installments') {
        if (order.status === 'completed') {
          if (order.return_status !== 'full') {
            if (typeof returnCompletedFinancedOrder !== 'function') {
              throw new Error('A completed financed Quick Order must be fully returned through the POS before cleanup.')
            }
            completedFinancedReturn = await returnCompletedFinancedOrder(order.id)
          }

          const returnedOrderResult = await context.supabase.schema('crm').from('sales_orders').select('*')
            .eq('workspace_id', context.workspace.id).eq('id', order.id).maybeSingle()
          if (returnedOrderResult.error || !returnedOrderResult.data) {
            throw new Error(`Could not verify the returned test-owned Quick Order: ${returnedOrderResult.error?.message ?? 'order disappeared'}`)
          }
          const returnedOrder = returnedOrderResult.data
          if (returnedOrder.return_status !== 'full'
            || !closeAmount(returnedOrder.returned_amount, order.total)
            || !closeAmount(returnedOrder.total, 0)) {
            throw new Error(`The POS return did not reconcile to a full return of the financed Quick Order: ${JSON.stringify({ returnStatus: returnedOrder.return_status, returnedAmount: returnedOrder.returned_amount, originalTotal: order.total, remainingTotal: returnedOrder.total })}`)
          }

          const [returnRows, returnItems] = await Promise.all([
            context.supabase.from('order_returns').select('*').eq('workspace_id', context.workspace.id).eq('order_id', order.id).eq('status', 'posted').eq('is_deleted', false),
            context.supabase.from('order_return_items').select('*').eq('workspace_id', context.workspace.id).eq('order_id', order.id).eq('is_deleted', false)
          ])
          if (returnRows.error || returnItems.error) {
            throw new Error(`Could not verify POS return audit rows: ${returnRows.error?.message ?? returnItems.error?.message}`)
          }
          const expectedItemIds = new Set((order.items ?? []).map((item) => item.id))
          if (returnRows.data?.length !== 1 || returnItems.data?.length !== expectedItemIds.size
            || returnItems.data.some((item) => !expectedItemIds.has(item.order_item_id) || item.return_id !== returnRows.data[0]?.id)) {
            throw new Error(`The POS full return did not create exactly one linked return and one audit item per order line: ${JSON.stringify({ returns: returnRows.data?.length, expectedItems: expectedItemIds.size, actualItems: returnItems.data?.length })}`)
          }
          if (!closeAmount(returnRows.data[0].refund_amount, order.total)) {
            throw new Error(`The POS full-return audit amount did not match the pre-return order total: expected ${order.total}, actual ${returnRows.data[0].refund_amount}.`)
          }

          const beforeLoans = actualBeforeCleanup?.loans ?? []
          const loanStateAfterReturn = await readQuickOrderLoanState(context, order.id)
          if (beforeLoans.length !== 1 || loanStateAfterReturn.loans.length !== 1
            || loanStateAfterReturn.loans[0].id !== beforeLoans[0]?.id
            || loanStateAfterReturn.loans[0].workspace_id !== context.workspace.id
            || loanStateAfterReturn.loans[0].order_id !== order.id
            || loanStateAfterReturn.loans[0].status !== 'cancelled'
            || !closeAmount(loanStateAfterReturn.loans[0].balance_amount, 0)
            || loanStateAfterReturn.installments.some((row) => row.status !== 'cancelled' || !closeAmount(row.balance_amount, 0))) {
            throw new Error(`The POS full return did not cancel the exact test-owned loan and its schedules: ${JSON.stringify({ loans: loanStateAfterReturn.loans, installments: loanStateAfterReturn.installments })}`)
          }

          const loanId = beforeLoans[0].id
          const now = new Date().toISOString()
          const deletedLoan = await context.supabase.from('loans').update({ is_deleted: true, updated_at: now, version: Number(loanStateAfterReturn.loans[0].version ?? 1) + 1 })
            .eq('workspace_id', context.workspace.id).eq('id', loanId).eq('order_id', order.id).eq('order_type', 'sales').eq('source', 'order').select('id').maybeSingle()
          if (deletedLoan.error || !deletedLoan.data) throw new Error(`Could not retire the returned test-owned loan: ${deletedLoan.error?.message ?? 'ownership check failed'}`)
          const scheduleIds = loanStateAfterReturn.installments.map((row) => row.id)
          if (scheduleIds.length) {
            const deletedSchedules = await context.supabase.from('loan_installments').update({ is_deleted: true, updated_at: now })
              .eq('workspace_id', context.workspace.id).eq('loan_id', loanId).in('id', scheduleIds).select('id,is_deleted')
            if (deletedSchedules.error || deletedSchedules.data?.length !== scheduleIds.length || deletedSchedules.data.some((row) => !row.is_deleted)) {
              throw new Error(`Could not retire every returned test-owned installment: ${deletedSchedules.error?.message ?? 'row-count or verification mismatch'}`)
            }
          }

          const inventoryRows = await context.supabase.from('inventory').select('id,workspace_id,product_id,storage_id,quantity,is_deleted,version')
            .eq('workspace_id', context.workspace.id).eq('product_id', fixture.id).eq('storage_id', scenario.source.id)
          if (inventoryRows.error || inventoryRows.data?.length !== 1
            || inventoryRows.data[0].is_deleted
            || !closeAmount(inventoryRows.data[0].quantity, baseline.rows.inventory[0].quantity, QUANTITY_EPSILON)) {
            throw new Error(`The POS return did not restore scenario inventory to its captured baseline: ${inventoryRows.error?.message ?? JSON.stringify(inventoryRows.data)}`)
          }
          report.inventory = { restored: true, throughPosReturn: true, inventory: inventoryRows.data[0] }
          report.return = { ...(completedFinancedReturn ?? {}), return: returnRows.data[0], items: returnItems.data }
          report.financing = { loans: loanStateAfterReturn.loans, installments: loanStateAfterReturn.installments, payments: loanStateAfterReturn.payments, transactions: loanStateAfterReturn.transactions, retiredForCleanup: true, errors: [] }
        } else if (order.status !== 'cancelled' || order.linked_loan_id) {
          const canceled = await context.supabase.rpc('cancel_order_with_financing', { p_order_type: 'sales', p_order_id: order.id })
          if (canceled.error) throw new Error(`Could not cancel the test-owned financed Quick Order: ${canceled.error.message}`)
        }
      } else {
        const payments = failIfError(await context.supabase.from('payment_transactions').select('*')
          .eq('workspace_id', context.workspace.id).eq('source_type', 'sales_order').eq('source_record_id', order.id), 'Could not load test-owned Quick Order payments for cleanup')
        for (const payment of payments.filter((row) => !row.is_deleted && !row.reversal_of_transaction_id && Number(row.amount) > 0)) {
          report.reversals.push(await reverseOrderPayment(context, payment, scenario.customer.marker))
        }
        const canceled = await context.supabase.schema('crm').from('sales_orders').update({
          status: 'cancelled', is_deleted: true, is_paid: false, payment_status: 'unpaid', paid_amount: 0,
          balance_amount: Number(order.total ?? 0), paid_at: null, initial_payment_amount: 0,
          linked_loan_id: null, updated_at: new Date().toISOString(), version: Number(order.version ?? 1) + 1
        }).eq('id', order.id).eq('workspace_id', context.workspace.id).eq('business_partner_id', scenario.customer.id)
          .eq('customer_id', scenario.customer.facetId).eq('created_by', context.user.id).eq('source_channel', 'manual')
          .select('id').maybeSingle()
        if (canceled.error || !canceled.data) throw new Error(`Could not retire test-owned Quick Order ${order.id}: ${canceled.error?.message ?? 'ownership check failed'}`)
      }

      if (!report.inventory?.throughPosReturn) {
        const expectedAfter = Number(baseline.rows.inventory[0].quantity) - (scenario.orderStatus === 'completed' ? 1 : 0)
        report.inventory = await restoreOwnedInventory(context,
          { id: fixture.id, storageId: scenario.source.id }, expectedAfter,
          Number(baseline.rows.inventory[0].quantity), order.id, scenario.customer.marker)
      }
      const tombstone = await context.supabase.schema('crm').from('sales_orders').update({ is_deleted: true, updated_at: new Date().toISOString() })
        .eq('id', order.id).eq('workspace_id', context.workspace.id).eq('business_partner_id', scenario.customer.id)
        .eq('created_by', context.user.id).select('id').maybeSingle()
      if (tombstone.error || !tombstone.data) throw new Error(`Could not hide the canceled test-owned Quick Order: ${tombstone.error?.message ?? 'ownership check failed'}`)
    } else if (orderId) {
      // Do not infer ownership from a request alone. Querying and proving no row
      // exists means there is no database object to clean.
      const exists = await context.supabase.schema('crm').from('sales_orders').select('id')
        .eq('workspace_id', context.workspace.id).eq('id', orderId).maybeSingle()
      if (exists.error) throw new Error(`Could not determine whether Quick Order ${orderId} persisted: ${exists.error.message}`)
      if (exists.data) throw new Error(`Refusing cleanup because Quick Order ${orderId} exists but ownership could not be proven.`)
    }
    if (!discardCustomer) await restoreCustomerSummaryBaseline(context, scenario.customer, baseline)

    const after = await queryQuickOrderRows(context, scenario.customer, fixture, baseline.accountIds)
    const errors = []
    const remainingActiveOrders = after.orders.filter((row) => !baseline.orderIds.includes(row.id) && !row.is_deleted)
    if (remainingActiveOrders.length) errors.push(`Cleanup left active Quick Order row(s): ${JSON.stringify(remainingActiveOrders.map((row) => ({ id: row.id, status: row.status, is_deleted: row.is_deleted })))}`)
    for (const before of baseline.rows.inventory) {
      const restored = after.inventory.find((row) => row.id === before.id)
      if (!restored || Math.abs(Number(restored.quantity) - Number(before.quantity)) > QUANTITY_EPSILON || Boolean(restored.is_deleted) !== Boolean(before.is_deleted)) {
        errors.push(`Quick Order cleanup did not restore inventory row ${before.id} to baseline.`)
      }
    }
    for (const before of baseline.rows.products) {
      const restored = after.products.find((row) => row.id === before.id)
      if (!restored || !closeAmount(restored.quantity, before.quantity, QUANTITY_EPSILON)
        || Boolean(restored.is_deleted) !== Boolean(before.is_deleted)) {
        errors.push(`Quick Order cleanup did not restore product summary ${before.id} to its baseline.`)
      }
    }
    for (const before of baseline.rows.accountBalances) {
      const restored = after.accountBalances.find((row) => row.account_id === before.account_id && row.currency === before.currency)
      if (!closeAmount(restored?.balance_amount ?? 0, before.balance_amount)) errors.push(`Quick Order cleanup did not restore account ${before.account_id}, currency ${before.currency} to its baseline balance.`)
    }
    const allOrderPayments = orderId
      ? failIfError(await context.supabase.from('payment_transactions').select('*').eq('workspace_id', context.workspace.id).eq('source_type', 'sales_order').eq('source_record_id', orderId), 'Could not verify Quick Order payment cleanup')
      : []
    const originals = allOrderPayments.filter((row) => !row.is_deleted && !row.reversal_of_transaction_id && Number(row.amount) > 0)
    for (const original of originals) {
      const reversals = allOrderPayments.filter((row) => !row.is_deleted && row.reversal_of_transaction_id === original.id)
      const net = Number(original.amount) + reversals.reduce((sum, row) => sum + Number(row.amount), 0)
      if (!reversals.length || !closeAmount(net, 0)) errors.push(`Quick Order payment ${original.id} did not net to zero after cleanup: ${JSON.stringify({ original, reversals, net })}`)
    }
    if (orderId && (scenario.method?.id === 'loan' || scenario.method?.id === 'installments')) {
      const activeLoans = failIfError(await context.supabase.from('loans').select('id,is_deleted,status,order_id,workspace_id')
        .eq('workspace_id', context.workspace.id).eq('order_id', orderId).eq('order_type', 'sales'), 'Could not verify linked-loan cleanup')
        .filter((row) => !row.is_deleted)
      if (activeLoans.length) errors.push(`Quick Order cleanup left active linked loans: ${JSON.stringify(activeLoans)}`)
      const beforeLoans = actualBeforeCleanup?.loans ?? []
      const loanStateAfter = await readQuickOrderLoanState(context, orderId)
      const financingErrors = []
      for (const beforeLoan of beforeLoans) {
        const afterLoan = loanStateAfter.loans.find((row) => row.id === beforeLoan.id)
        if (!afterLoan || !afterLoan.is_deleted || afterLoan.workspace_id !== context.workspace.id || afterLoan.order_id !== orderId) {
          financingErrors.push(`Loan ${beforeLoan.id} was not retained as a test-owned deleted loan record.`)
        }
        const beforePayments = (actualBeforeCleanup.loanPayments ?? []).filter((row) => row.loan_id === beforeLoan.id && !row.is_deleted)
        for (const beforePayment of beforePayments) {
          const afterPayment = loanStateAfter.payments.find((row) => row.id === beforePayment.id)
          if (!afterPayment || !afterPayment.is_deleted || !closeAmount(afterPayment.reversed_amount, beforePayment.amount) || !afterPayment.reversal_transaction_id) {
            financingErrors.push(`Loan repayment ${beforePayment.id} was not fully reversed during Quick Order cleanup: ${JSON.stringify(afterPayment ?? null)}`)
            continue
          }
          const original = loanStateAfter.transactions.find((row) => row.id === beforePayment.payment_transaction_id)
            ?? loanStateAfter.transactions.find((row) => row.source_subrecord_id === beforePayment.id
              && row.reversal_of_transaction_id == null && !row.is_deleted)
          if (!original) {
            financingErrors.push(`Loan repayment ${beforePayment.id} lost its retained original ledger transaction.`)
            continue
          }
          const reversals = loanStateAfter.transactions.filter((row) => !row.is_deleted && row.reversal_of_transaction_id === original.id)
          if (reversals.length !== 1 || reversals[0]?.id !== afterPayment.reversal_transaction_id
            || !closeAmount(Number(original.amount) + Number(reversals[0]?.amount), 0)
            || reversals[0]?.workspace_id !== context.workspace.id || reversals[0]?.source_record_id !== beforeLoan.id
            || reversals[0]?.source_subrecord_id !== beforePayment.id) {
            financingErrors.push(`Loan repayment ${beforePayment.id} did not retain exactly one correctly linked counter-entry: ${JSON.stringify({ original, reversals, payment: afterPayment })}`)
          }
        }
      }
      if (loanStateAfter.payments.some((row) => !row.is_deleted)) financingErrors.push(`Quick Order cleanup left active loan repayment rows: ${JSON.stringify(loanStateAfter.payments.filter((row) => !row.is_deleted))}`)
      if (loanStateAfter.installments.some((row) => !row.is_deleted)) financingErrors.push(`Quick Order cleanup left active loan schedule rows: ${JSON.stringify(loanStateAfter.installments.filter((row) => !row.is_deleted))}`)
      report.financing = { loans: loanStateAfter.loans, installments: loanStateAfter.installments, payments: loanStateAfter.payments, transactions: loanStateAfter.transactions, errors: financingErrors }
      errors.push(...financingErrors)
    }
    const partnerAfter = after.partner
    const customerAfter = after.customerFacet
    for (const [field, wanted, observed] of (discardCustomer ? [] : [
      ['business_partner.total_sales_orders', baseline.rows.partner?.total_sales_orders, partnerAfter?.total_sales_orders],
      ['business_partner.total_sales_value', baseline.rows.partner?.total_sales_value, partnerAfter?.total_sales_value],
      ['business_partner.receivable_balance', baseline.rows.partner?.receivable_balance, partnerAfter?.receivable_balance],
      ['business_partner.total_loan_count', baseline.rows.partner?.total_loan_count, partnerAfter?.total_loan_count],
      ['business_partner.loan_outstanding_balance', baseline.rows.partner?.loan_outstanding_balance, partnerAfter?.loan_outstanding_balance],
      ['customer.total_orders', baseline.rows.customerFacet?.total_orders, customerAfter?.total_orders],
      ['customer.total_spent', baseline.rows.customerFacet?.total_spent, customerAfter?.total_spent],
      ['customer.outstanding_balance', baseline.rows.customerFacet?.outstanding_balance, customerAfter?.outstanding_balance]
    ])) if (wanted != null && !closeAmount(wanted, observed)) errors.push(`Quick Order cleanup did not restore ${field}: expected ${wanted}, actual ${observed}.`)
    report.verification = {
      orderTombstones: after.orders.filter((row) => !baseline.orderIds.includes(row.id)),
      inventory: after.inventory,
      accountBalances: after.accountBalances,
      orderPayments: allOrderPayments,
      linkedLoans: orderId ? after.loans.filter((row) => row.order_id === orderId) : [],
      customerSummary: { partner: partnerAfter, customer: customerAfter }
    }
    report.errors.push(...errors)
    report.completed = errors.length === 0
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
  }
  return report
}

export async function cleanupQuickOrderCustomer(context, customer) {
  const { supabase, workspace } = context
  const errors = []
  const [orders, partners, customers] = await Promise.all([
    supabase.schema('crm').from('sales_orders').select('id,is_deleted,status').eq('workspace_id', workspace.id).eq('business_partner_id', customer.id),
    visibleBusinessPartners(context), visibleCustomers(context)
  ])
  if (orders.error) errors.push(`Could not verify Quick Order orders ownership: ${orders.error.message}`)
  let partner = partners.find((row) => row.id === customer.id) ?? null
  let facet = customers.find((row) => row.id === customer.facetId) ?? null
  const partnerOwnershipProven = (row) => row.workspace_id === workspace.id
    && row.role === 'customer' && row.partner_name === customer.name
    && row.phone === customer.phone && row.address === customer.address
    && row.customer_facet_id === customer.facetId
  const facetOwnershipProven = (row) => row.workspace_id === workspace.id
    && row.partner_name === customer.name && row.phone === customer.phone
    && row.address === customer.address && row.business_partner_id === customer.id
  if (partner && !partnerOwnershipProven(partner)) {
    errors.push('Refusing to clean Quick Order business partner because ownership or facet linkage cannot be proven.')
  }
  if (facet && !facetOwnershipProven(facet)) {
    errors.push('Refusing to clean Quick Order customer facet because ownership cannot be proven.')
  }
  const activeOrders = (orders.data ?? []).filter((row) => !row.is_deleted && row.status !== 'cancelled')
  if (activeOrders.length) errors.push(`Retaining the test-owned customer because active Quick Orders remain: ${JSON.stringify(activeOrders)}`)
  if (errors.length) return { completed: false, errors }

  try {
    if (facet) await syncPartnerEntity(context, { id: customer.facetId, customerFacet: true }, 'soft_delete')
    if (partner) await syncPartnerEntity(context, { id: customer.id }, 'soft_delete')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const [finalPartners, finalCustomers] = await Promise.all([visibleBusinessPartners(context), visibleCustomers(context)])
  const finalPartner = finalPartners.find((row) => row.id === customer.id)
  const finalFacet = finalCustomers.find((row) => row.id === customer.facetId)
  if (finalPartner || finalFacet) errors.push('Quick Order customer cleanup left an active partner or customer facet visible in the workspace.')
  return { completed: errors.length === 0, errors, customerId: customer.id, customerFacetId: customer.facetId, retainedForAuditReferences: true }
}

export async function cleanupPartialQuickOrderCustomer(context, runId, scenarioId = null) {
  const ownership = quickOrderCustomerOwnership(runId, scenarioId)
  const marker = ownership.marker
  let partners
  let customers
  try { [partners, customers] = await Promise.all([visibleBusinessPartners(context), visibleCustomers(context)]) }
  catch (error) { return { completed: false, errors: [`Could not inspect partially created Quick Order customer: ${error instanceof Error ? error.message : String(error)}`] } }
  const partnerRows = partners.filter((row) => row.workspace_id === context.workspace.id && row.role === 'customer'
    && row.partner_name === ownership.name && row.phone === ownership.phone && row.address === ownership.address)
  const facetRows = customers.filter((row) => row.workspace_id === context.workspace.id
    && row.partner_name === ownership.name && row.phone === ownership.phone && row.address === ownership.address)
  if (partnerRows.length > 1 || facetRows.length > 1) {
    return { completed: false, errors: ['Quick Order setup marker matched multiple customer rows; cleanup was refused.'] }
  }
  const partnerRow = partnerRows[0] ?? null
  const facetRow = facetRows[0] ?? null
  if (!partnerRow && !facetRow) return { completed: true, errors: [], partialCustomerRows: 0 }
  const partnerId = partnerRow?.id ?? facetRow?.business_partner_id
  if (partnerRow && (partnerRow.workspace_id !== context.workspace.id || partnerRow.role !== 'customer')) {
    return { completed: false, errors: ['Quick Order setup cleanup could not prove business-partner ownership.'] }
  }
  if (facetRow && (facetRow.workspace_id !== context.workspace.id || facetRow.business_partner_id !== partnerId)) {
    return { completed: false, errors: ['Quick Order setup cleanup could not prove customer-facet ownership.'] }
  }
  if (partnerId) {
    const orderRows = await context.supabase.schema('crm').from('sales_orders').select('id,status,is_deleted')
      .eq('workspace_id', context.workspace.id).eq('business_partner_id', partnerId)
    if (orderRows.error) return { completed: false, errors: [`Could not prove there are no orders before partial-customer cleanup: ${orderRows.error.message}`] }
    if ((orderRows.data ?? []).length) return { completed: false, errors: ['Quick Order setup cleanup refused because related orders already exist.'] }
  }
  const changedAt = new Date().toISOString()
  const errors = []
  try {
    if (facetRow) await syncPartnerEntity(context, { id: facetRow.id, customerFacet: true }, 'soft_delete')
    if (partnerRow) await syncPartnerEntity(context, { id: partnerRow.id }, 'soft_delete')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const [finalPartners, finalCustomers] = await Promise.all([visibleBusinessPartners(context), visibleCustomers(context)])
  if (finalPartners.some((row) => row.id === partnerRow?.id) || finalCustomers.some((row) => row.id === facetRow?.id)) {
    errors.push('Partial Quick Order customer cleanup left an active owned row visible.')
  }
  return { completed: errors.length === 0, errors, partialCustomerRows: Number(!!partnerRow) + Number(!!facetRow) }
}
