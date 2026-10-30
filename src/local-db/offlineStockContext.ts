import Dexie, { type Transaction } from 'dexie'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

export type StockOperationKind = 'adjustment' | 'checkout' | 'transfer' | 'sales_order' | 'purchase_order' | 'return' | 'exchange' | 'product' | 'storage' | 'batch'
export interface StockOperationEffect {
  table: string
  id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}
export interface StockOperationRpc { name: string; args: Record<string, unknown> }
export interface StockOperationContext {
  id: string
  workspaceId: string
  kind: StockOperationKind
  effects: Map<string, StockOperationEffect>
  rpc?: StockOperationRpc
  count?: { productId: string; storageId: string; quantity: number; version: number }
}

type StockTransaction = Transaction & { atlasStockOperation?: StockOperationContext; parent?: StockTransaction }

/** Context belongs to the Dexie transaction, never to a global async flag. */
export function currentStockOperation(workspaceId?: string): StockOperationContext | undefined {
  let transaction = Dexie.currentTransaction as StockTransaction | undefined
  while (transaction) {
    const context = transaction.atlasStockOperation
    if (context) return !workspaceId || context.workspaceId === workspaceId ? context : undefined
    transaction = transaction.parent
  }
}

export function attachStockOperation(transaction: Transaction, context: StockOperationContext) {
  ;(transaction as StockTransaction).atlasStockOperation = context
}

/** Local execution is allowed only inside a durable Cloud/Hybrid operation. */
export function usesLocalStockExecution(workspaceId?: string | null) {
  return isLocalWorkspaceMode(workspaceId) || !!(workspaceId && currentStockOperation(workspaceId))
}

export function setStockOperationRpc(workspaceId: string, rpc: StockOperationRpc) {
  const context = currentStockOperation(workspaceId)
  if (context) context.rpc = rpc
}

export const STOCK_EFFECT_TABLES = new Set([
  'business_partners', 'customers', 'suppliers', 'price_books', 'price_book_items',
  'product_unit_conversions', 'price_book_unit_prices', 'products', 'product_uoms', 'product_barcodes', 'product_storage_assignments',
  'inventory', 'inventory_transactions', 'stock_batches', 'inventory_transfer_batches',
  'sales', 'sale_items', 'sales_exchange', 'sale_returns', 'sale_return_items', 'sale_product_exchanges',
  'sales_orders', 'purchase_orders', 'order_returns', 'order_return_items', 'order_installments',
  'payment_transactions', 'loans', 'loan_installments', 'loan_payments', 'storages',
])

/** Keep the transaction alive only while loading a module, never around a task
 * that opens another Dexie transaction (which would deadlock).
 */
export function awaitStockDependency<T>(module: Promise<T>): Promise<T> {
  return currentStockOperation() ? Dexie.waitFor(module) : module
}
