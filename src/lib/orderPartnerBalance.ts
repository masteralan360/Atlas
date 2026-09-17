import type { CurrencyCode, PurchaseOrder, SalesOrder } from '@/local-db/models'
import {
  buildPartnerAccountStatementLedger,
  type PartnerAccountStatementData,
  type PartnerAccountStatementEntry
} from '@/lib/partnerAccountStatement'
import type { OrderPartnerBalanceAtPostingDemand } from '@/lib/orderPartnerBalancePrintDemand'

type StatementOrder = SalesOrder | PurchaseOrder

export interface OrderPartnerBalanceAtPosting {
  balances: Array<{
    currency: CurrencyCode
    before?: number
    after?: number
  }>
}

const BALANCE_PRECISION = 1_000_000

function roundBalanceAmount(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * BALANCE_PRECISION) / BALANCE_PRECISION
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
      // Order-financing loans are deliberately presented as sales-order
      // entries in the partner statement, while standalone loans use
      // loan_disbursal. Both are the original posting for the linked loan.
      && (entry.kind === 'loan_disbursal' || entry.kind === 'sales_order')
  )
}

/**
 * Reconstructs an order's before/after balances from the chronological
 * Partner Account Statement ledger. A financed order uses its linked loan
 * disbursal; other orders use their document posting. Later collections,
 * returns, and other linked activity are excluded so "after" means
 * immediately after the order's original posting.
 */
export function deriveOrderPartnerBalanceAtPosting(
  data: PartnerAccountStatementData,
  order: StatementOrder,
  demand: OrderPartnerBalanceAtPostingDemand = { before: true, after: true }
): OrderPartnerBalanceAtPosting | null {
  if (!demand.before && !demand.after) return null

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
    balances: Array.from(currencies)
      .sort((left, right) => left.localeCompare(right))
      .map((currency) => {
        const ledger = ledgers.find((candidate) => candidate.currency.toLowerCase() === currency)
        const entries = ledger?.entries || []
        const balance = {
          currency: (ledger?.currency || currency) as CurrencyCode
        } as OrderPartnerBalanceAtPosting['balances'][number]

        if (demand.before) {
          const before = entries
            .filter((entry) => compareStatementEntries(entry, firstPosting) < 0)
            .reduce((total, entry) => total + entry.delta, 0)
          balance.before = roundBalanceAmount(before)
        }

        if (demand.after) {
          const after = entries
            .filter((entry) => compareStatementEntries(entry, lastPosting) <= 0)
            .reduce((total, entry) => total + entry.delta, 0)
          balance.after = roundBalanceAmount(after)
        }

        return balance
      })
  }
}
