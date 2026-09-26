import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SalesOrderTransactionGraph } from './salesOrderGraph'
import { resolveSalesOrderTransactionGraph } from './salesOrderGraph'
import { auditSalesOrderGraph, IntegrityAuditReadError, runSalesOrderIntegrityAudit } from './salesOrderAudit'
import { buildIntegrityAuditModel } from './auditModel'

vi.mock('./salesOrderGraph', () => ({ resolveSalesOrderTransactionGraph: vi.fn() }))

const workspaceId = 'workspace-1'
const orderId = 'order-1'
const itemA = { id: 'item-a', productId: 'product-a', productName: 'A', productSku: 'A', quantity: 4,
  freeBonusQuantity: 1, lineTotal: 40, originalCurrency: 'usd', originalUnitPrice: 10,
  convertedUnitPrice: 10, settlementCurrency: 'usd', costPrice: 5, convertedCostPrice: 5,
  storageId: 'storage-1', fulfilledQuantity: 5 }
const itemB = { ...itemA, id: 'item-b', productId: 'product-b', productName: 'B', productSku: 'B',
  quantity: 2, freeBonusQuantity: 0, lineTotal: 20, fulfilledQuantity: 2 }

function graph(): SalesOrderTransactionGraph {
  return {
    order: { id: orderId, workspaceId, orderNumber: '00001', status: 'completed', customerId: 'customer-1',
      businessPartnerId: 'partner-1', customerName: 'Customer', items: [{ ...itemA }, { ...itemB }], subtotal: 60,
      discount: 0, tax: 0, total: 60, currency: 'usd', paymentMethod: 'loan', initialPaymentAmount: 20,
      linkedLoanId: 'loan-1', paidAmount: 20, balanceAmount: 40, paymentStatus: 'partial', isPaid: false } as any,
    products: [
      { id: 'product-a', workspaceId, isService: false },
      { id: 'product-b', workspaceId, isService: false }
    ] as any,
    customers: [{ id: 'customer-1', workspaceId }], partners: [{ id: 'partner-1', workspaceId }],
    inventoryMovements: [
      { id: 'movement-a', workspaceId, referenceId: orderId, referenceType: 'sales_order', productId: 'product-a', storageId: 'storage-1', transactionType: 'sale', quantityDelta: -5, previousQuantity: 10, newQuantity: 5 },
      { id: 'movement-b', workspaceId, referenceId: orderId, referenceType: 'sales_order', productId: 'product-b', storageId: 'storage-1', transactionType: 'sale', quantityDelta: -2, previousQuantity: 10, newQuantity: 8 }
    ] as any,
    payments: [{ id: 'payment-1', workspaceId, sourceType: 'simple_loan', sourceRecordId: 'loan-1', amount: 20,
      currency: 'usd', paymentMethod: 'cash', direction: 'incoming', metadata: { isOrderLoanInitialRepayment: true } }] as any,
    accountMovements: [], paymentAccounts: [],
    loans: [{ id: 'loan-1', workspaceId, orderId, orderType: 'sales', source: 'order', linkedPartyId: 'partner-1',
      principalAmount: 60, totalPaidAmount: 20, balanceAmount: 40, settlementCurrency: 'usd', status: 'active' }] as any,
    loanPayments: [{ id: 'repayment-1', workspaceId, loanId: 'loan-1', amount: 20, paymentTransactionId: 'payment-1' }] as any,
    loanInstallments: [], orderInstallments: [], returns: [], returnItems: [],
    assignments: [], commissions: [], productCommissions: []
  }
}

function failures(value: SalesOrderTransactionGraph) {
  return auditSalesOrderGraph(value, workspaceId, orderId).checks.filter(check => check.status === 'FAIL')
}

describe('Sales Order integrity reconciliation', () => {
  beforeEach(() => vi.mocked(resolveSalesOrderTransactionGraph).mockReset())
  it('reconstructs the paid value and bonus inventory from historical order evidence', () => {
    const value = graph()
    expect(failures(value)).toEqual([])
    const audit = auditSalesOrderGraph(value, workspaceId, orderId)
    expect(audit.expected.inventory).toEqual({ 'product-a:storage-1': -5, 'product-b:storage-1': -2 })
    expect(audit.expected.paidAmount).toBe(20)
  })

  it('detects independent inventory, loan, payment and line arithmetic mismatches', () => {
    const value = graph()
    value.inventoryMovements[0].quantityDelta = -4
    value.inventoryMovements[0].newQuantity = 6
    value.loans[0].balanceAmount = 60
    value.order!.items[1].lineTotal = 21
    value.order!.paidAmount = 0
    expect(failures(value).map(check => check.code)).toEqual(expect.arrayContaining([
      'INVENTORY_QUANTITY_MISMATCH', 'LOAN_BALANCE_MISMATCH', 'ITEM_TOTAL_MISMATCH', 'ORDER_PAID_MISMATCH'
    ]))
  })

  it('uses historical unit factors and three-decimal order rounding', () => {
    const value = graph()
    value.order!.items[0] = { ...value.order!.items[0], unitFactor: 1.5,
      inventoryQuantity: 6, freeBonusInventoryQuantity: 1.5, fulfilledQuantity: 7.5,
      convertedUnitPrice: 10.0001 }
    value.inventoryMovements[0].quantityDelta = -7.5
    value.inventoryMovements[0].newQuantity = 2.5
    expect(failures(value)).toEqual([])
    expect(auditSalesOrderGraph(value, workspaceId, orderId).expected.inventory).toMatchObject({ 'product-a:storage-1': -7.5 })
  })

  it('subtracts a valid payment reversal without treating the counter-entry as duplicate income', () => {
    const value = graph()
    value.order = { ...value.order!, paymentMethod: 'cash', linkedLoanId: null, initialPaymentAmount: 0,
      paidAmount: 40, balanceAmount: 20 }
    value.loans = []
    value.loanPayments = []
    value.payments = [
      { id: 'original', workspaceId, sourceType: 'sales_order', sourceRecordId: orderId,
        amount: 60, currency: 'usd', paymentMethod: 'cash', direction: 'incoming' },
      { id: 'reversal', workspaceId, sourceType: 'sales_order', sourceRecordId: orderId,
        amount: -20, currency: 'usd', paymentMethod: 'cash', direction: 'incoming', reversalOfTransactionId: 'original' }
    ] as any
    expect(failures(value)).toEqual([])
  })

  it('reconciles a selected payment account through its derived movement', () => {
    const value = graph()
    value.payments[0].accountId = 'account-1'
    value.paymentAccounts = [{ id: 'account-1', workspaceId }] as any
    value.accountMovements = [{ id: 'payment-1', workspaceId, accountId: 'account-1',
      paymentTransactionId: 'payment-1', amount: 20, deltaAmount: 20, currency: 'usd' }] as any
    expect(failures(value)).toEqual([])
    value.accountMovements[0].deltaAmount = 10
    expect(failures(value).map(check => check.code)).toContain('PAYMENT_ACCOUNT_DELTA_MISMATCH')
  })

  it('catches a loan pointing to another order and duplicate inventory movements', () => {
    const value = graph()
    value.loans[0].orderId = 'other-order'
    value.inventoryMovements.push({ ...value.inventoryMovements[0], id: 'duplicate' })
    expect(failures(value).map(check => check.code)).toEqual(expect.arrayContaining([
      'LOAN_MISSING', 'WRONG_LOAN_REFERENCE', 'INVENTORY_MOVEMENT_DUPLICATE'
    ]))
  })

  it('reconstructs loan balance from the order even when wrong principal and balance agree', () => {
    const value = graph()
    value.loans[0].principalAmount = 70
    value.loans[0].balanceAmount = 50
    expect(failures(value).map(check => check.code)).toEqual(expect.arrayContaining([
      'LOAN_PRINCIPAL_MISMATCH', 'LOAN_BALANCE_MISMATCH'
    ]))
  })

  it('detects a mismatch between the initial payment and its cash transaction', () => {
    const value = graph()
    value.order!.initialPaymentAmount = 25
    expect(failures(value).map(check => check.code)).toContain('INITIAL_PAYMENT_MISMATCH')
  })

  it('does not require an unpaid non-financed order to store its derived outstanding amount', () => {
    const value = graph()
    value.order = { ...value.order!, paymentMethod: 'cash', linkedLoanId: null, initialPaymentAmount: 0,
      paidAmount: 0, balanceAmount: 0, paymentStatus: 'unpaid', isPaid: false }
    value.loans = []
    value.loanPayments = []
    value.payments = []
    const audit = auditSalesOrderGraph(value, workspaceId, orderId)
    expect(audit.expected.derivedOutstandingAmount).toBe(60)
    expect(audit.checks.some(check => check.code === 'ORDER_BALANCE_MISMATCH')).toBe(false)
    expect(audit.checks.filter(check => check.status === 'FAIL')).toEqual([])
  })

  it('rounds a zero-payment order’s derived outstanding amount without requiring a cached balance', () => {
    const value = graph()
    value.order = { ...value.order!, paymentMethod: 'cash', linkedLoanId: null, initialPaymentAmount: 0,
      paidAmount: 0, balanceAmount: 0, paymentStatus: 'unpaid', isPaid: false,
      subtotal: 60.124, total: 60.124,
      items: [{ ...value.order!.items[0], convertedUnitPrice: 10.0309, lineTotal: 40.124 }, value.order!.items[1]] }
    value.loans = []
    value.loanPayments = []
    value.payments = []
    const audit = auditSalesOrderGraph(value, workspaceId, orderId)
    expect(audit.expected.derivedOutstandingAmount).toBe(60.124)
    expect(audit.checks.some(check => check.code === 'ORDER_BALANCE_MISMATCH')).toBe(false)
  })

  it('uses the loan as receivable evidence when a financed order is fully unpaid', () => {
    const value = graph()
    value.order = { ...value.order!, initialPaymentAmount: 0, paidAmount: 0,
      balanceAmount: 0, paymentStatus: 'unpaid', isPaid: false }
    value.payments = []
    value.loanPayments = []
    value.loans[0].totalPaidAmount = 0
    value.loans[0].balanceAmount = 60
    const audit = auditSalesOrderGraph(value, workspaceId, orderId)
    expect(audit.expected.derivedOutstandingAmount).toBe(60)
    expect(audit.checks.some(check => check.code === 'ORDER_BALANCE_MISMATCH')).toBe(false)
    expect(audit.checks.filter(check => check.status === 'FAIL')).toEqual([])
  })

  it('still validates the stored balance after a non-financed payment is recorded', () => {
    const value = graph()
    value.order = { ...value.order!, paymentMethod: 'cash', linkedLoanId: null, initialPaymentAmount: 0,
      paidAmount: 20, balanceAmount: 0, paymentStatus: 'partial', isPaid: false }
    value.loans = []
    value.loanPayments = []
    value.payments = [{ id: 'cash-payment', workspaceId, sourceType: 'sales_order', sourceRecordId: orderId,
      amount: 20, currency: 'usd', paymentMethod: 'cash', direction: 'incoming' }] as any
    const balance = failures(value).find(check => check.code === 'ORDER_BALANCE_MISMATCH')
    expect(balance).toMatchObject({ expected: 40, actual: 0 })
  })

  it('treats a posted partial return as a valid net inventory and loan change', () => {
    const value = graph()
    value.order = { ...value.order!, total: 50, subtotal: 50, originalTotalAmount: 60,
      returnedAmount: 10, returnStatus: 'partial', balanceAmount: 30,
      items: [{ ...value.order!.items[0], returnedQuantity: 1 }, value.order!.items[1]] }
    value.loans[0].principalAmount = 50
    value.loans[0].balanceAmount = 30
    value.returns = [{ id: 'return-1', workspaceId, orderId, refundAmount: 10, status: 'posted' }] as any
    value.returnItems = [{ id: 'return-item-1', workspaceId, returnId: 'return-1', orderId,
      orderItemId: 'item-a', quantity: 1, inventoryQuantity: 1, paidInventoryQuantity: 1,
      freeInventoryQuantity: 0, restoredStorageId: 'storage-1', refundAmount: 10 }] as any
    expect(failures(value)).toEqual([])
    expect(auditSalesOrderGraph(value, workspaceId, orderId).expected.inventoryNet).toEqual({
      'product-a:storage-1': -4, 'product-b:storage-1': -2
    })
    value.loans[0].principalAmount = 60
    value.loans[0].balanceAmount = 40
    expect(failures(value).map(check => check.code)).toEqual(expect.arrayContaining([
      'LOAN_PRINCIPAL_MISMATCH', 'LOAN_BALANCE_MISMATCH'
    ]))
  })

  it('reports missing historical inventory evidence as a warning rather than a fabricated pass', () => {
    const value = graph()
    value.inventoryMovements = []
    const checks = auditSalesOrderGraph(value, workspaceId, orderId).checks
    expect(checks.filter(check => check.code === 'INVENTORY_MOVEMENT_MISSING').map(check => check.status)).toEqual(['WARNING', 'WARNING'])
  })

  it('keeps authoritative integrity separate from Hybrid SQLite mirror discrepancies', async () => {
    const source = graph()
    const mirror = graph()
    mirror.loans[0].balanceAmount = 60
    vi.mocked(resolveSalesOrderTransactionGraph).mockImplementation(async (_workspace, _order, target) => target === 'supabase' ? source : mirror)
    const result = await runSalesOrderIntegrityAudit(workspaceId, orderId, 'hybrid')
    expect(result.integrityStatus).toBe('PASS')
    expect(result.mirrorStatus).toBe('FAIL')
    expect(buildIntegrityAuditModel(result).actual.sqliteMirror?.loans[0].balanceAmount).toBe(60)
    expect(result.checks).toContainEqual(expect.objectContaining({ category: 'mirror', code: 'SQLITE_MIRROR_FIELD_MISMATCH', entityType: 'loans.balanceAmount', expected: 40, actual: 60 }))
    expect(resolveSalesOrderTransactionGraph).toHaveBeenNthCalledWith(1, workspaceId, orderId, 'supabase')
    expect(resolveSalesOrderTransactionGraph).toHaveBeenNthCalledWith(2, workspaceId, orderId, 'sqlite')
  })

  it('uses SQLite as the only source in Local mode', async () => {
    vi.mocked(resolveSalesOrderTransactionGraph).mockResolvedValue(graph())
    const result = await runSalesOrderIntegrityAudit(workspaceId, orderId, 'local')
    expect(result.sourceOfTruth).toBe('sqlite')
    expect(result.mirrorStatus).toBeNull()
    expect(resolveSalesOrderTransactionGraph).toHaveBeenCalledOnce()
    expect(resolveSalesOrderTransactionGraph).toHaveBeenCalledWith(workspaceId, orderId, 'sqlite')
  })

  it('exposes a complete JSON audit model from the same run without persisting it', async () => {
    vi.mocked(resolveSalesOrderTransactionGraph).mockResolvedValue(graph())
    const result = await runSalesOrderIntegrityAudit(workspaceId, orderId, 'local')
    const model = JSON.parse(JSON.stringify(buildIntegrityAuditModel(result)))
    expect(model).toMatchObject({
      schemaVersion: 1,
      transaction: { type: 'sales_order', id: orderId, number: '00001', workspaceId, status: 'completed', currency: 'usd' },
      sourceOfTruth: 'sqlite',
      expected: { orderTotal: 60, paidAmount: 20, inventory: { 'product-a:storage-1': -5 } },
      actual: { authoritative: { order: { id: orderId }, loans: [{ id: 'loan-1' }] }, sqliteMirror: null },
      summary: { integrityStatus: 'PASS', mirrorStatus: null }
    })
    expect(model.checks).toEqual(result.checks)
    expect(model.auditedAt).toBe(result.auditedAt)
  })

  it('turns a denied authoritative read into a localized, fail-closed audit error', async () => {
    vi.mocked(resolveSalesOrderTransactionGraph).mockRejectedValueOnce(new Error('permission denied'))
    vi.mocked(resolveSalesOrderTransactionGraph).mockResolvedValue(graph())
    let failure: unknown
    try { await runSalesOrderIntegrityAudit(workspaceId, orderId, 'cloud') } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(IntegrityAuditReadError)
    expect(failure).toMatchObject({
      code: 'AUDIT_SOURCE_READ_FAILED', source: 'supabase', messageKey: 'transactionAudit.loadFailed'
    } satisfies Partial<IntegrityAuditReadError>)
    expect(resolveSalesOrderTransactionGraph).toHaveBeenCalledOnce()
  })
})
