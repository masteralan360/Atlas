import { toCamelCase } from '@/lib/utils'
import { formatDirectTransactionVoucherNumber } from '@/lib/directTransactionVoucher'
import { isReportablePaymentTransaction } from '@/lib/financialReportability'
import type { PaymentTransactionReversalState } from '@/lib/paymentReversals'
import type { PaymentTransaction } from './models'
import { db } from './database'
import { filterBusinessPartnersByGroupPrivacy } from './businessPartnerAccess'
import { readDirectTransactionRpc, usesRemoteDirectTransactions } from './directTransactionReads'

export interface DirectTransactionPageQuery {
  page: number
  pageSize: number
  search: string
  direction: 'all' | 'incoming' | 'outgoing'
  start?: string
  end?: string
}
export interface DirectTransactionPageRow {
  transaction: PaymentTransaction
  reversedAmount: number
  canReverse: boolean
  counterpartyKind: 'agent' | 'business_partner' | 'external'
}
export interface DirectTransactionPage { items: DirectTransactionPageRow[]; totalCount: number }

export function directTransactionReversalState(row: DirectTransactionPageRow): PaymentTransactionReversalState {
  const originalAmount = Math.abs(row.transaction.amount)
  const remainingAmount = Math.max(0, originalAmount - row.reversedAmount)
  return { originalAmount, remainingAmount, reversedAmount: row.reversedAmount, amountPolicy: 'partial_or_full',
    status: remainingAmount <= 0.000001 ? 'fully_reversed' : row.reversedAmount > 0.000001 ? 'partially_reversed' : 'available' }
}

export async function readLocalDirectTransactions(workspaceId: string, query: DirectTransactionPageQuery): Promise<DirectTransactionPage> {
  const size = Math.min(100, Math.max(1, query.pageSize))
  const startIndex = (Math.max(1, query.page) - 1) * size
  const page: PaymentTransaction[] = []
  let totalCount = 0
  const search = query.search.trim().toLocaleLowerCase()
  const source = () => db.payment_transactions.where('[workspaceId+sourceType+paidAt+createdAt+id]')
    // Older cached timestamptz values can use +00:00 instead of .000Z. Include
    // the boundary second in the index range, then compare exact instants.
    .between([workspaceId, 'direct_transaction', query.start?.slice(0, 19) ?? '', '', ''],
      [workspaceId, 'direct_transaction', query.end ? query.end.slice(0, 19) + '\uffff' : '\uffff', '\uffff', '\uffff'], true, true).reverse()
  for (let offset = 0; ; offset += 100) {
    const batch = await source().offset(offset).limit(100).toArray()
    const partnerIds = [...new Set(batch.flatMap(row => typeof row.metadata?.businessPartnerId === 'string' ? [row.metadata.businessPartnerId] : []))]
    const partners = (await db.business_partners.bulkGet(partnerIds)).filter(partner => partner?.workspaceId === workspaceId)
    const visible = new Set((await filterBusinessPartnersByGroupPrivacy(workspaceId, partners as NonNullable<typeof partners[number]>[])).map(p => p.id))
    for (const row of batch) {
      if (!isReportablePaymentTransaction(row) || (query.start && Date.parse(row.paidAt) < Date.parse(query.start))
        || (query.end && Date.parse(row.paidAt) >= Date.parse(query.end))
        || (query.direction !== 'all' && row.direction !== query.direction)) continue
      if (typeof row.metadata?.businessPartnerId === 'string' && !visible.has(row.metadata.businessPartnerId)) continue
      if (search && ![row.referenceLabel, row.counterpartyName, row.note, row.paymentMethod, formatDirectTransactionVoucherNumber(row)]
        .some(value => value?.toLocaleLowerCase().includes(search))) continue
      if (totalCount >= startIndex && page.length < size) page.push(row)
      totalCount += 1
    }
    if (batch.length < 100) break
  }
  const items: DirectTransactionPageRow[] = []
  for (const transaction of page) {
    let reversedAmount = 0
    await db.payment_transactions.where('reversalOfTransactionId').equals(transaction.id).each(row => {
      if (row.workspaceId === workspaceId && isReportablePaymentTransaction(row)) reversedAmount += Math.abs(row.amount)
    })
    const partnerId = transaction.metadata?.businessPartnerId
    const partner = typeof partnerId === 'string' ? await db.business_partners.get(partnerId) : undefined
    const family = await db.payment_transactions.where('[workspaceId+sourceType+sourceRecordId]')
      .equals([workspaceId, 'direct_transaction', transaction.sourceRecordId])
      .filter(row => isReportablePaymentTransaction(row) && row.sourceSubrecordId === transaction.sourceSubrecordId).toArray()
    const latest = family.filter(row => !row.reversalOfTransactionId && row.amount - family.reduce((sum, r) =>
      r.reversalOfTransactionId === row.id ? sum + Math.abs(r.amount) : sum, 0) > 0.000001)
      .sort((a, b) => b.paidAt.localeCompare(a.paidAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
    items.push({ transaction, reversedAmount,
      canReverse: !transaction.reversalOfTransactionId && latest?.id === transaction.id,
      counterpartyKind: transaction.metadata?.counterpartyKind === 'agent' || partner?.role === 'agent' ? 'agent'
        : partnerId ? 'business_partner' : 'external' })
  }
  return { items, totalCount }
}

export async function fetchDirectTransactionsPage(workspaceId: string, query: DirectTransactionPageQuery, signal?: AbortSignal): Promise<DirectTransactionPage> {
  if (!usesRemoteDirectTransactions(workspaceId)) return readLocalDirectTransactions(workspaceId, query)
  return readDirectTransactionRpc<{ items: Array<Record<string, unknown>>; totalCount: number }, DirectTransactionPage>(workspaceId,
    'list_direct_transactions_page', { p_search: query.search.trim() || null, p_direction: query.direction,
      p_start: query.start ?? null, p_end: query.end ?? null, p_page: query.page, p_page_size: query.pageSize },
    ['payment_transactions'], signal, async raw => {
    if (!Array.isArray(raw.items) || !Number.isSafeInteger(Number(raw.totalCount)) || Number(raw.totalCount) < 0) throw new Error('Invalid transaction page')
    const items = raw.items.map(row => {
      const transaction = { ...toCamelCase(row.transaction as Record<string, unknown>), syncStatus: 'synced',
        lastSyncedAt: new Date().toISOString() } as PaymentTransaction
      if (transaction.workspaceId !== workspaceId || transaction.sourceType !== 'direct_transaction'
        || !transaction.id || !Number.isFinite(Number(transaction.amount)) || !Number.isFinite(Number(row.reversedAmount))) throw new Error('Invalid transaction')
      for (const field of ['paidAt', 'createdAt', 'updatedAt'] as const) transaction[field] = new Date(transaction[field]).toISOString()
      return { transaction, reversedAmount: Number(row.reversedAmount), canReverse: row.canReverse === true,
        counterpartyKind: row.counterpartyKind === 'agent' ? 'agent' as const
          : row.counterpartyKind === 'business_partner' ? 'business_partner' as const : 'external' as const }
  })
  await db.transaction('rw', db.payment_transactions, async () => {
    for (const { transaction } of items) {
      const cached = await db.payment_transactions.get(transaction.id)
      if (cached?.syncStatus === 'pending' || cached?.syncStatus === 'conflict' || (cached && cached.version > transaction.version)) continue
      signal?.throwIfAborted()
      await db.payment_transactions.put(transaction)
    }
  })
  return { items, totalCount: Number(raw.totalCount) }
  })
}

