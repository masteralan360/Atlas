import type { OrderPartnerBalanceSnapshot, PurchaseOrder, SalesOrder } from '@/local-db/models'
import {
  buildPartnerAccountStatementLedger,
  getPartnerAccountStatementClosingBalances,
  type PartnerAccountStatementData,
  type PartnerAccountStatementEntry
} from '@/lib/partnerAccountStatement'

type StatementOrder = SalesOrder | PurchaseOrder

const SNAPSHOT_PRECISION = 1_000_000

/** Only a first non-draft, non-cancelled financial posting may create a snapshot. */
export function canCaptureInitialOrderPartnerBalanceSnapshot(
  order: Pick<StatementOrder, 'partnerBalanceSnapshot' | 'status'>
) {
  return !order.partnerBalanceSnapshot && order.status !== 'draft' && order.status !== 'cancelled'
}

function roundSnapshotAmount(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * SNAPSHOT_PRECISION) / SNAPSHOT_PRECISION
}

function normalizedBalances(data: PartnerAccountStatementData) {
  return new Map(
    getPartnerAccountStatementClosingBalances(data).map(({ currency, closingBalance }) => [
      currency.toLowerCase(),
      { currency: currency.toLowerCase(), balance: roundSnapshotAmount(closingBalance) }
    ])
  )
}

/**
 * Creates the immutable print snapshot from two versions of the exact
 * partner-statement ledger. Currencies remain separate; no exchange-rate
 * conversion or cross-currency netting is performed here.
 */
export function createOrderPartnerBalanceSnapshot(
  beforeData: PartnerAccountStatementData,
  afterData: PartnerAccountStatementData,
  capturedAt: string,
  includeCurrencies: readonly string[] = []
): OrderPartnerBalanceSnapshot {
  const beforeBalances = normalizedBalances(beforeData)
  const afterBalances = normalizedBalances(afterData)
  const currencies = new Set([
    ...beforeBalances.keys(),
    ...afterBalances.keys(),
    ...includeCurrencies.map((currency) => currency.toLowerCase())
  ])

  return {
    version: 1,
    capturedAt,
    balances: Array.from(currencies)
      .sort((left, right) => left.localeCompare(right))
      .map((currency) => ({
        currency: (afterBalances.get(currency)?.currency || beforeBalances.get(currency)?.currency || currency) as OrderPartnerBalanceSnapshot['balances'][number]['currency'],
        before: beforeBalances.get(currency)?.balance ?? 0,
        after: afterBalances.get(currency)?.balance ?? 0
      }))
  }
}

/**
 * Removes the new order and every financial source that belongs to its first
 * posting bundle. This lets the saved result be calculated from the same
 * statement ledger as the live balance rather than from a hand-written
 * `total - paid` formula.
 */
export function withoutOrderPartnerStatementPosting(
  data: PartnerAccountStatementData,
  order: StatementOrder
): PartnerAccountStatementData {
  const sourceType = 'customerId' in order ? 'sales_order' : 'purchase_order'
  const linkedLoanIds = new Set([order.linkedLoanId].filter((id): id is string => Boolean(id)))
  const returnIds = new Set(
    (data.salesOrderReturns || [])
      .filter((orderReturn) => orderReturn.orderId === order.id)
      .map((orderReturn) => orderReturn.id)
  )

  return {
    ...data,
    salesOrders: data.salesOrders.filter((candidate) => candidate.id !== order.id),
    purchaseOrders: data.purchaseOrders.filter((candidate) => candidate.id !== order.id),
    statementOrders: data.statementOrders?.filter((candidate) => candidate.id !== order.id),
    salesOrderReturns: data.salesOrderReturns?.filter((orderReturn) => orderReturn.orderId !== order.id),
    salesOrderReturnItems: data.salesOrderReturnItems?.filter((item) => !returnIds.has(item.returnId) && item.orderId !== order.id),
    loans: data.loans?.filter((loan) => loan.orderId !== order.id && !linkedLoanIds.has(loan.id)),
    loanPayments: data.loanPayments?.filter((payment) => !linkedLoanIds.has(payment.loanId)),
    settlementTransactions: data.settlementTransactions?.filter((transaction) => !(
      transaction.sourceType === sourceType && transaction.sourceRecordId === order.id
    )),
    agentCommissionEntries: data.agentCommissionEntries?.filter((entry) => entry.orderId !== order.id),
    agentProductCommissionEntries: data.agentProductCommissionEntries?.filter((entry) => entry.orderId !== order.id),
    linkedOrderCodes: data.linkedOrderCodes
      ? Object.fromEntries(Object.entries(data.linkedOrderCodes).filter(([orderId]) => orderId !== order.id))
      : undefined
  }
}

/** Captures an order's before/after partner balance from its posted ledger sources. */
export function createPartnerBalanceSnapshotForPostedOrder(
  data: PartnerAccountStatementData,
  order: StatementOrder,
  capturedAt: string
) {
  return createOrderPartnerBalanceSnapshot(
    withoutOrderPartnerStatementPosting(data, order),
    data,
    capturedAt,
    [order.currency]
  )
}

function compareStatementEntries(
  left: Pick<PartnerAccountStatementEntry, 'date' | 'reference' | 'id'>,
  right: Pick<PartnerAccountStatementEntry, 'date' | 'reference' | 'id'>
) {
  const dateDifference = new Date(left.date).getTime() - new Date(right.date).getTime()
  return dateDifference || left.reference.localeCompare(right.reference) || left.id.localeCompare(right.id)
}

function isOrderDocumentPosting(entry: PartnerAccountStatementEntry, order: StatementOrder) {
  return entry.source?.recordType === 'order'
    && entry.source.recordId === order.id
    && entry.kind === ('customerId' in order ? 'sales_order' : 'purchase_order')
}

function isLinkedLoanPosting(entry: PartnerAccountStatementEntry, order: StatementOrder) {
  return Boolean(
    order.linkedLoanId
      && entry.source?.recordType === 'loan'
      && entry.source.recordId === order.linkedLoanId
      && entry.kind === 'loan_disbursal'
  )
}

/**
 * Reconstructs the historical balances for an order created before immutable
 * snapshots existed. It uses the same chronological partner-account ledger as
 * the Account Statement and is deliberately read-only: derived legacy values
 * are never written back as if they had been captured at posting time.
 *
 * A financed order is represented by its linked loan disbursal; other orders
 * are represented by the order-document row. Later collections, returns, and
 * other changes linked to the order are intentionally excluded, so "after"
 * means immediately after the original posting rather than today's balance.
 */
export function deriveLegacyOrderPartnerBalanceSnapshot(
  data: PartnerAccountStatementData,
  order: StatementOrder
): OrderPartnerBalanceSnapshot | null {
  const ledgers = buildPartnerAccountStatementLedger({ ...data, period: { type: 'allTime' } })
  const allEntries = ledgers.flatMap((ledger) => ledger.entries)
  const loanPostings = allEntries.filter((entry) => isLinkedLoanPosting(entry, order))
  const documentPostings = allEntries.filter((entry) => isOrderDocumentPosting(entry, order))
  const postings = loanPostings.length > 0 ? loanPostings : documentPostings

  if (postings.length === 0) return null

  const sortedPostings = postings.slice().sort(compareStatementEntries)
  const firstPosting = sortedPostings[0]
  const lastPosting = sortedPostings[sortedPostings.length - 1]
  const currencies = new Set([order.currency.toLowerCase(), ...ledgers.map((ledger) => ledger.currency.toLowerCase())])

  return {
    version: 1,
    capturedAt: order.createdAt,
    balances: Array.from(currencies)
      .sort((left, right) => left.localeCompare(right))
      .map((currency) => {
        const ledger = ledgers.find((candidate) => candidate.currency.toLowerCase() === currency)
        const entries = ledger?.entries || []
        const before = entries
          .filter((entry) => compareStatementEntries(entry, firstPosting) < 0)
          .reduce((total, entry) => total + entry.delta, 0)
        const after = entries
          .filter((entry) => compareStatementEntries(entry, lastPosting) <= 0)
          .reduce((total, entry) => total + entry.delta, 0)

        return {
          currency: (ledger?.currency || currency) as OrderPartnerBalanceSnapshot['balances'][number]['currency'],
          before: roundSnapshotAmount(before),
          after: roundSnapshotAmount(after)
        }
      })
  }
}
