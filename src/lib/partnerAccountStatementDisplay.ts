import type { PartnerAccountStatementCurrencyLedger } from '@/lib/partnerAccountStatement'

type LedgerEntry = PartnerAccountStatementCurrencyLedger['entries'][number]

export type PartnerAccountStatementDisplayEntry = LedgerEntry & {
  debit: number
  credit: number
  /** The original ledger movements represented by this printed/screen row. */
  sourceEntryIds: string[]
}

function localStatementDay(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function orderKey(entry: LedgerEntry): string | null {
  if (entry.source?.recordType !== 'order') return null
  const { recordId } = entry.source
  if (entry.kind === 'sales_order' && entry.id === `sales-order:${recordId}`) {
    return `sales_order:${recordId}`
  }
  if (entry.kind === 'purchase_order' && entry.id === `purchase-order:${recordId}`) {
    return `purchase_order:${recordId}`
  }
  return null
}

function paymentOrderKey(entry: LedgerEntry): string | null {
  if (entry.source?.recordType !== 'order' || !entry.id.startsWith('payment:')) return null
  const { recordId } = entry.source
  if (
    entry.kind === 'incoming_payment' && entry.delta < 0 &&
    (entry.descriptionKey === 'paymentReceived' ||
      entry.descriptionKey === 'advancePaymentReceived' ||
      entry.descriptionKey === 'orderLoanDownPaymentReceived')
  ) return `sales_order:${recordId}`
  if (entry.kind === 'outgoing_payment' && entry.delta > 0 && entry.descriptionKey === 'paymentMade') {
    return `purchase_order:${recordId}`
  }
  return null
}

/**
 * Combines same-day order settlements into one visible row. The source ledger,
 * its totals, and every payment/reversal entry stay intact for accounting.
 * Itemized sale rows have no document row to receive the whole payment and
 * therefore retain their separate payment rows.
 */
export function buildPartnerAccountStatementDisplayEntries(
  ledger: PartnerAccountStatementCurrencyLedger,
  options: { combineOrderPayments?: boolean } = {}
): PartnerAccountStatementDisplayEntry[] {
  const orders = new Map<string, LedgerEntry>()
  if (options.combineOrderPayments !== false) {
    for (const entry of ledger.entries) {
      const key = orderKey(entry)
      if (key) orders.set(key, entry)
    }
  }

  const paymentsByOrder = new Map<string, LedgerEntry[]>()
  const combinedPaymentIds = new Set<string>()
  for (const entry of ledger.entries) {
    const key = paymentOrderKey(entry)
    const order = key ? orders.get(key) : undefined
    const orderDay = order && localStatementDay(order.date)
    if (!key || !orderDay || orderDay !== localStatementDay(entry.date)) continue
    const payments = paymentsByOrder.get(key) || []
    payments.push(entry)
    paymentsByOrder.set(key, payments)
    combinedPaymentIds.add(entry.id)
  }

  let runningBalance = ledger.openingBalance
  return ledger.entries.flatMap((entry) => {
    if (combinedPaymentIds.has(entry.id)) return []

    const key = orderKey(entry)
    const payments = key ? paymentsByOrder.get(key) || [] : []
    const sourceEntries = [entry, ...payments]
    const debit = sourceEntries.reduce((sum, source) => sum + Math.max(source.delta, 0), 0)
    const credit = sourceEntries.reduce((sum, source) => sum + Math.max(-source.delta, 0), 0)
    const delta = sourceEntries.reduce((sum, source) => sum + source.delta, 0)
    runningBalance += delta
    return [{
      ...entry,
      delta,
      debit,
      credit,
      runningBalance,
      sourceEntryIds: sourceEntries.map((source) => source.id)
    }]
  })
}
