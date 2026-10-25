import type {
  AgentCommissionEntry,
  AgentProductCommissionEntry,
  InstallmentSale,
  Loan,
  LoanPayment,
  OrderPaymentMethod,
  PartnerSettlementOperation,
  OrderReturn,
  OrderReturnItem,
  PaymentObligation,
  PaymentTransaction,
  PurchaseOrder,
  SalesOrder
} from '../local-db/models.ts'
import { formatDirectTransactionVoucherNumber } from './directTransactionVoucher.ts'
import { getCommissionEntryMode, isPayableCommissionEntry } from '../local-db/commissionMode.ts'

type StatementOrder = SalesOrder | PurchaseOrder

export type PartnerAccountStatementPeriod = {
  type: 'today' | 'month' | 'lastMonth' | 'allTime' | 'custom'
  start?: string
  end?: string
}

/** Immutable product-line snapshot used to present a financed POS sale. */
export type PartnerAccountStatementPosSaleItem = {
  id: string
  productName: string | null
  quantity: number
  unit: string | null
  lineTotal: number
}

/** Sales created by a Seller's linked user are shown as informational activity.
 * They describe the Seller's work, but the customer remains the financial
 * counterparty, so these rows do not change the Seller partner balance.
 */
export type PartnerAccountStatementAgentSaleActivity = {
  id: string
  date: string
  reference: string
  saleKind: 'sales_order' | 'pos_sale' | 'installment_sale'
  descriptionKey:
    | 'sellerCreatedSalesOrder'
    | 'sellerCreatedPosSale'
    | 'sellerCreatedInstallmentSale'
    | 'sellerReturnedSalesOrder'
    | 'sellerReturnedPosSale'
  amount: number
  currency: string
  relatedReturnId?: string | null
  returnReason?: string | null
  source:
    | { recordType: 'order'; recordId: string }
    | { recordType: 'sale'; recordId: string }
    | { recordType: 'installment_sale'; recordId: string }
}

/**
 * The source records needed to create a partner subledger. This deliberately
 * contains source data rather than stored balances: both the screen and the
 * printout must be calculated from the same auditable activity.
 */
export type PartnerAccountStatementData = {
  partnerId?: string | null
  period: PartnerAccountStatementPeriod
  /**
   * Expands sales orders and their returns into product-level rows. This is
   * required for agent sales accounts, while ordinary partner statements
   * keep the historical one-row-per-document presentation by default.
   */
  itemizeSalesOrders?: boolean
  /** Expands active POS-sale loans into their original sold product lines. */
  itemizePosSaleLoans?: boolean
  /** Enables product-commission columns on an eligible agent statement. */
  isAgentCommissionStatement?: boolean
  /** Marks Seller mode so its activity table can show sales totals without account-balance columns. */
  isSellerAgentStatement?: boolean
  /** Agent IDs linked to the selected partner, used to apply agent return-refund balance rules. */
  salesAccountAgentIds?: string[]
  /** Tracked commission journal rows used for reporting totals, kept out of balances. */
  trackedCommissionEntries?: AgentCommissionEntry[]
  salesOrders: SalesOrder[]
  salesOrderReturns?: OrderReturn[]
  salesOrderReturnItems?: OrderReturnItem[]
  purchaseOrders: PurchaseOrder[]
  statementOrders?: StatementOrder[]
  loans?: Loan[]
  loanPayments?: LoanPayment[]
  installmentSales?: InstallmentSale[]
  linkedOrderCodes?: Record<string, string>
  /** POS-sale references for loans created from a POS sale. */
  linkedPosSaleCodes?: Record<string, string>
  /** Sales created by a linked Seller user, shown without changing the balance. */
  agentCreatedSalesActivities?: PartnerAccountStatementAgentSaleActivity[]
  /** Original POS sale lines, keyed by POS sale ID. */
  posSaleItemsBySaleId?: Record<string, PartnerAccountStatementPosSaleItem[]>
  settlementTransactions?: PaymentTransaction[]
  /** All payment rows linked to loan repayments, used to group their separate statement projection. */
  loanPaymentTransactions?: PaymentTransaction[]
  /** User action headers paired with grouped payment transaction members. */
  settlementOperations?: PartnerSettlementOperation[]
  /** Commission activity is included only for a sales-account agent's own statement. */
  agentCommissionEntries?: AgentCommissionEntry[]
  /** Historical product-line snapshots for an eligible agent statement. */
  agentProductCommissionEntries?: AgentProductCommissionEntry[]
  /**
   * Marketplace orders whose product commission belongs to the delivery agent.
   * They are informational statement rows: the marketplace customer remains
   * the order counterparty, so its sales total must not enter the agent's
   * partner balance.
   */
  marketplaceDeliveryProductCommissionOrderIds?: string[]
  /** Marketplace orders whose product commission belongs to the shipping actor. */
  marketplaceShippingProductCommissionOrderIds?: string[]
  /** Server-computed ledger for period-scoped remote statement reads. */
  precomputedLedgers?: PartnerAccountStatementCurrencyLedger[]
}

export type PartnerAccountStatementEntryKind =
  'sales_order' | 'sales_order_return' | 'purchase_order' | 'incoming_payment' | 'outgoing_payment' | 'direct_transaction' | 'loan_disbursal' | 'loan_repayment' | 'pos_sale_loan' | 'pos_sale_installment_loan' | 'installment_sale' | 'agent_sales_activity' | 'agent_commission' | 'partner_settlement'

export type PartnerAccountStatementEntryDescriptionKey =
'salesOrder' | 'salesOrderReturn' | 'purchaseOrder' | 'paymentReceived' | 'advancePaymentReceived' | 'orderLoanDownPaymentReceived' | 'paymentMade' | 'commissionPaid' | 'commissionRecovered' | 'commissionSettledAutomatically' | 'commissionEarned' | 'commissionReversed' | 'commissionAdjustment' | 'marketplaceDeliveryProductCommission' | 'marketplaceShippingProductCommission' | 'directReceipt' | 'directPayment' | 'saleOrderByPaymentMethod' | 'purchaseOrderByPaymentMethod' | 'posSaleLoanProvided' | 'posSaleLoanReceived' | 'loanProvided' | 'loanReceived' | 'loanRepaymentReceived' | 'loanRepaymentMade' | 'installmentSale' | 'sellerCreatedSalesOrder' | 'sellerCreatedPosSale' | 'sellerCreatedInstallmentSale' | 'sellerReturnedSalesOrder' | 'sellerReturnedPosSale' | 'paymentReversal' | 'orderReturnRefund' | 'loanRepaymentRefund' | 'financingDownPaymentRefund' | 'fullSaleReturnRefund' | 'returnCredit' | 'cashCollection' | 'cashPaid' | 'partnerSettlement'

export type PartnerAccountStatementEntrySource =
  { recordType: 'order'; recordId: string } | { recordType: 'loan'; recordId: string; loanCategory: Loan['loanCategory'] } | { recordType: 'installment_sale'; recordId: string } | { recordType: 'sale'; recordId: string } | { recordType: 'payment_transaction'; recordId: string }

export type PartnerAccountStatementEntry = {
  id: string
  date: string
  reference: string
  kind: PartnerAccountStatementEntryKind
  description: string
  descriptionKey?: PartnerAccountStatementEntryDescriptionKey
  /** The order's selected payment method, retained for its statement label. */
  paymentMethod?: OrderPaymentMethod | 'unknown'
  note?: string | null
  /** A persisted return-reason code or custom return reason, localized only when displayed. */
  returnReason?: string | null
  /** Product line information for sales and return activity. */
  itemName?: string | null
  quantity?: number | null
  unit?: string | null
  /** Historical commission explanation for agent product rows; never changes the account delta. */
  commissionPerProduct?: number | null
  totalProductCommission?: number | null
  /** Informational Seller sales amount; excluded from debit, credit, and balance. */
  salesActivityAmount?: number | null
  currency: string
  /** Positive movements increase the amount due from the partner. */
  delta: number
  /** The underlying document, when this statement row originates from one. */
  source?: PartnerAccountStatementEntrySource
  /** Rows created by the same posted return are highlighted together in the statement. */
  relatedReturnId?: string | null
  settlementOperationId?: string | null
  settlementOperation?: Pick<
    PartnerSettlementOperation,
    'id' | 'partnerNameSnapshot' | 'direction' | 'paidAt' | 'paymentMethod' | 'note' | 'status'
  >
}

export type PartnerAccountStatementCurrencyLedger = {
  currency: string
  openingBalance: number
  /** Net total of the period's product commission snapshots in this currency. */
  productCommissionTotal: number
  debitTotal: number
  creditTotal: number
  closingBalance: number
  entries: Array<PartnerAccountStatementEntry & { runningBalance: number }>
}

export function getPartnerAccountStatementSalesActivityTotal(
  ledger: Pick<PartnerAccountStatementCurrencyLedger, 'entries'>
) {
  return roundStatementAmount(ledger.entries.reduce(
    (total, entry) => total + Number(entry.salesActivityAmount || 0),
    0
  ))
}

export type PartnerAccountStatementSellerReturnRecord = {
  id: string
  status?: string | null
  isDeleted?: boolean
  returnedAt?: string | null
  createdAt?: string | null
  refundAmount?: number | null
  reason?: string | null
}

/** Creates signed Seller counter-rows from the immutable return records. */
export function createPartnerAccountStatementSellerReturnActivities(input: {
  saleId: string
  saleKind: 'sales_order' | 'pos_sale'
  saleReference: string
  currency: string
  returnedAmount?: number | null
  fallbackDate?: string | null
  returns: readonly PartnerAccountStatementSellerReturnRecord[]
  source:
    | { recordType: 'order'; recordId: string }
    | { recordType: 'sale'; recordId: string }
}) {
  const postedReturns = input.returns.filter((item) => (
    !item.isDeleted && (!item.status || item.status === 'posted')
  ))
  const recordedReturnTotal = postedReturns.reduce(
    (total, item) => total + Math.abs(Number(item.refundAmount || 0)),
    0
  )
  const hasReturnedAmount = input.returnedAmount != null
    && Number.isFinite(Number(input.returnedAmount))
  const targetReturnTotal = hasReturnedAmount
    ? Math.max(0, Number(input.returnedAmount))
    : recordedReturnTotal
  const returnScale = recordedReturnTotal > targetReturnTotal && recordedReturnTotal > 0
    ? targetReturnTotal / recordedReturnTotal
    : 1
  const descriptionKey = input.saleKind === 'sales_order'
    ? 'sellerReturnedSalesOrder' as const
    : 'sellerReturnedPosSale' as const
  const activities: PartnerAccountStatementAgentSaleActivity[] = postedReturns.flatMap((item) => {
    const amount = Math.abs(Number(item.refundAmount || 0)) * returnScale
    if (amount <= 0.000001) return []
    return [{
      id: `return:${item.id}`,
      date: item.returnedAt || item.createdAt || input.fallbackDate || '',
      reference: `${input.saleReference} · ${item.id.slice(0, 8).toUpperCase()}`,
      saleKind: input.saleKind,
      descriptionKey,
      amount: -amount,
      currency: input.currency,
      relatedReturnId: item.id,
      returnReason: item.reason || null,
      source: input.source
    }]
  })

  const visibleRecordedTotal = Math.min(recordedReturnTotal, targetReturnTotal)
  const unrecordedReturnTotal = Math.max(0, targetReturnTotal - visibleRecordedTotal)
  if (unrecordedReturnTotal > 0.000001) {
    const latestReturn = postedReturns
      .slice()
      .sort((left, right) => (right.returnedAt || right.createdAt || '').localeCompare(left.returnedAt || left.createdAt || ''))[0]
    activities.push({
      id: `return:aggregate:${input.saleId}`,
      date: latestReturn?.returnedAt || latestReturn?.createdAt || input.fallbackDate || '',
      reference: `${input.saleReference} · Return`,
      saleKind: input.saleKind,
      descriptionKey,
      amount: -unrecordedReturnTotal,
      currency: input.currency,
      relatedReturnId: latestReturn?.id || null,
      returnReason: latestReturn?.reason || null,
      source: input.source
    })
  }

  return activities
}

/**
 * The current, signed balance for each original currency in a partner's
 * account statement. A positive amount is due from the partner; a negative
 * amount is due to the partner.
 */
export type PartnerAccountStatementClosingBalance = Pick<
  PartnerAccountStatementCurrencyLedger,
  'currency' | 'closingBalance'
>

function isSalesOrder(order: StatementOrder): order is SalesOrder {
  return 'customerId' in order
}

function eventDate(value: string | null | undefined) {
  const parsed = value ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}

function periodStart(period: PartnerAccountStatementPeriod) {
  return eventDate(period.start)
}

function periodEndExclusive(period: PartnerAccountStatementPeriod) {
  if (!period.end) return null
  const parsed = eventDate(period.end)
  if (!parsed) return null

  // Custom date pickers provide YYYY-MM-DD. Treat that end date as inclusive.
  if (/^\d{4}-\d{2}-\d{2}$/.test(period.end)) {
    parsed.setDate(parsed.getDate() + 1)
    return parsed
  }

  return new Date(parsed.getTime() + 1)
}

function isIncludedInPeriod(value: string, period: PartnerAccountStatementPeriod) {
  const date = eventDate(value)
  if (!date) return false
  const start = periodStart(period)
  const end = periodEndExclusive(period)
  return (!start || date >= start) && (!end || date < end)
}

/**
 * Uses the tracked commission journal for report totals. Report pages use the
 * same event timestamp and period boundaries so their figures reconcile.
 */
export function sumTrackedCommissionEntriesByCurrency(
  entries: readonly AgentCommissionEntry[],
  agentIds: readonly string[] | undefined,
  period: PartnerAccountStatementPeriod
): Record<string, number> {
  const includedAgentIds = agentIds ? new Set(agentIds) : null
  const totals: Record<string, number> = {}

  for (const entry of entries) {
    if (entry.isDeleted || getCommissionEntryMode(entry) !== 'tracked') continue
    if (includedAgentIds && !includedAgentIds.has(entry.agentId)) continue
    if (!['accrual', 'reversal', 'adjustment'].includes(entry.kind)) continue
    if (!isIncludedInPeriod(entry.occurredAt, period)) continue

    const currency = entry.currency.toLowerCase()
    totals[currency] = (totals[currency] || 0) + Number(entry.amount || 0)
  }

  return totals
}

function isBeforePeriod(value: string, period: PartnerAccountStatementPeriod) {
  const date = eventDate(value)
  const start = periodStart(period)
  return Boolean(date && start && date < start)
}

function compareEntries(left: PartnerAccountStatementEntry, right: PartnerAccountStatementEntry) {
  const dateDifference = new Date(left.date).getTime() - new Date(right.date).getTime()
  const referenceDifference = left.reference.localeCompare(right.reference)
  if (dateDifference || referenceDifference) return dateDifference || referenceDifference
  if (left.kind === 'sales_order_return' && right.kind === 'loan_repayment') return -1
  if (left.kind === 'loan_repayment' && right.kind === 'sales_order_return') return 1
  return left.id.localeCompare(right.id)
}

function paymentKind(transaction: PaymentTransaction): PartnerAccountStatementEntryKind {
  if (transaction.sourceType === 'direct_transaction') return 'direct_transaction'
  return transaction.direction === 'incoming' ? 'incoming_payment' : 'outgoing_payment'
}

function paymentDescription(transaction: PaymentTransaction): {
  description: string
  descriptionKey?: PartnerAccountStatementEntryDescriptionKey
} {
  if (transaction.sourceType === 'direct_transaction') {
    const reason = metadataText(transaction.metadata, 'reason') || transaction.referenceLabel?.trim()
    if (reason) return { description: reason }

    return transaction.direction === 'incoming'
      ? { description: 'Direct receipt', descriptionKey: 'directReceipt' }
      : { description: 'Direct payment', descriptionKey: 'directPayment' }
  }

  return transaction.direction === 'incoming'
    ? { description: 'Payment received', descriptionKey: 'paymentReceived' }
    : { description: 'Payment made', descriptionKey: 'paymentMade' }
}

function metadataText(metadata: PaymentTransaction['metadata'], key: string) {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function metadataFlag(metadata: PaymentTransaction['metadata'], key: string) {
  return metadata?.[key] === true
}

function isSalesAccountAgentPartialReturnReversal(
  transaction: PaymentTransaction,
  salesOrdersById: Map<string, SalesOrder>,
  salesAccountAgentIds: Set<string>
) {
  if (
    transaction.sourceType !== 'sales_order' ||
    transaction.direction !== 'incoming' ||
    Number(transaction.amount || 0) >= 0 ||
    !transaction.reversalOfTransactionId
  ) return false

  const hasOrderReturnReference = Boolean(
    metadataText(transaction.metadata, 'orderReturnId') || /^Order return\b/i.test(transaction.note?.trim() || '')
  )
  if (!hasOrderReturnReference) return false

  const order = salesOrdersById.get(transaction.sourceRecordId)
  if (!order?.salesAccountAgentId || !salesAccountAgentIds.has(order.salesAccountAgentId)) return false

  const hasPartialReturnTotals =
    Number(order.total || 0) > 0.000001 && Number(order.returnedAmount || 0) > 0.000001
  return order.returnStatus === 'partial' || (order.returnStatus !== 'full' && hasPartialReturnTotals)
}

function getLegacyReturnReason(note: string | null | undefined) {
  const match =
    note?.trim().match(/^(?:Order|Full sale) return [a-z0-9-]+:\s*(.+)$/i) ||
    note?.trim().match(/^Return Credit\s*\(\s*Reason:\s*(.+?)\s*\)$/i)
  return match?.[1]?.trim() || null
}

function isGeneratedReversalNote(note: string | null | undefined) {
  return /^Reversal of\s+.+$/i.test(note?.trim() || '')
}

function isOrderLoanDownPayment(transaction: PaymentTransaction) {
  return (
    transaction.sourceType === 'sales_order' &&
    transaction.direction === 'incoming' &&
    (metadataFlag(transaction.metadata, 'isDownPayment') ||
      metadataFlag(transaction.metadata, 'isFinancingInitialPayment'))
  )
}

function isSalesOrderAdvancePayment(transaction: PaymentTransaction, salesOrder?: SalesOrder) {
  if (transaction.sourceType !== 'sales_order' || transaction.direction !== 'incoming' || !salesOrder) {
    return false
  }

  // A payment against an uncompleted order is a customer advance even when
  // the eventual completion timestamp has not been written yet.
  if (salesOrder.status !== 'completed') return true

  const paidAt = eventDate(transaction.paidAt || transaction.createdAt)
  const completedAt = eventDate(salesOrder.actualDeliveryDate)
  return Boolean(paidAt && completedAt && paidAt.getTime() < completedAt.getTime())
}

function paymentStatementPresentation(
  transaction: PaymentTransaction,
  salesOrder?: SalesOrder
): {
  description: string
  descriptionKey?: PartnerAccountStatementEntryDescriptionKey
  note: string | null
  returnReason: string | null
} {
  const note = transaction.note?.trim() || null
  const returnReason = metadataText(transaction.metadata, 'returnReason') || getLegacyReturnReason(note)

  if (transaction.sourceType === 'agent_commission_payout') {
    return {
      description: 'Commission paid',
      descriptionKey: 'commissionPaid',
      note,
      returnReason: null
    }
  }

  if (transaction.sourceType === 'agent_commission_recovery') {
    return {
      description: 'Commission recovered',
      descriptionKey: 'commissionRecovered',
      note,
      returnReason: null
    }
  }

  if (metadataFlag(transaction.metadata, 'loanRepaymentRefund')) {
    return {
      description: 'Loan repayment refund',
      descriptionKey: 'loanRepaymentRefund',
      note: null,
      returnReason
    }
  }
  if (metadataFlag(transaction.metadata, 'financingInitialPaymentRefund')) {
    return {
      description: 'Financing down payment refund',
      descriptionKey: 'financingDownPaymentRefund',
      note: null,
      returnReason
    }
  }
  if (metadataFlag(transaction.metadata, 'fullSaleReturn')) {
    return {
      description: 'Full sale return refund',
      descriptionKey: 'fullSaleReturnRefund',
      note: null,
      returnReason
    }
  }
  if (metadataText(transaction.metadata, 'orderReturnId') || /^Order return [a-z0-9-]+:/i.test(note || '')) {
    return {
      description: 'Order return refund',
      descriptionKey: 'orderReturnRefund',
      note: null,
      returnReason
    }
  }
  if (transaction.reversalOfTransactionId) {
    return {
      description: 'Payment reversal',
      descriptionKey: 'paymentReversal',
      note: isGeneratedReversalNote(note) ? null : note,
      returnReason: null
    }
  }
  if (isOrderLoanDownPayment(transaction)) {
    return {
      description: 'Order loan down payment received',
      descriptionKey: 'orderLoanDownPaymentReceived',
      note,
      returnReason: null
    }
  }
  if (isSalesOrderAdvancePayment(transaction, salesOrder)) {
    return {
      description: 'Advance payment received',
      descriptionKey: 'advancePaymentReceived',
      note,
      returnReason: null
    }
  }

  return { ...paymentDescription(transaction), note, returnReason: null }
}

function loanPaymentStatementPresentation(
  payment: Pick<LoanPayment, 'paidAt' | 'createdAt'> & { note?: string | null },
  lent: boolean
): {
  description: string
  descriptionKey: PartnerAccountStatementEntryDescriptionKey
  note: string | null
  returnReason: string | null
} {
  const returnReason = getLegacyReturnReason(payment.note)
  if (returnReason && /^Return Credit\b/i.test(payment.note?.trim() || '')) {
    return {
      description: 'Return credit',
      descriptionKey: 'returnCredit',
      note: null,
      returnReason
    }
  }

  return {
    description: lent ? 'Loan repayment received' : 'Loan repayment made',
    descriptionKey: lent ? 'loanRepaymentReceived' : 'loanRepaymentMade',
    note: payment.note?.trim() || null,
    returnReason: null
  }
}

function roundStatementAmount(amount: number) {
  return Math.round((amount + Number.EPSILON) * 1_000_000) / 1_000_000
}

function originalSalesOrderAmount(order: SalesOrder) {
  const storedOriginal = Math.abs(Number(order.originalTotalAmount || 0))
  if (storedOriginal > 0) return storedOriginal
  return Math.abs(Number(order.total || 0)) + Math.abs(Number(order.returnedAmount || 0))
}

function createOrderEntries(data: PartnerAccountStatementData): PartnerAccountStatementEntry[] {
  const sourceOrders = data.statementOrders || [...data.salesOrders, ...data.purchaseOrders]
  const loansById = new Map((data.loans || []).map((loan) => [loan.id, loan]))
  const loanIds = new Set(loansById.keys())
  const returnsByOrderId = new Map<string, OrderReturn[]>()
  const returnItemsByReturnId = new Map<string, OrderReturnItem[]>()
  for (const orderReturn of data.salesOrderReturns || []) {
    if (orderReturn.isDeleted || orderReturn.status !== 'posted') continue
    const rows = returnsByOrderId.get(orderReturn.orderId) || []
    rows.push(orderReturn)
    returnsByOrderId.set(orderReturn.orderId, rows)
  }
  for (const returnItem of data.salesOrderReturnItems || []) {
    if (returnItem.isDeleted) continue
    const rows = returnItemsByReturnId.get(returnItem.returnId) || []
    rows.push(returnItem)
    returnItemsByReturnId.set(returnItem.returnId, rows)
  }
  const entries: PartnerAccountStatementEntry[] = []
  // Product snapshots explain both payable and tracked commissions on the
  // originating sale rows; unlike aggregate commission entries, they never
  // create a statement balance movement.
  const productCommissionEntries = (data.agentProductCommissionEntries || [])
    .filter((entry) => !entry.isDeleted)

  for (const order of sourceOrders) {
    if (order.isDeleted || order.status === 'draft' || order.status === 'cancelled') continue
    const linkedSalesLoan = isSalesOrder(order) && order.linkedLoanId
      ? loansById.get(order.linkedLoanId)
      : undefined
    const projectFinancedSalesOrderAsLedger = Boolean(
      !data.isAgentCommissionStatement
      && linkedSalesLoan?.source === 'order'
      && linkedSalesLoan.orderType === 'sales'
      && linkedSalesLoan.orderId === order.id
    )
    // When an order created the loan, the loan is the accounting source of
    // truth for agent statements. Customer statements use the original order,
    // payment, return, and reversal rows so returns remain visible by date.
    if (order.linkedLoanId && loanIds.has(order.linkedLoanId) && !projectFinancedSalesOrderAsLedger) continue
    const sales = isSalesOrder(order)
    if (!sales) {
      entries.push({
        id: `purchase-order:${order.id}`,
        date: order.createdAt,
        reference: order.orderNumber,
        kind: 'purchase_order',
        description: 'Purchase order',
        descriptionKey: 'purchaseOrder',
        note: order.notes,
        currency: order.currency,
        delta: -Math.abs(Number(order.total || 0)),
        source: { recordType: 'order', recordId: order.id }
      })
      continue
    }

    // Agent sales accounts must show each sold/returned product. Ordinary
    // business-partner statements retain their original document-level
    // presentation unless the user explicitly enables item detail.
    const salesOrder = order as SalesOrder
    const paymentMethod = salesOrder.paymentMethod || 'unknown'
    const saleItems = (salesOrder.items || []).filter((item) => Number(item.quantity || 0) > 0)
    const shouldItemizeSalesOrders = data.itemizeSalesOrders === true
    const orderProductCommissionAccruals = productCommissionEntries.filter(
      (entry) => entry.orderId === salesOrder.id && entry.kind === 'accrual'
    )
    const orderProductCommissionTotal = orderProductCommissionAccruals.length > 0
      ? roundStatementAmount(
        orderProductCommissionAccruals.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
      )
      : null

    if (shouldItemizeSalesOrders && saleItems.length > 0) {
      const saleTotal = originalSalesOrderAmount(salesOrder)
      const totalLineValue = saleItems.reduce((sum, item) => sum + Math.max(0, Number(item.lineTotal || 0)), 0)
      let remainingSaleValue = saleTotal
      saleItems.forEach((item, index) => {
        const isLastItem = index === saleItems.length - 1
        const weightedAmount =
          totalLineValue > 0
            ? (saleTotal * Math.max(0, Number(item.lineTotal || 0))) / totalLineValue
            : saleTotal / saleItems.length
        const lineAmount = isLastItem ? remainingSaleValue : roundStatementAmount(weightedAmount)
        remainingSaleValue = roundStatementAmount(remainingSaleValue - lineAmount)
        entries.push({
          id: `sales-order:${salesOrder.id}:item:${item.id}`,
          date: salesOrder.createdAt,
          reference: salesOrder.orderNumber,
          kind: 'sales_order',
          description: 'Sale Order By {{paymentMethod}}',
          descriptionKey: 'saleOrderByPaymentMethod',
          paymentMethod,
          itemName: item.productName,
          quantity: Number(item.quantity || 0),
          unit: item.unit || null,
          commissionPerProduct:
            productCommissionEntries.find(
              (entry) => entry.orderId === salesOrder.id && entry.orderItemId === item.id && entry.kind === 'accrual'
            )?.commissionPerUnit ?? null,
          totalProductCommission:
            productCommissionEntries
              .filter(
                (entry) => entry.orderId === salesOrder.id && entry.orderItemId === item.id && entry.kind === 'accrual'
              )
              .reduce((sum, entry) => sum + Number(entry.amount || 0), 0) || null,
          note: item.note || salesOrder.notes,
          currency: salesOrder.currency,
          delta: Math.abs(lineAmount),
          source: { recordType: 'order', recordId: salesOrder.id }
        })
      })
    } else {
      entries.push({
        id: `sales-order:${salesOrder.id}`,
        date: salesOrder.createdAt,
        reference: salesOrder.orderNumber,
        kind: 'sales_order',
        description: 'Sale Order By {{paymentMethod}}',
        descriptionKey: 'saleOrderByPaymentMethod',
        paymentMethod,
        note: salesOrder.notes,
        totalProductCommission: orderProductCommissionTotal,
        currency: salesOrder.currency,
        delta: shouldItemizeSalesOrders || projectFinancedSalesOrderAsLedger
          ? originalSalesOrderAmount(salesOrder)
          : Math.abs(Number(salesOrder.total || 0)),
        source: { recordType: 'order', recordId: salesOrder.id }
      })
    }

    // Ordinary sales orders retain their document-level presentation unless
    // item detail is enabled. Financed customer orders still emit dated return
    // rows so their statement reflects each return as a separate movement.
    if (!shouldItemizeSalesOrders && !projectFinancedSalesOrderAsLedger) continue

    const itemsByOrderItemId = new Map((salesOrder.items || []).map((item) => [item.id, item]))
    for (const orderReturn of returnsByOrderId.get(salesOrder.id) || []) {
      const returnItems = returnItemsByReturnId.get(orderReturn.id) || []
      if (!shouldItemizeSalesOrders) {
        entries.push({
          id: `sales-order-return:${orderReturn.id}`,
          date: orderReturn.returnedAt || orderReturn.createdAt,
          reference: `${salesOrder.orderNumber} · ${orderReturn.id}`,
          kind: 'sales_order_return',
          description: 'Sales order return',
          descriptionKey: 'salesOrderReturn',
          relatedReturnId: orderReturn.id,
          returnReason: orderReturn.reason,
          currency: salesOrder.currency,
          delta: -Math.abs(Number(orderReturn.refundAmount || 0)),
          source: { recordType: 'order', recordId: salesOrder.id }
        })
        continue
      }
      if (returnItems.length === 0) {
        entries.push({
          id: `sales-order-return:${orderReturn.id}`,
          date: orderReturn.returnedAt || orderReturn.createdAt,
          reference: `${salesOrder.orderNumber} · ${orderReturn.id}`,
          kind: 'sales_order_return',
          description: 'Sales order return',
          descriptionKey: 'salesOrderReturn',
          relatedReturnId: orderReturn.id,
          returnReason: orderReturn.reason,
          currency: salesOrder.currency,
          delta: -Math.abs(Number(orderReturn.refundAmount || 0)),
          source: { recordType: 'order', recordId: salesOrder.id }
        })
        continue
      }

      for (const returnItem of returnItems) {
        const sourceItem = itemsByOrderItemId.get(returnItem.orderItemId)
        entries.push({
          id: `sales-order-return:${orderReturn.id}:item:${returnItem.id}`,
          date: orderReturn.returnedAt || orderReturn.createdAt,
          reference: `${salesOrder.orderNumber} · ${orderReturn.id}`,
          kind: 'sales_order_return',
          description: 'Sales order return',
          descriptionKey: 'salesOrderReturn',
          relatedReturnId: orderReturn.id,
          itemName: sourceItem?.productName || null,
          quantity: -Math.abs(Number(returnItem.quantity || 0)),
          unit: sourceItem?.unit || null,
          commissionPerProduct:
            productCommissionEntries.find(
              (entry) =>
                entry.orderId === salesOrder.id &&
                entry.orderItemId === returnItem.orderItemId &&
                entry.kind === 'accrual'
            )?.commissionPerUnit ?? null,
          totalProductCommission:
            productCommissionEntries
              .filter((entry) => entry.orderReturnId === orderReturn.id && entry.orderItemId === returnItem.orderItemId)
              .reduce((sum, entry) => sum + Number(entry.amount || 0), 0) || null,
          returnReason: orderReturn.reason,
          currency: salesOrder.currency,
          delta: -Math.abs(Number(returnItem.refundAmount || 0)),
          source: { recordType: 'order', recordId: salesOrder.id }
        })
      }
    }
  }

  return entries
}

/**
 * A delivery agent earns product commission from a marketplace order without
 * becoming the marketplace buyer. Keep the immutable product snapshots visible
 * in the agent statement, but use a zero account delta so the buyer's sale
 * never becomes a debt on the delivery agent's partner account.
 */
function createMarketplaceDeliveryProductCommissionEntries(
  data: PartnerAccountStatementData
): PartnerAccountStatementEntry[] {
  const marketplaceOrderIds = new Set(data.marketplaceDeliveryProductCommissionOrderIds || [])
  if (marketplaceOrderIds.size === 0) return []

  return (data.agentProductCommissionEntries || [])
    .filter((entry) => !entry.isDeleted && marketplaceOrderIds.has(entry.orderId))
    .map((entry) => ({
      id: `marketplace-delivery-product-commission:${entry.id}`,
      date: entry.occurredAt || entry.createdAt,
      reference: data.linkedOrderCodes?.[entry.orderId] || entry.orderId,
      kind: 'agent_commission' as const,
      description: 'Marketplace delivery product commission',
      descriptionKey: 'marketplaceDeliveryProductCommission' as const,
      itemName: entry.productNameSnapshot,
      quantity: Number(entry.quantity || 0),
      unit: entry.unitSnapshot || null,
      commissionPerProduct: Number(entry.commissionPerUnit || 0),
      totalProductCommission: Number(entry.amount || 0),
      currency: entry.currency,
      delta: 0,
      source: { recordType: 'order' as const, recordId: entry.orderId }
    }))
}

function createMarketplaceShippingProductCommissionEntries(
  data: PartnerAccountStatementData
): PartnerAccountStatementEntry[] {
  const marketplaceOrderIds = new Set(data.marketplaceShippingProductCommissionOrderIds || [])
  if (marketplaceOrderIds.size === 0) return []

  return (data.agentProductCommissionEntries || [])
    .filter((entry) => !entry.isDeleted && marketplaceOrderIds.has(entry.orderId))
    .map((entry) => ({
      id: `marketplace-shipping-product-commission:${entry.id}`,
      date: entry.occurredAt || entry.createdAt,
      reference: data.linkedOrderCodes?.[entry.orderId] || entry.orderId,
      kind: 'agent_commission' as const,
      description: 'Marketplace shipping product commission',
      descriptionKey: 'marketplaceShippingProductCommission' as const,
      itemName: entry.productNameSnapshot,
      quantity: Number(entry.quantity || 0),
      unit: entry.unitSnapshot || null,
      commissionPerProduct: Number(entry.commissionPerUnit || 0),
      totalProductCommission: Number(entry.amount || 0),
      currency: entry.currency,
      delta: 0,
      source: { recordType: 'order' as const, recordId: entry.orderId }
    }))
}

type AutomaticCommissionSettlement = {
  payoutEntryId: string
  recognizedEntryId: string
  payment: PaymentTransaction
  payout: AgentCommissionEntry
}

/**
 * A generated payout and its matching accrual are one financial event from a
 * partner's perspective. Present a single zero-net audit row when the whole
 * accrual was settled automatically, while retaining both immutable source
 * rows in storage and in the Payments module.
 */
function getAutomaticCommissionSettlements(data: PartnerAccountStatementData): AutomaticCommissionSettlement[] {
  const entries = (data.agentCommissionEntries || [])
    .filter((entry) => !entry.isDeleted && isPayableCommissionEntry(entry))
  const payoutsById = new Map(
    entries
      .filter((entry) => entry.kind === 'payout' && entry.settlementSource === 'automatic')
      .map((entry) => [entry.id, entry])
  )

  return (data.settlementTransactions || [])
    .filter(
      (payment) =>
        !payment.isDeleted &&
        payment.sourceType === 'agent_commission_payout' &&
        payment.metadata?.automaticSettlement === true &&
        Boolean(payment.sourceSubrecordId)
    )
    .flatMap((payment) => {
      const payout = payoutsById.get(payment.sourceSubrecordId || '')
      if (!payout?.assignmentId || !payout.orderId) return []
      const recognized = entries.filter(
        (entry) =>
          entry.assignmentId === payout.assignmentId &&
          entry.orderId === payout.orderId &&
          entry.currency === payout.currency &&
          ['accrual', 'reversal', 'adjustment'].includes(entry.kind)
      )
      // Collapse only an unambiguous full accrual. Partial payouts and
      // return/reversal histories remain expanded so their balance is
      // still transparent.
      if (
        recognized.length !== 1 ||
        Math.abs(Number(recognized[0].amount || 0) + Number(payout.amount || 0)) > 0.000001
      ) {
        return []
      }
      return [
        {
          payoutEntryId: payout.id,
          recognizedEntryId: recognized[0].id,
          payment,
          payout
        }
      ]
    })
}

function createPaymentEntries(data: PartnerAccountStatementData): PartnerAccountStatementEntry[] {
  const sourceOrders = data.statementOrders || data.salesOrders
  const salesOrdersById = new Map(sourceOrders.filter(isSalesOrder).map((order) => [order.id, order]))
  const orderLoansById = new Map<string, Loan>(
    (data.loans || [])
      .filter((loan) => (
        loan.source === 'order'
        && loan.orderType === 'sales'
        && loan.orderId
        && salesOrdersById.has(loan.orderId)
      ))
      .map((loan): [string, Loan] => [loan.id, loan])
  )
  const orderLoanTransactions = data.isAgentCommissionStatement
    ? []
    : (data.loanPaymentTransactions || []).filter((transaction) => (
      !transaction.isDeleted
      && transaction.sourceModule === 'loans'
      && orderLoansById.has(transaction.sourceRecordId)
    ))
  const transactionsById = new Map<string, PaymentTransaction>(
    [...(data.settlementTransactions || []), ...orderLoanTransactions]
      .filter((transaction) => !transaction.isDeleted)
      .map((transaction): [string, PaymentTransaction] => [transaction.id, transaction])
  )
  const salesAccountAgentIds = new Set(data.salesAccountAgentIds || [])
  const settlementOperationsById = new Map(
    (data.settlementOperations || []).filter((operation) => !operation.isDeleted).map((operation) => [operation.id, operation])
  )

  const collapsedPayoutIds = new Set(
    getAutomaticCommissionSettlements(data).map((settlement) => settlement.payoutEntryId)
  )
  return Array.from(transactionsById.values())
    .filter((transaction) => transaction.sourceType !== 'direct_transaction' || transaction.metadata?.partnerAccountEffect !== 'none')
    .filter((transaction) => !collapsedPayoutIds.has(transaction.sourceSubrecordId || ''))
    .filter((transaction) => !isSalesAccountAgentPartialReturnReversal(transaction, salesOrdersById, salesAccountAgentIds))
    .map((transaction) => {
      const rawAmount = Number(transaction.amount || 0)
      const multiplier = transaction.direction === 'incoming' ? -1 : 1
      const orderLoan = orderLoansById.get(transaction.sourceRecordId)
      const linkedLoanOrder = orderLoan?.orderId ? salesOrdersById.get(orderLoan.orderId) : undefined
      const isOrderLoanMovement = Boolean(orderLoan && !data.isAgentCommissionStatement)
      const presentation = isOrderLoanMovement
        ? transaction.reversalOfTransactionId
          ? paymentStatementPresentation(transaction)
          : loanPaymentStatementPresentation(transaction, orderLoan!.direction !== 'borrowed')
        : paymentStatementPresentation(
          transaction,
          transaction.sourceType === 'sales_order' ? salesOrdersById.get(transaction.sourceRecordId) : undefined
        )
      const loanOrderReference = linkedLoanOrder
        ? [
          data.linkedOrderCodes?.[linkedLoanOrder.id] || linkedLoanOrder.orderNumber,
          transaction.referenceLabel || orderLoan?.loanNo
        ].filter(Boolean).join(' · ')
        : null
      const orderReturnId = metadataText(transaction.metadata, 'orderReturnId')
      const refundOrder = linkedLoanOrder || salesOrdersById.get(metadataText(transaction.metadata, 'orderId') || '')
      const orderReturnReference = orderReturnId && refundOrder
        ? [refundOrder.orderNumber, orderReturnId].filter(Boolean).join(' · ')
        : null
      const isCustomerOrderReturnRefund = Boolean(
        !data.isAgentCommissionStatement
        && orderReturnId
        && (
          transaction.reversalOfTransactionId
          || metadataFlag(transaction.metadata, 'loanRepaymentRefund')
          || metadataFlag(transaction.metadata, 'financingInitialPaymentRefund')
        )
      )
      const commissionReference = transaction.sourceType === 'agent_commission_payout'
        || transaction.sourceType === 'agent_commission_recovery'
        ? data.linkedOrderCodes?.[metadataText(transaction.metadata, 'orderId') || '']
          || transaction.referenceLabel
          || transaction.sourceRecordId
        : transaction.referenceLabel || transaction.sourceRecordId
      const reference = transaction.sourceType === 'direct_transaction'
        ? formatDirectTransactionVoucherNumber(transaction)
        : orderReturnReference || loanOrderReference || commissionReference
      const settlementOperationId = transaction.settlementOperationId || null
      const settlementOperation = settlementOperationId
        ? settlementOperationsById.get(settlementOperationId)
        : undefined
      return {
        id: `payment:${transaction.id}`,
        date: transaction.paidAt || transaction.createdAt,
        reference,
        kind: isOrderLoanMovement ? 'loan_repayment' : paymentKind(transaction),
        ...presentation,
        currency: transaction.currency,
        // Keep the transaction's signed amount so a return reversal offsets
        // the original payment instead of posting a second credit.
        delta: multiplier * rawAmount,
        source: isCustomerOrderReturnRefund && refundOrder
          ? { recordType: 'order', recordId: refundOrder.id }
          : transaction.sourceType === 'sales_order' || transaction.sourceType === 'purchase_order'
            ? { recordType: 'order', recordId: transaction.sourceRecordId }
            : { recordType: 'payment_transaction', recordId: transaction.id },
        relatedReturnId: isCustomerOrderReturnRefund ? orderReturnId : null,
        settlementOperationId,
        ...(settlementOperation ? { settlementOperation } : {})
      }
    })
}

function commissionEntryPresentation(entry: AgentCommissionEntry): {
  description: string
  descriptionKey: PartnerAccountStatementEntryDescriptionKey
} | null {
  switch (entry.kind) {
    case 'accrual':
      return {
        description: 'Commission earned',
        descriptionKey: 'commissionEarned'
      }
    case 'reversal':
      return {
        description: 'Commission reversed',
        descriptionKey: 'commissionReversed'
      }
    case 'adjustment':
      return {
        description: 'Commission adjustment',
        descriptionKey: 'commissionAdjustment'
      }
    default:
      return null
  }
}

/**
 * A sales-account agent is a business partner as well as a commission
 * recipient. The earned/reversed/adjusted ledger entries establish what the
 * workspace owes the agent. The separately recorded payout payment then
 * settles that liability, so a paid commission nets to zero in the statement.
 */
function createAgentCommissionEntries(data: PartnerAccountStatementData): PartnerAccountStatementEntry[] {
  const settlements = getAutomaticCommissionSettlements(data)
  const collapsedRecognizedEntryIds = new Set(settlements.map((settlement) => settlement.recognizedEntryId))
  const commissionEntries = (data.agentCommissionEntries || [])
    .filter(isPayableCommissionEntry)
    .filter((entry) => !entry.isDeleted)
    .filter((entry) => !collapsedRecognizedEntryIds.has(entry.id))
    .flatMap((entry) => {
      const presentation = commissionEntryPresentation(entry)
      if (!presentation) return []

      const reference =
        (entry.orderId ? data.linkedOrderCodes?.[entry.orderId] : null) ||
        entry.payoutReference ||
        entry.orderId ||
        entry.id
      return [
        {
          id: `agent-commission:${entry.id}`,
          date: entry.occurredAt || entry.createdAt,
          reference,
          kind: 'agent_commission' as const,
          ...presentation,
          note: entry.notes?.trim() || null,
          currency: entry.currency,
          relatedReturnId: entry.orderReturnId || null,
          // Commission entries are amounts owed to the sales-account
          // agent, while a positive statement delta is owed by them.
          delta: -Number(entry.amount || 0)
        }
      ]
    })

  const settlementEntries: PartnerAccountStatementEntry[] = settlements.map(({ payment, payout }) => ({
    id: `agent-commission-settlement:${payout.id}`,
    date: payment.paidAt || payment.createdAt,
    reference:
      (payout.orderId ? data.linkedOrderCodes?.[payout.orderId] : null) ||
      payout.payoutReference ||
      payout.orderId ||
      payout.id,
    kind: 'agent_commission',
    description: 'Commission settled automatically',
    descriptionKey: 'commissionSettledAutomatically',
    note: payment.note?.trim() || payout.notes?.trim() || null,
    currency: payout.currency,
    delta: 0,
    source: { recordType: 'payment_transaction', recordId: payment.id }
  }))

  return [...commissionEntries, ...settlementEntries]
}

function createLoanEntries(data: PartnerAccountStatementData): PartnerAccountStatementEntry[] {
  const loans = data.loans || []
  const payments = data.loanPayments || []
  const loanById = new Map(loans.map((loan) => [loan.id, loan]))
  const paymentTransactionsById = new Map(
    (data.loanPaymentTransactions || []).map((transaction) => [transaction.id, transaction])
  )
  const settlementOperationsById = new Map(
    (data.settlementOperations || []).filter((operation) => !operation.isDeleted).map((operation) => [operation.id, operation])
  )
  const statementOrders = data.statementOrders || [...data.salesOrders, ...data.purchaseOrders]
  const salesOrderById = new Map(
    statementOrders
      .filter(isSalesOrder)
      .map((order) => [order.id, order])
  )
  const purchaseOrderById = new Map(
    statementOrders
      .filter((order): order is PurchaseOrder => !isSalesOrder(order))
      .map((order) => [order.id, order])
  )
  const isProjectedSalesOrderLoan = (loan: Loan | undefined) => Boolean(
    !data.isAgentCommissionStatement
    && loan?.source === 'order'
    && loan.orderType === 'sales'
    && loan.orderId
    && salesOrderById.has(loan.orderId)
  )
  // Product snapshots are informational for agent statements. Customer
  // statements project financed orders from order, payment, return, and
  // reversal rows instead of reusing the loan's mutable summary balances.
  const productCommissionEntries = (data.agentProductCommissionEntries || [])
    .filter((entry) => !entry.isDeleted)
  const returnsByOrderId = new Map<string, OrderReturn[]>()
  const returnItemsByReturnId = new Map<string, OrderReturnItem[]>()
  for (const orderReturn of data.salesOrderReturns || []) {
    if (orderReturn.isDeleted || orderReturn.status !== 'posted') continue
    const rows = returnsByOrderId.get(orderReturn.orderId) || []
    rows.push(orderReturn)
    returnsByOrderId.set(orderReturn.orderId, rows)
  }
  for (const returnItem of data.salesOrderReturnItems || []) {
    if (returnItem.isDeleted) continue
    const rows = returnItemsByReturnId.get(returnItem.returnId) || []
    rows.push(returnItem)
    returnItemsByReturnId.set(returnItem.returnId, rows)
  }
  const entries: PartnerAccountStatementEntry[] = []

  for (const loan of loans) {
    if (isProjectedSalesOrderLoan(loan)) continue
    if (loan.isDeleted || loan.status === 'cancelled') continue
    const lent = loan.direction !== 'borrowed'
    const linkedSalesOrder = loan.orderId ? salesOrderById.get(loan.orderId) : undefined
    const linkedPurchaseOrder = loan.orderId ? purchaseOrderById.get(loan.orderId) : undefined
    const isOrderPurchaseLoan = loan.source === 'order'
      && (loan.orderType === 'purchase' || linkedPurchaseOrder != null)
    const isOrderSaleLoan = loan.source === 'order' && !isOrderPurchaseLoan
      && (loan.orderType === 'sales' || linkedSalesOrder != null)
    const linkedOrder = isOrderPurchaseLoan ? linkedPurchaseOrder : linkedSalesOrder
    const paymentMethod = loan.source === 'order'
      ? linkedOrder?.paymentMethod || 'loan'
      : undefined
    const linkedOrderCode = loan.orderId ? data.linkedOrderCodes?.[loan.orderId]?.trim() : undefined
    const linkedPosSaleCode = loan.saleId ? data.linkedPosSaleCodes?.[loan.saleId]?.trim() : undefined
    const linkedDocumentCode = linkedOrderCode || linkedPosSaleCode
    const isPosSaleLoan = loan.source === 'pos'
    const kind: PartnerAccountStatementEntryKind = loan.source === 'order'
      ? isOrderPurchaseLoan ? 'purchase_order' : 'sales_order'
      : isPosSaleLoan
        ? loan.loanCategory === 'simple'
          ? 'pos_sale_loan'
          : 'pos_sale_installment_loan'
        : 'loan_disbursal'
    const reference = linkedDocumentCode ? `${linkedDocumentCode} · ${loan.loanNo}` : loan.loanNo
    const descriptionKey: PartnerAccountStatementEntryDescriptionKey =
      loan.source === 'order'
        ? isOrderPurchaseLoan ? 'purchaseOrderByPaymentMethod' : 'saleOrderByPaymentMethod'
        : isPosSaleLoan
          ? lent
            ? 'posSaleLoanProvided'
            : 'posSaleLoanReceived'
          : lent
            ? 'loanProvided'
            : 'loanReceived'
    const loanEntry = {
      date: loan.createdAt,
      reference,
      kind,
      description:
        loan.source === 'order'
          ? isOrderPurchaseLoan ? 'Purchase Order By {{paymentMethod}}' : 'Sale Order By {{paymentMethod}}'
          : isPosSaleLoan
            ? lent
              ? 'POS sale loan provided'
              : 'POS sale loan received'
          : lent
            ? 'Loan provided'
            : 'Loan received',
      descriptionKey,
      paymentMethod,
      currency: loan.settlementCurrency,
      delta: lent ? Math.abs(Number(loan.principalAmount || 0)) : -Math.abs(Number(loan.principalAmount || 0)),
      source: {
        recordType: 'loan' as const,
        recordId: loan.id,
        loanCategory: loan.loanCategory
      }
    }
    const orderSaleItems = linkedSalesOrder && isOrderSaleLoan && data.itemizeSalesOrders === true
      ? (linkedSalesOrder.items || []).filter((item) => Number(item.quantity || 0) > 0)
      : []
    const posSaleItems = isPosSaleLoan && loan.saleId && data.itemizePosSaleLoans === true
      ? (data.posSaleItemsBySaleId?.[loan.saleId] || []).filter((item) => Number(item.quantity || 0) > 0)
      : []
    const orderProductCommissionEntries = linkedSalesOrder
      ? productCommissionEntries.filter((entry) => entry.orderId === linkedSalesOrder.id)
      : []
    const orderProductCommissionTotal = orderProductCommissionEntries.length > 0
      ? roundStatementAmount(
        orderProductCommissionEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
      )
      : null

    if (orderSaleItems.length === 0 && posSaleItems.length === 0) {
      entries.push({
        id: `loan:${loan.id}`,
        ...loanEntry,
        totalProductCommission: orderProductCommissionTotal,
        delta: lent ? Math.abs(Number(loan.principalAmount || 0)) : -Math.abs(Number(loan.principalAmount || 0))
      })
      continue
    }

    // The loan principal remains the accounting authority. Allocate it over
    // immutable source-order or POS lines and reserve the rounded remainder
    // for the final line so itemized presentation always nets to the loan.
    const itemizedLoanItems = orderSaleItems.length > 0 ? orderSaleItems : posSaleItems
    const principalAmount = Math.abs(Number(loan.principalAmount || 0))
    const totalLineValue = itemizedLoanItems.reduce((sum, item) => sum + Math.max(0, Number(item.lineTotal || 0)), 0)
    let remainingPrincipal = principalAmount
    itemizedLoanItems.forEach((item, index) => {
      const isLastItem = index === itemizedLoanItems.length - 1
      const weightedAmount = totalLineValue > 0
        ? (principalAmount * Math.max(0, Number(item.lineTotal || 0))) / totalLineValue
        : principalAmount / itemizedLoanItems.length
      const lineAmount = isLastItem ? remainingPrincipal : roundStatementAmount(weightedAmount)
      remainingPrincipal = roundStatementAmount(remainingPrincipal - lineAmount)
      const itemProductCommissionEntries = linkedSalesOrder
        ? orderProductCommissionEntries.filter(
          (entry) => entry.orderItemId === item.id && !entry.orderReturnId
        )
        : []
      entries.push({
        id: `loan:${loan.id}:item:${item.id}`,
        ...loanEntry,
        itemName: item.productName,
        quantity: Number(item.quantity || 0),
        unit: item.unit,
        commissionPerProduct:
          itemProductCommissionEntries.find((entry) => entry.kind === 'accrual')?.commissionPerUnit ?? null,
        totalProductCommission: itemProductCommissionEntries.length > 0
          ? roundStatementAmount(
            itemProductCommissionEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
          )
          : null,
        delta: lent ? Math.abs(lineAmount) : -Math.abs(lineAmount)
      })
    })

    // Agent return rows remain informational because the loan summary and
    // payment rows already carry their accounting effect in that statement.
    if (!linkedSalesOrder || orderSaleItems.length === 0) continue

    const itemsByOrderItemId = new Map((linkedSalesOrder.items || []).map((item) => [item.id, item]))
    for (const orderReturn of returnsByOrderId.get(linkedSalesOrder.id) || []) {
      const returnItems = returnItemsByReturnId.get(orderReturn.id) || []
      const returnReference = `${linkedSalesOrder.orderNumber} · ${orderReturn.id}`
      if (returnItems.length === 0) {
        const returnProductCommissionTotal = orderProductCommissionEntries
          .filter((entry) => entry.orderReturnId === orderReturn.id)
          .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
        entries.push({
          id: `loan:${loan.id}:sales-order-return:${orderReturn.id}`,
          date: orderReturn.returnedAt || orderReturn.createdAt,
          reference: returnReference,
          kind: 'sales_order_return',
          description: 'Sales order return',
          descriptionKey: 'salesOrderReturn',
          relatedReturnId: orderReturn.id,
          returnReason: orderReturn.reason,
          totalProductCommission: returnProductCommissionTotal || null,
          currency: loan.settlementCurrency,
          delta: 0,
          source: loanEntry.source
        })
        continue
      }

      for (const returnItem of returnItems) {
        const sourceItem = itemsByOrderItemId.get(returnItem.orderItemId)
        const returnProductCommissionEntries = orderProductCommissionEntries.filter(
          (entry) => entry.orderReturnId === orderReturn.id && entry.orderItemId === returnItem.orderItemId
        )
        entries.push({
          id: `loan:${loan.id}:sales-order-return:${orderReturn.id}:item:${returnItem.id}`,
          date: orderReturn.returnedAt || orderReturn.createdAt,
          reference: returnReference,
          kind: 'sales_order_return',
          description: 'Sales order return',
          descriptionKey: 'salesOrderReturn',
          relatedReturnId: orderReturn.id,
          itemName: sourceItem?.productName || null,
          quantity: -Math.abs(Number(returnItem.quantity || 0)),
          unit: sourceItem?.unit || null,
          commissionPerProduct:
            orderProductCommissionEntries.find(
              (entry) => entry.orderItemId === returnItem.orderItemId && entry.kind === 'accrual'
            )?.commissionPerUnit ?? null,
          totalProductCommission: returnProductCommissionEntries.length > 0
            ? roundStatementAmount(
              returnProductCommissionEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
            )
            : null,
          returnReason: orderReturn.reason,
          currency: loan.settlementCurrency,
          delta: 0,
          source: loanEntry.source
        })
      }
    }
  }

  for (const payment of payments) {
    const loan = loanById.get(payment.loanId)
    if (isProjectedSalesOrderLoan(loan)) continue
    if (!loan || payment.isDeleted || loan.isDeleted || loan.status === 'cancelled') continue
    const lent = loan.direction !== 'borrowed'
    const linkedOrderCode = loan.orderId ? data.linkedOrderCodes?.[loan.orderId]?.trim() : undefined
    const linkedPosSaleCode = loan.saleId ? data.linkedPosSaleCodes?.[loan.saleId]?.trim() : undefined
    const linkedDocumentCode = linkedOrderCode || linkedPosSaleCode
    const reference = linkedDocumentCode ? `${linkedDocumentCode} · ${loan.loanNo}` : loan.loanNo
    const presentation = loanPaymentStatementPresentation(payment, lent)
    const paymentTransaction = payment.paymentTransactionId
      ? paymentTransactionsById.get(payment.paymentTransactionId)
      : undefined
    const settlementOperationId = paymentTransaction?.settlementOperationId || null
    const settlementOperation = settlementOperationId
      ? settlementOperationsById.get(settlementOperationId)
      : undefined
    entries.push({
      id: `loan-payment:${payment.id}`,
      date: payment.paidAt || payment.createdAt,
      reference,
      kind: 'loan_repayment',
      ...presentation,
      currency: loan.settlementCurrency,
      delta: lent ? -Math.abs(Number(payment.amount || 0)) : Math.abs(Number(payment.amount || 0)),
      source: {
        recordType: 'loan',
        recordId: loan.id,
        loanCategory: loan.loanCategory
      },
      settlementOperationId,
      ...(settlementOperation ? { settlementOperation } : {})
    })
  }

  return entries
}

function createInstallmentSaleEntries(data: PartnerAccountStatementData): PartnerAccountStatementEntry[] {
  return (data.installmentSales || [])
    .filter((sale) => !sale.isDeleted && sale.status !== 'cancelled')
    .map((sale) => ({
      id: `installment-sale:${sale.id}`,
      date: sale.createdAt,
      reference: sale.saleNo,
      kind: 'installment_sale' as const,
      description: 'Installment sale',
      descriptionKey: 'installmentSale' as const,
      note: sale.description,
      currency: sale.currency,
      delta: Math.abs(Number(sale.totalSalePrice || 0)),
      source: { recordType: 'installment_sale' as const, recordId: sale.id }
    }))
}

function createAgentCreatedSalesActivityEntries(
  data: PartnerAccountStatementData
): PartnerAccountStatementEntry[] {
  return (data.agentCreatedSalesActivities || []).map((activity) => {
    const descriptions: Record<PartnerAccountStatementAgentSaleActivity['descriptionKey'], string> = {
      sellerCreatedSalesOrder: 'Sales order created by Seller',
      sellerCreatedPosSale: 'POS sale created by Seller',
      sellerCreatedInstallmentSale: 'Installment sale created by Seller',
      sellerReturnedSalesOrder: 'Sales order returned by Seller',
      sellerReturnedPosSale: 'POS sale returned by Seller'
    }
    return {
      id: `agent-sales-activity:${activity.saleKind}:${activity.id}`,
      date: activity.date,
      reference: activity.reference,
      kind: 'agent_sales_activity',
      description: descriptions[activity.descriptionKey],
      descriptionKey: activity.descriptionKey,
      relatedReturnId: activity.relatedReturnId,
      returnReason: activity.returnReason,
      currency: activity.currency,
      delta: 0,
      salesActivityAmount: Number(activity.amount || 0),
      source: activity.source
    }
  })
}

/**
 * Builds an auditable per-currency partner ledger. A positive balance means
 * the partner owes the workspace; a negative balance means the workspace owes
 * the partner. Currencies are intentionally never converted in this record.
 */
export function buildPartnerAccountStatementLedger(
  data: PartnerAccountStatementData
): PartnerAccountStatementCurrencyLedger[] {
  if (data.precomputedLedgers) return data.precomputedLedgers

  const entries = [
    ...createOrderEntries(data),
    ...createMarketplaceDeliveryProductCommissionEntries(data),
    ...createMarketplaceShippingProductCommissionEntries(data),
    ...createPaymentEntries(data),
    ...createAgentCommissionEntries(data),
    ...createLoanEntries(data),
    ...createInstallmentSaleEntries(data),
    ...createAgentCreatedSalesActivityEntries(data)
  ].filter((entry) => (
    Math.abs(entry.delta) > 0.000001
    || entry.descriptionKey === 'commissionSettledAutomatically'
    || entry.totalProductCommission != null
    || entry.salesActivityAmount != null
    // Agent financed-order return rows are informational. Preserve their item
    // audit rows even when no commission rule applied, without adding balance.
    || (entry.kind === 'sales_order_return' && entry.itemName != null)
  ))
  const trackedCommissionTotals = data.trackedCommissionEntries
    ? sumTrackedCommissionEntriesByCurrency(
      data.trackedCommissionEntries,
      data.salesAccountAgentIds,
      data.period
    )
    : null

  const entriesByCurrency = new Map<string, PartnerAccountStatementEntry[]>()
  for (const entry of entries) {
    const key = entry.currency.toLowerCase()
    const current = entriesByCurrency.get(key) || []
    current.push(entry)
    entriesByCurrency.set(key, current)
  }
  for (const [currency, amount] of Object.entries(trackedCommissionTotals || {})) {
    if (Math.abs(amount) > 0.000001 && !entriesByCurrency.has(currency)) entriesByCurrency.set(currency, [])
  }

  return Array.from(entriesByCurrency.entries())
    .map(([currency, currencyEntries]) => {
      const sortedEntries = currencyEntries.slice().sort(compareEntries)
      const openingBalance = sortedEntries
        .filter((entry) => isBeforePeriod(entry.date, data.period))
        .reduce((sum, entry) => sum + entry.delta, 0)
      let runningBalance = openingBalance
      let debitTotal = 0
      let creditTotal = 0
      const periodEntries = sortedEntries
        .filter((entry) => isIncludedInPeriod(entry.date, data.period))
        .map((entry) => {
          runningBalance += entry.delta
          if (entry.delta > 0) debitTotal += entry.delta
          else creditTotal += Math.abs(entry.delta)
          return { ...entry, runningBalance }
        })
      // Tracked reports use the aggregate event ledger so removed or replaced
      // item snapshots cannot make this total disagree with the other reports.
      // Payable/legacy statements keep their historical snapshot presentation.
      const productCommissionTotal = roundStatementAmount(trackedCommissionTotals
        ? trackedCommissionTotals[currency] || 0
        : periodEntries.reduce((sum, entry) => sum + Number(entry.totalProductCommission ?? 0), 0))

      return {
        currency,
        openingBalance,
        productCommissionTotal,
        debitTotal,
        creditTotal,
        closingBalance: runningBalance,
        entries: periodEntries
      }
    })
    .filter((ledger) => ledger.entries.length > 0
      || Math.abs(ledger.openingBalance) > 0.000001
      || Math.abs(ledger.productCommissionTotal) > 0.000001)
    .sort((left, right) => left.currency.localeCompare(right.currency))
}

/**
 * Gets the all-currency closing balances from the exact same derived ledger
 * used by Partner Account Statements. Consumers must not convert or net these
 * values, because each currency is an independently auditable account.
 */
export function getPartnerAccountStatementClosingBalances(
  data: PartnerAccountStatementData
): PartnerAccountStatementClosingBalance[] {
  return buildPartnerAccountStatementLedger(data).map(({ currency, closingBalance }) => ({
    currency,
    closingBalance
  }))
}

/**
 * Applies a sales-account agent's net partner-statement credit against the
 * oldest open sales-order loans. The source loan and payment records remain
 * unchanged; this is the receivable amount presented and collected through
 * Payments after account-level credits are applied.
 */
export function applySalesAgentStatementCreditToOrderLoans(
  obligations: PaymentObligation[],
  data: PartnerAccountStatementData,
  salesAccountAgentIds: string[]
): PaymentObligation[] {
  const partnerId = data.partnerId
  if (!partnerId || salesAccountAgentIds.length === 0) return obligations

  const eligibleOrderIds = new Set(
    (data.salesOrders || [])
      .filter((order) => !order.isDeleted && order.salesAccountAgentId && salesAccountAgentIds.includes(order.salesAccountAgentId))
      .map((order) => order.id)
  )
  if (eligibleOrderIds.size === 0) return obligations

  const statementBalances = new Map(
    getPartnerAccountStatementClosingBalances({
      ...data,
      itemizeSalesOrders: true,
      isAgentCommissionStatement: true,
      salesAccountAgentIds
    }).map(({ currency, closingBalance }) => [currency.toLowerCase(), closingBalance])
  )
  if (statementBalances.size === 0) return obligations

  const candidatesByCurrency = new Map<string, PaymentObligation[]>()
  obligations.forEach((obligation) => {
    const orderId = typeof obligation.metadata?.orderId === 'string' ? obligation.metadata.orderId : null
    if (
      obligation.sourceType !== 'simple_loan'
      || obligation.direction !== 'incoming'
      || obligation.metadata?.displaySourceLabel !== 'order_loan'
      || obligation.metadata?.orderType !== 'sales'
      || obligation.metadata?.businessPartnerId !== partnerId
      || !orderId
      || !eligibleOrderIds.has(orderId)
      || obligation.amount <= 0
    ) return

    const currency = obligation.currency.toLowerCase()
    const rows = candidatesByCurrency.get(currency) || []
    rows.push(obligation)
    candidatesByCurrency.set(currency, rows)
  })

  const adjustedAmounts = new Map<string, { amount: number; creditApplied: number }>()
  for (const [currency, candidates] of candidatesByCurrency) {
    const closingBalance = statementBalances.get(currency)
    // Missing statement data means we cannot prove a credit is available.
    if (closingBalance == null) continue

    const grossOpen = candidates.reduce((sum, obligation) => sum + obligation.amount, 0)
    let remainingCredit = Math.max(grossOpen - Math.max(closingBalance, 0), 0)
    const oldestFirst = candidates.slice().sort((left, right) => {
      const createdAtCompare = (left.createdAt || '').localeCompare(right.createdAt || '')
      if (createdAtCompare !== 0) return createdAtCompare
      const dueDateCompare = (left.dueDate || '').localeCompare(right.dueDate || '')
      return dueDateCompare || (left.referenceLabel || '').localeCompare(right.referenceLabel || '')
    })

    for (const obligation of oldestFirst) {
      if (remainingCredit <= 0.000001) break
      const creditApplied = Math.min(obligation.amount, remainingCredit)
      const amount = Math.max(obligation.amount - creditApplied, 0)
      adjustedAmounts.set(obligation.id, { amount, creditApplied })
      remainingCredit = Math.max(remainingCredit - creditApplied, 0)
    }
  }

  if (adjustedAmounts.size === 0) return obligations
  return obligations.map((obligation) => {
    const adjusted = adjustedAmounts.get(obligation.id)
    if (!adjusted) return obligation
    return {
      ...obligation,
      amount: adjusted.amount,
      metadata: {
        ...(obligation.metadata || {}),
        salesAgentAccountCreditApplied: adjusted.creditApplied
      }
    }
  })
}

export function getPartnerAccountStatementDescriptionTranslationKey(
  entry: Pick<PartnerAccountStatementEntry, 'descriptionKey'>
) {
  return entry.descriptionKey ? `businessPartners.accountStatement.descriptions.${entry.descriptionKey}` : null
}
