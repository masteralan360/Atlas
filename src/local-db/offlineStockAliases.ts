import type { StockOperationEffect } from './offlineStockContext'
import { db } from './database'

export interface StockOperationAlias { table: string; from: string; to: string }
export type StockOperationAliases = StockOperationAlias[]

const aliasKey = (workspaceId: string, actorId: string, id: string) => `stock-alias:v2:${workspaceId}:${actorId}:${id}`

/** Read only identities referenced by this operation, never the whole history. */
export async function readStockAliases(workspaceId: string, actorId: string, inputs: unknown[]) {
  const ids = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string' && /^[\da-f]{8}-[\da-f-]{27}$/i.test(value)) ids.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, nested]) => { visit(key); visit(nested) })
  }
  inputs.forEach(visit)
  const stored = await db.app_settings.bulkGet([...ids].map(id => aliasKey(workspaceId, actorId, id)))
  return stored.flatMap(row => row ? JSON.parse(row.value) as StockOperationAliases : [])
}

export async function persistStockAliases(workspaceId: string, actorId: string, aliases: StockOperationAliases) {
  for (const from of new Set(aliases.map(alias => alias.from))) {
    const key = aliasKey(workspaceId, actorId, from)
    const stored = await db.app_settings.get(key)
    const previous: StockOperationAliases = stored ? JSON.parse(stored.value) : []
    for (const alias of aliases.filter(item => item.from === from)) {
      const existing = previous.find(item => item.table === alias.table)
      if (existing && existing.to !== alias.to) throw new Error('Conflicting authoritative stock identity')
      if (!existing) previous.push(alias)
    }
    await db.app_settings.put({ key, workspaceId, value: JSON.stringify(previous) })
  }
}

const references: Record<string, string> = {
  productId: 'products', storageId: 'storages', parentProductId: 'products',
  saleId: 'sales', saleItemId: 'sale_items', replacementSaleItemId: 'sale_items', returnSaleItemId: 'sale_items',
  returnId: 'sale_returns', loanId: 'loans', linkedLoanId: 'loans', installmentId: 'loan_installments',
  loanPaymentId: 'loan_payments', paymentTransactionId: 'payment_transactions',
  settlementTransactionId: 'payment_transactions', originationTransactionId: 'payment_transactions',
  reversalOfTransactionId: 'payment_transactions', reversalTransactionId: 'payment_transactions',
  batchId: 'stock_batches', saleReturnId: 'sale_returns',
}

export function resolveStockAlias(aliases: StockOperationAliases, table: string, id: unknown): unknown {
  if (typeof id !== 'string') return id
  return aliases.find(alias => alias.table === table && alias.from === id)?.to ?? id
}

/** IDs may intentionally be shared by different tables. Never replace UUIDs globally. */
export function resolveStockRow(aliases: StockOperationAliases, table: string, row: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, references[key] ? resolveStockAlias(aliases, references[key], nested) : visit(nested)]))
  }
  const result = visit(row) as Record<string, unknown>
  result.id = resolveStockAlias(aliases, table, row.id)
  if (table === 'payment_transactions' && ['loan_payment', 'simple_loan', 'loan_installment', 'loan', 'installment_payment'].includes(String(row.sourceType))) {
    result.sourceRecordId = resolveStockAlias(aliases, 'loans', row.sourceRecordId)
    result.sourceSubrecordId = resolveStockAlias(aliases, 'loan_payments', row.sourceSubrecordId)
  }
  return result
}

export function resolveStockEffect(aliases: StockOperationAliases, effect: StockOperationEffect): StockOperationEffect {
  return { ...effect, id: resolveStockAlias(aliases, effect.table, effect.id) as string,
    before: effect.before ? resolveStockRow(aliases, effect.table, effect.before) : null,
    after: effect.after ? resolveStockRow(aliases, effect.table, effect.after) : null }
}
