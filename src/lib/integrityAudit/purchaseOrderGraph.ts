import { getExistingLocalModeSqliteConnectionForAudit } from '@/local-db/localModeSqlite'
import { getSupabaseClientForTable, getSupabaseRemoteTableName, getWorkspaceScopedPartnerReadRpc } from '@/lib/supabaseSchema'
import { toCamelCase } from '@/lib/utils'
import type {
  InventoryTransaction, Loan, LoanPayment, LoanInstallment, OrderInstallment, PaymentAccount,
  PaymentAccountMovement, PaymentTransaction, Product, PurchaseOrder, PurchaseOrderItem,
  StockBatch, Supplier
} from '@/local-db/models'

export interface PurchaseOrderTransactionGraph {
  order: PurchaseOrder | null
  products: Product[]
  suppliers: Supplier[]
  partners: Array<{ id: string; workspaceId: string; isDeleted?: boolean }>
  inventoryMovements: InventoryTransaction[]
  stockBatches: StockBatch[]
  payments: PaymentTransaction[]
  accountMovements: PaymentAccountMovement[]
  paymentAccounts: PaymentAccount[]
  loans: Loan[]
  loanPayments: LoanPayment[]
  loanInstallments: LoanInstallment[]
  orderInstallments: OrderInstallment[]
}

type Row = Record<string, unknown>

async function readCloud(table: string, workspaceId: string, column: string, values: string[]): Promise<Row[]> {
  if (!values.length) return []
  const client = getSupabaseClientForTable(table)
  const scopedReadRpc = getWorkspaceScopedPartnerReadRpc(table)
  const rows: Row[] = []
  for (let offset = 0; ; offset += 500) {
    const query = scopedReadRpc
      ? (client.rpc(scopedReadRpc, { p_workspace_id: workspaceId }) as any)
      : (client.from(getSupabaseRemoteTableName(table)) as any).select('*').eq('workspace_id', workspaceId)
    const filtered = values.length === 1 ? query.eq(column, values[0]) : query.in(column, values)
    const { data, error } = await filtered.order('id').range(offset, offset + 499)
    if (error) throw new Error(`Audit could not read ${table}: ${error.message}`)
    rows.push(...(data ?? []).map((row: Row) => toCamelCase(row) as Row))
    if (!data || data.length < 500) return rows
  }
}

async function readSqliteWorkspace(workspaceId: string): Promise<Map<string, Row[]>> {
  const connection = await getExistingLocalModeSqliteConnectionForAudit()
  if (!connection) throw new Error('The local SQLite database is unavailable for this audit.')
  const rows = await connection.select<Array<{ entity_type: string; payload: string }>>(
    'SELECT entity_type, payload FROM local_entities WHERE workspace_id = $1', [workspaceId]
  )
  const result = new Map<string, Row[]>()
  for (const row of rows) {
    const bucket = result.get(row.entity_type) ?? []
    bucket.push(JSON.parse(row.payload) as Row)
    result.set(row.entity_type, bucket)
  }
  return result
}

/** Reads only persisted Purchase Order records and effects; it does not hydrate or mutate caches. */
export async function resolvePurchaseOrderTransactionGraph(
  workspaceId: string, orderId: string, source: 'supabase' | 'sqlite'
): Promise<PurchaseOrderTransactionGraph> {
  const local = source === 'sqlite' ? await readSqliteWorkspace(workspaceId) : null
  const read = async <T>(table: string, column: string, values: string[]): Promise<T[]> => {
    if (local) return (local.get(table) ?? []).filter(row => values.includes(String(row[column] ?? ''))) as T[]
    return readCloud(table, workspaceId, column.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), values) as Promise<T[]>
  }

  const order = (await read<PurchaseOrder>('purchase_orders', 'id', [orderId]))[0] ?? null
  const [supplierRows, inventoryMovements, stockBatches, directPayments, loansByOrder, loansById, orderInstallments] = await Promise.all([
    read<Supplier>('suppliers', 'id', order?.supplierId ? [order.supplierId] : []),
    read<InventoryTransaction>('inventory_transactions', 'referenceId', [orderId]),
    read<StockBatch>('stock_batches', 'sourcePurchaseOrderId', [orderId]),
    read<PaymentTransaction>('payment_transactions', 'sourceRecordId', [orderId]),
    read<Loan>('loans', 'orderId', [orderId]),
    read<Loan>('loans', 'id', order?.linkedLoanId ? [order.linkedLoanId] : []),
    read<OrderInstallment>('order_installments', 'orderId', [orderId])
  ])
  const supplier = supplierRows[0]
  const partnerIds = [...new Set([
    ...(order?.businessPartnerId ? [order.businessPartnerId] : []),
    ...(supplier?.businessPartnerId ? [supplier.businessPartnerId] : [])
  ])]
  const partners = partnerIds.length === 0 ? [] : await read<PurchaseOrderTransactionGraph['partners'][number]>('business_partners', 'id', partnerIds)
  const loans = [...new Map([...loansByOrder, ...loansById].map(row => [row.id, row])).values()]
  const loanIds = loans.map(row => row.id)
  const orderItems = Array.isArray(order?.items) ? order.items as PurchaseOrderItem[] : []
  const productIds = [...new Set(orderItems.map(item => item?.productId).filter((id): id is string => typeof id === 'string' && !!id))]
  const [products, loanPayments, loanInstallments, loanTransactions, orderSubrecordPayments] = await Promise.all([
    read<Product>('products', 'id', productIds),
    read<LoanPayment>('loan_payments', 'loanId', loanIds),
    read<LoanInstallment>('loan_installments', 'loanId', loanIds),
    read<PaymentTransaction>('payment_transactions', 'sourceRecordId', loanIds),
    read<PaymentTransaction>('payment_transactions', 'sourceSubrecordId', orderInstallments.map(row => row.id))
  ])
  const linkedPaymentIds = loanPayments.flatMap(row => [row.paymentTransactionId, row.reversalTransactionId].filter((id): id is string => !!id))
  const paymentById = await read<PaymentTransaction>('payment_transactions', 'id', linkedPaymentIds)
  const originalPayments = [...new Map([...directPayments, ...orderSubrecordPayments, ...loanTransactions, ...paymentById]
    .map(row => [row.id, row])).values()]
  const paymentReversals = await read<PaymentTransaction>('payment_transactions', 'reversalOfTransactionId', originalPayments.map(row => row.id))
  const payments = [...new Map([...originalPayments, ...paymentReversals].map(row => [row.id, row])).values()]
  const [accountMovements, paymentAccounts] = await Promise.all([
    read<PaymentAccountMovement>('payment_account_movements', 'paymentTransactionId', payments.map(row => row.id)),
    read<PaymentAccount>('payment_accounts', 'id', [...new Set(payments.flatMap(row => row.accountId ? [row.accountId] : []))])
  ])

  return {
    order, products, suppliers: supplierRows, partners, inventoryMovements, stockBatches,
    payments, accountMovements, paymentAccounts, loans, loanPayments, loanInstallments, orderInstallments
  }
}
