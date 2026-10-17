import { createHash } from 'node:crypto'

const CLEANUP_REQUIREMENTS = Object.freeze([
  'Delete run-owned draft orders through the Atlas order service and verify their soft-delete state in Supabase.',
  'Delete only the run-owned product and customer after dependent orders are cleaned.',
  'Retire storage only when this run created it, ownership is proven, and no active products depend on it.'
])

export const SALES_ORDER_SCENARIO_CATALOG = Object.freeze([
  {
    id: 'SO-HYB-001',
    name: 'Draft create and reload',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.draftCreateReload',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.draftCreateReload',
    domain: 'sales-order',
    coverage: ['lifecycle', 'relationships', 'persistence', 'inventory'],
    requiredCapabilities: ['orders', 'businessPartners', 'products', 'storages'],
    prerequisites: ['Verified Hybrid workspace', 'Authorized user with Sales Orders access', 'Run-owned customer and product fixture'],
    dimensions: { action: 'create-draft-reload', quantity: 1, unit: 'native', unitPrice: 100, currency: 'workspace-default', payment: 'unpaid' },
    expectedUi: ['Select the linked customer and product in the Sales Order form', 'Save the draft and reopen it after a browser reload'],
    expectedEffects: ['One draft with the selected customer and one line is persisted', 'No payment transaction or inventory movement is created'],
    assertions: ['Order count is exactly one', 'Order, line quantity, total, customer, and product match the prepared dimensions', 'Inventory and payment baselines are unchanged'],
    execution: 'draft'
  },
  {
    id: 'SO-HYB-002',
    name: 'Draft edit and reload',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.draftEditReload',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.draftEditReload',
    domain: 'sales-order',
    coverage: ['lifecycle', 'relationships', 'pricing', 'persistence'],
    requiredCapabilities: ['orders', 'businessPartners', 'products', 'storages'],
    prerequisites: ['Verified Hybrid workspace', 'Authorized user with Sales Orders access', 'Run-owned customer and product fixture'],
    dimensions: { action: 'edit-draft-reload', initialQuantity: 1, savedQuantity: 2, unitPrice: 100, currency: 'workspace-default', payment: 'unpaid' },
    expectedUi: ['Create a draft in the form', 'Edit its quantity, save, and reload the existing order'],
    expectedEffects: ['The original order ID remains stable', 'The persisted line quantity and total reflect the saved edit'],
    assertions: ['Exactly one order exists for the scenario marker', 'The same order ID has quantity 2 and the matching total after reload', 'No payment or inventory side effects are recorded'],
    execution: 'edit'
  },
  {
    id: 'SO-HYB-003',
    name: 'Draft cancellation',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.draftCancel',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.draftCancel',
    domain: 'sales-order',
    coverage: ['lifecycle', 'cancellation', 'inventory'],
    requiredCapabilities: ['orders', 'businessPartners', 'products', 'storages'],
    prerequisites: ['Verified Hybrid workspace', 'Authorized user with Sales Orders management permission', 'Run-owned customer and product fixture'],
    dimensions: { action: 'create-cancel-draft', quantity: 1, unitPrice: 100, currency: 'workspace-default', payment: 'unpaid' },
    expectedUi: ['Create an unpaid draft', 'Cancel it from the Sales Orders list and confirm in the application dialog'],
    expectedEffects: ['The existing order transitions from draft to cancelled', 'No payment or stock movement is posted'],
    assertions: ['The order retains its ID and becomes cancelled', 'Inventory and payment baselines remain unchanged'],
    execution: 'cancel'
  },
  {
    id: 'SO-HYB-004',
    name: 'Repeated save protection',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.repeatedSave',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.repeatedSave',
    domain: 'sales-order',
    coverage: ['failure-recovery', 'idempotency', 'persistence'],
    requiredCapabilities: ['orders', 'businessPartners', 'products', 'storages'],
    prerequisites: ['Verified Hybrid workspace', 'Authorized user with Sales Orders access', 'Run-owned customer and product fixture'],
    dimensions: { action: 'repeated-save', quantity: 1, unitPrice: 100, currency: 'workspace-default', payment: 'unpaid', submissions: 2 },
    expectedUi: ['Submit the same prepared draft twice through the Save Order control'],
    expectedEffects: ['At most one draft is created for the unique scenario marker'],
    assertions: ['One persisted order exists after repeated UI submission', 'No payment or inventory side effects are created'],
    execution: 'duplicate-save'
  },
  {
    id: 'SO-HYB-005',
    name: 'Service-only and mixed line orders',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.serviceOrders',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.serviceOrders',
    domain: 'sales-order',
    coverage: ['relationships', 'services', 'inventory'],
    requiredCapabilities: ['orders', 'services', 'products', 'storages'],
    prerequisites: ['Service feature enabled and exposed by the application workspace snapshot'],
    dimensions: {
      actions: ['service-only-draft', 'mixed-product-service-draft'],
      serviceQuantity: 1,
      serviceUnitPrice: 70,
      productQuantity: 2,
      productUnitPrice: 100,
      currency: 'workspace-default',
      payment: 'unpaid'
    },
    expectedUi: ['Select a service and, separately, a service plus product through the real order form'],
    expectedEffects: ['Service lines persist without stock movement'],
    assertions: ['Service-only and mixed lines persist with correct totals', 'Service-only flow creates no inventory movement'],
    execution: 'service-drafts'
  },
  {
    id: 'SO-HYB-006',
    name: 'Approval request and review',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.approval',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.approval',
    domain: 'sales-order',
    coverage: ['lifecycle', 'permissions', 'approval'],
    requiredCapabilities: ['orders', 'authorizedApproverIdentity'],
    prerequisites: ['Separate authorized staff requester and approver credentials in the dedicated test configuration'],
    dimensions: { actions: ['request', 'approve', 'reject'] },
    expectedUi: ['Request approval as staff and review using an authorized approver identity'],
    expectedEffects: ['Approval request state and subsequent review are persisted'],
    assertions: ['Only authorized roles can request, approve, or reject'],
    execution: 'unsupported'
  },
  {
    id: 'SO-HYB-007',
    name: 'Payment, refund, reversal, and financing',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.financial',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.financial',
    domain: 'sales-order',
    coverage: ['payments', 'ledger', 'payment-accounts', 'financing', 'returns'],
    requiredCapabilities: ['orders', 'payments'],
    prerequisites: ['Discovered payment methods and financing options', 'Verified reversals and audit-preserving cleanup plan'],
    dimensions: { actions: ['paid-on-creation', 'partial-payment', 'loan', 'installments', 'return', 'refund', 'reversal'] },
    expectedUi: ['Use the real payment, financing, return, refund, and reversal dialogs'],
    expectedEffects: ['Payment transactions, ledger entries, account movements, financing records, and counter-entries match each operation'],
    assertions: ['Exact persisted financial effects and no duplicate entries'],
    execution: 'unsupported'
  },
  {
    id: 'SO-HYB-008',
    name: 'Native Hybrid mirror and restart recovery',
    titleKey: 'devTesting.salesOrderHybrid.scenarioNames.nativeHybrid',
    descriptionKey: 'devTesting.salesOrderHybrid.scenarioDescriptions.nativeHybrid',
    domain: 'sales-order',
    coverage: ['hybrid-native', 'sqlite', 'restart-recovery'],
    requiredCapabilities: ['desktopHybridRuntime'],
    prerequisites: ['Atlas desktop runtime with Hybrid SQLite mirror and restart controls'],
    dimensions: { actions: ['disconnect', 'sync', 'restart', 'reconcile'] },
    expectedUi: ['Exercise the desktop runtime and reopen the application after a controlled interruption'],
    expectedEffects: ['Native SQLite, Dexie, and Supabase converge after recovery'],
    assertions: ['Native mirror and restart recovery are independently inspected'],
    execution: 'unsupported'
  }
])

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function signatureFor(scenario, capabilityFingerprint) {
  return createHash('sha256').update(canonical({
    id: scenario.id,
    coverage: scenario.coverage,
    requiredCapabilities: scenario.requiredCapabilities,
    prerequisites: scenario.prerequisites,
    dimensions: scenario.dimensions,
    expectedUi: scenario.expectedUi,
    expectedEffects: scenario.expectedEffects,
    assertions: scenario.assertions,
    cleanupRequirements: CLEANUP_REQUIREMENTS,
    capabilities: capabilityFingerprint
  })).digest('hex')
}

export function capabilityFingerprint(capabilities) {
  return createHash('sha256').update(canonical(capabilities)).digest('hex')
}

export function isSalesOrderHybridMode(dataMode) {
  return String(dataMode ?? '').toLowerCase() === 'hybrid'
}

export function selectPreparedSalesOrderScenarios(scenarioPlan, selection, expectedPlanId) {
  if (!selection || selection.planId !== expectedPlanId || !['all', 'from', 'only'].includes(selection.mode)) {
    throw new Error('The prepared Sales Order scenario plan is stale. Prepare the timeline again before running it.')
  }
  const runnable = scenarioPlan.filter((scenario) => scenario.status === 'pending')
  if (selection.mode === 'all') return runnable
  const index = scenarioPlan.findIndex((scenario) => scenario.id === selection.scenarioId)
  const selected = scenarioPlan[index]
  if (!selected || selected.signature !== selection.signature) {
    throw new Error('The selected scenario no longer matches the prepared dimensions. Prepare the timeline again.')
  }
  if (selected.status !== 'pending') throw new Error(selected.statusReason ?? 'This prepared scenario is unavailable in the selected workspace.')
  return selection.mode === 'only'
    ? [selected]
    : scenarioPlan.slice(index).filter((scenario) => scenario.status === 'pending')
}

export function buildSalesOrderHybridScenarioPlan(capabilities, { nativeDesktopVerified = false } = {}) {
  const fingerprint = capabilityFingerprint(capabilities)
  const scenarioPlan = SALES_ORDER_SCENARIO_CATALOG.map((scenario) => {
    const missing = scenario.requiredCapabilities.filter((key) => capabilities[key] !== true)
    const supported = scenario.execution !== 'unsupported'
    const nativeBlocked = scenario.id === 'SO-HYB-008' && !nativeDesktopVerified
    const unavailable = missing.length > 0
    const status = nativeBlocked ? 'blocked' : unavailable ? 'skipped' : (!supported ? 'blocked' : 'pending')
    const reasonKey = nativeBlocked
      ? 'devTesting.salesOrderHybrid.reasons.desktopRuntimeUnavailable'
      : unavailable
        ? `devTesting.salesOrderHybrid.reasons.capabilityUnavailable`
        : !supported
          ? `devTesting.salesOrderHybrid.reasons.runnerBoundary`
          : null
    const item = {
      ...structuredClone(scenario),
      name: scenario.name,
      signature: signatureFor(scenario, fingerprint),
      status,
      statusReason: reasonKey,
      missingCapabilities: missing,
      cleanupRequirements: [...CLEANUP_REQUIREMENTS],
      preparedDimensions: structuredClone(scenario.dimensions)
    }
    delete item.execution
    return item
  })
  const available = scenarioPlan.filter((scenario) => scenario.status === 'pending').map((scenario) => scenario.id)
  const skipped = scenarioPlan.filter((scenario) => scenario.status === 'skipped').map((scenario) => ({
    id: scenario.id,
    reason: 'devTesting.salesOrderHybrid.reasons.capabilityUnavailable',
    missingCapabilities: scenario.missingCapabilities
  }))
  const blocked = scenarioPlan.filter((scenario) => scenario.status === 'blocked').map((scenario) => ({
    id: scenario.id,
    reason: scenario.statusReason
  }))
  return {
    scenarioPlan,
    capabilityFingerprint: fingerprint,
    coverageSummary: {
      available,
      skipped,
      blocked,
      unverified: [
        'customer-product-unlink', 'completion-fulfillment', 'approval-rejection', 'quantity-boundaries', 'discounts',
        'payment-account-optional', 'payment-reversals', 'role-restrictions', 'plan-entitlements',
        'alternate-uom', 'currency-conversion', 'payment-ledger', 'financing', 'returns-refunds',
        'approval-roles', 'failed-request-retry', 'lost-response-recovery', 'native-sqlite', 'desktop-restart'
      ]
    }
  }
}
