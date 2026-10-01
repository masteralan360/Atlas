import { getExistingLocalModeSqliteConnectionForAudit } from '@/local-db/localModeSqlite'
import { getSupabaseClientForTable, getSupabaseRemoteTableName, getWorkspaceScopedPartnerReadRpc } from '@/lib/supabaseSchema'
import { toCamelCase } from '@/lib/utils'
import type { Loan, LoanInstallment, LoanPayment, PaymentAccount, PaymentAccountMovement, PaymentTransaction } from '@/local-db/models'

export interface LoanTransactionGraph {
  loan: Loan | null
  installments: LoanInstallment[]
  loanPayments: LoanPayment[]
  payments: PaymentTransaction[]
  accountMovements: PaymentAccountMovement[]
  paymentAccounts: PaymentAccount[]
  partners: Array<{ id: string; workspaceId: string; isDeleted?: boolean }>
}

type Row = Record<string, unknown>

async function readCloud(table: string, workspaceId: string, column: string, values: string[]): Promise<Row[]> {
  if (!values.length) return []
  const client = getSupabaseClientForTable(table)
  const scopedReadRpc = getWorkspaceScopedPartnerReadRpc(table)
  const rows: Row[] = []
  for (let offset = 0; ; offset += 500) {
    const query = scopedReadRpc
      ? client.rpc(scopedReadRpc, { p_workspace_id: workspaceId }) as any
      : client.from(getSupabaseRemoteTableName(table)).select('*').eq('workspace_id', workspaceId) as any
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

/** Reads only the loan transaction graph from its configured source of truth. */
export async function resolveLoanTransactionGraph(
  workspaceId: string, loanId: string, source: 'supabase' | 'sqlite'
): Promise<LoanTransactionGraph> {
  const local = source === 'sqlite' ? await readSqliteWorkspace(workspaceId) : null
  const read = async <T>(table: string, column: string, values: string[]): Promise<T[]> => {
    if (local) return (local.get(table) ?? []).filter(row => values.includes(String(row[column] ?? ''))) as T[]
    return readCloud(table, workspaceId, column.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), values) as Promise<T[]>
  }

  const loan = (await read<Loan>('loans', 'id', [loanId]))[0] ?? null
  const [loanPayments, installments, directPayments, partners] = await Promise.all([
    read<LoanPayment>('loan_payments', 'loanId', [loanId]),
    read<LoanInstallment>('loan_installments', 'loanId', [loanId]),
    read<PaymentTransaction>('payment_transactions', 'sourceRecordId', [loanId]),
    read<LoanTransactionGraph['partners'][number]>('business_partners', 'id',
      loan?.linkedPartyType === 'business_partner' && loan.linkedPartyId ? [loan.linkedPartyId] : [])
  ])

  const referencedPaymentIds = [
    ...(loan?.originationTransactionId ? [loan.originationTransactionId] : []),
    ...loanPayments.flatMap(row => [row.paymentTransactionId, row.reversalTransactionId].filter((id): id is string => !!id))
  ]
  const referencedPayments = await read<PaymentTransaction>('payment_transactions', 'id', [...new Set(referencedPaymentIds)])
  const originalPayments = [...new Map([...directPayments, ...referencedPayments]
    .filter(row => !row.reversalOfTransactionId).map(row => [row.id, row])).values()]
  const reversals = await read<PaymentTransaction>('payment_transactions', 'reversalOfTransactionId', originalPayments.map(row => row.id))
  const payments = [...new Map([...directPayments, ...referencedPayments, ...reversals].map(row => [row.id, row])).values()]
  const paymentIds = [...new Set(payments.map(row => row.id))]
  const [accountMovements, paymentAccounts] = await Promise.all([
    read<PaymentAccountMovement>('payment_account_movements', 'paymentTransactionId', paymentIds),
    read<PaymentAccount>('payment_accounts', 'id', [...new Set(payments.flatMap(row => row.accountId ? [row.accountId] : []))])
  ])

  return { loan, installments, loanPayments, payments, accountMovements, paymentAccounts, partners }
}
