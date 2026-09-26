import { getExistingLocalModeSqliteConnectionForAudit } from '@/local-db/localModeSqlite'
import { getSupabaseClientForTable, getSupabaseRemoteTableName, getWorkspaceScopedPartnerReadRpc } from '@/lib/supabaseSchema'
import { toCamelCase } from '@/lib/utils'
import { v5 as uuidv5 } from 'uuid'
import type {
  SalesOrder, Product, InventoryTransaction, PaymentTransaction, Loan, LoanPayment,
  LoanInstallment, OrderInstallment, OrderReturn, OrderReturnItem, PaymentAccountMovement,
  PaymentAccount, SalesOrderAgentAssignment, AgentCommissionEntry, AgentProductCommissionEntry
} from '@/local-db/models'

export interface SalesOrderTransactionGraph {
  order: SalesOrder | null
  products: Product[]
  customers: Array<{ id: string; workspaceId: string; isDeleted?: boolean }>
  partners: Array<{ id: string; workspaceId: string; isDeleted?: boolean }>
  inventoryMovements: InventoryTransaction[]
  payments: PaymentTransaction[]
  accountMovements: PaymentAccountMovement[]
  paymentAccounts: PaymentAccount[]
  loans: Loan[]
  loanPayments: LoanPayment[]
  loanInstallments: LoanInstallment[]
  orderInstallments: OrderInstallment[]
  returns: OrderReturn[]
  returnItems: OrderReturnItem[]
  assignments: SalesOrderAgentAssignment[]
  commissions: AgentCommissionEntry[]
  productCommissions: AgentProductCommissionEntry[]
}

type Row = Record<string, unknown>

/** No cache hydration, mutation or sync is allowed in this resolver. */
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
  const rows = await connection.select<Array<{ entity_type: string; payload: string }>[number]>(
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

export async function resolveSalesOrderTransactionGraph(
  workspaceId: string, orderId: string, source: 'supabase' | 'sqlite'
): Promise<SalesOrderTransactionGraph> {
  const local = source === 'sqlite' ? await readSqliteWorkspace(workspaceId) : null
  const read = async <T>(table: string, column: string, values: string[]): Promise<T[]> => {
    if (local) return (local.get(table) ?? []).filter(row => values.includes(String(row[column] ?? ''))) as T[]
    return readCloud(table, workspaceId, column.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), values) as Promise<T[]>
  }
  const order = (await read<SalesOrder>('sales_orders', 'id', [orderId]))[0] ?? null
  const returns = await read<OrderReturn>('order_returns', 'orderId', [orderId])
  const returnIds = returns.map(row => row.id)
  const [returnItemsByOrder, returnItemsByReturn, loanByOrder, loanById, orderPayments, returnPayments, inventoryByReference, inventoryById,
    products, customers, partners, orderInstallments, assignments, commissions, productCommissions] = await Promise.all([
    read<OrderReturnItem>('order_return_items', 'orderId', [orderId]),
    read<OrderReturnItem>('order_return_items', 'returnId', returnIds),
    read<Loan>('loans', 'orderId', [orderId]),
    read<Loan>('loans', 'id', order?.linkedLoanId ? [order.linkedLoanId] : []),
    read<PaymentTransaction>('payment_transactions', 'sourceRecordId', [orderId]),
    read<PaymentTransaction>('payment_transactions', 'sourceRecordId', returnIds),
    read<InventoryTransaction>('inventory_transactions', 'referenceId', [orderId, ...returnIds]),
    read<InventoryTransaction>('inventory_transactions', 'id', (Array.isArray(order?.items) ? order.items : [])
      .filter(item => item?.productId && (item.storageId || order?.sourceStorageId))
      .map(item => uuidv5(`sales-order:${orderId}:${item.productId}:${item.storageId || order?.sourceStorageId}`, 'd45e710c-a5f6-4aac-9f11-4522932aeb9e'))),
    read<Product>('products', 'id', [...new Set((Array.isArray(order?.items) ? order.items : []).map(item => item.productId))]),
    read<SalesOrderTransactionGraph['customers'][number]>('customers', 'id', order?.customerId ? [order.customerId] : []),
    read<SalesOrderTransactionGraph['partners'][number]>('business_partners', 'id', order?.businessPartnerId ? [order.businessPartnerId] : []),
    read<OrderInstallment>('order_installments', 'orderId', [orderId]),
    read<SalesOrderAgentAssignment>('sales_order_agent_assignments', 'orderId', [orderId]),
    read<AgentCommissionEntry>('agent_commission_entries', 'orderId', [orderId]),
    read<AgentProductCommissionEntry>('agent_product_commission_entries', 'orderId', [orderId])
  ])
  const returnItems = [...new Map([...returnItemsByOrder, ...returnItemsByReturn].map(row => [row.id, row])).values()]
  const inventoryMovements = [...new Map([...inventoryByReference, ...inventoryById].map(row => [row.id, row])).values()]
  const loans = [...new Map([...loanByOrder, ...loanById].map(row => [row.id, row])).values()]
  const loanIds = loans.map(row => row.id)
  const [loanPayments, loanInstallments, loanTransactions, commissionTransactions] = await Promise.all([
    read<LoanPayment>('loan_payments', 'loanId', loanIds),
    read<LoanInstallment>('loan_installments', 'loanId', loanIds),
    read<PaymentTransaction>('payment_transactions', 'sourceRecordId', loanIds),
    read<PaymentTransaction>('payment_transactions', 'sourceSubrecordId', commissions.map(row => row.id))
  ])
  const linkedPaymentIds = loanPayments.flatMap(row => [row.paymentTransactionId, row.reversalTransactionId].filter((id): id is string => !!id))
  const paymentById = await read<PaymentTransaction>('payment_transactions', 'id', linkedPaymentIds)
  const originalPayments = [...new Map([...orderPayments, ...returnPayments, ...loanTransactions, ...commissionTransactions, ...paymentById].map(row => [row.id, row])).values()]
  const paymentReversals = await read<PaymentTransaction>('payment_transactions', 'reversalOfTransactionId', originalPayments.map(row => row.id))
  const payments = [...new Map([...originalPayments, ...paymentReversals].map(row => [row.id, row])).values()]
  const [accountMovements, paymentAccounts] = await Promise.all([
    read<PaymentAccountMovement>('payment_account_movements', 'paymentTransactionId', payments.map(row => row.id)),
    read<PaymentAccount>('payment_accounts', 'id', [...new Set(payments.flatMap(row => row.accountId ? [row.accountId] : []))])
  ])
  return { order, products, customers, partners, inventoryMovements, payments, accountMovements, paymentAccounts,
    loans, loanPayments, loanInstallments, orderInstallments, returns, returnItems,
    assignments, commissions, productCommissions }
}
