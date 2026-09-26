import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
  failedTable: '',
  sqliteRows: [] as Array<{ entity_type: string; payload: string }>,
  sqliteQueries: [] as string[]
}))

vi.mock('@/lib/supabaseSchema', () => ({
  getSupabaseRemoteTableName: (table: string) => table === 'payment_account_movements' ? 'account_movements' : table,
  getWorkspaceScopedPartnerReadRpc: (table: string) => ({
    customers: 'list_visible_customers', business_partners: 'list_visible_business_partners'
  })[table],
  getSupabaseClientForTable: () => ({
    from: (table: string) => makeQuery(table, table),
    rpc: (name: string, args: { p_workspace_id: string }) => makeQuery(`rpc:${name}`,
      name === 'list_visible_customers' ? 'customers' : 'business_partners', args.p_workspace_id)
  })
}))
function makeQuery(table: string, sourceTable: string, workspaceId?: string) {
      const filters: Record<string, unknown> = workspaceId ? { workspace_id: workspaceId } : {}
      const query = {
        select: () => query,
        eq: (field: string, value: unknown) => { filters[field] = value; return query },
        in: (field: string, value: unknown) => { filters[field] = value; return query },
        order: () => query,
        range: async () => {
          state.queries.push({ table, filters: { ...filters } })
          if (table === state.failedTable) return { data: null, error: { message: 'permission denied' } }
          const rows = (state.rows[sourceTable] ?? []).filter(row => Object.entries(filters).every(([key, value]) =>
            Array.isArray(value) ? value.includes(row[key]) : row[key] === value))
          return { data: rows, error: null }
        }
      }
      return query
}
vi.mock('@/local-db/localModeSqlite', () => ({ getExistingLocalModeSqliteConnectionForAudit: async () => ({
  select: async (sql: string) => { state.sqliteQueries.push(sql); return state.sqliteRows },
  execute: () => { throw new Error('An audit must never write to SQLite') }
}) }))
vi.mock('@/lib/utils', () => ({ toCamelCase: (row: Record<string, unknown>) => Object.fromEntries(
  Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])
) }))

import { resolveSalesOrderTransactionGraph } from './salesOrderGraph'

describe('Sales Order audit source requests', () => {
  beforeEach(() => {
    state.rows = {}
    state.queries = []
    state.failedTable = ''
    state.sqliteRows = []
    state.sqliteQueries = []
  })

  it('reads the order and linked records directly from Supabase without cache hydration', async () => {
    state.rows = {
      sales_orders: [{ id: 'order', workspace_id: 'workspace', linked_loan_id: 'loan', customer_id: 'customer',
        business_partner_id: 'partner', items: [{ id: 'line', productId: 'product' }] }],
      customers: [{ id: 'customer', workspace_id: 'workspace' }],
      business_partners: [{ id: 'partner', workspace_id: 'workspace' }],
      loans: [{ id: 'loan', workspace_id: 'workspace', order_id: 'order' }],
      payment_transactions: [{ id: 'payment', workspace_id: 'workspace', source_record_id: 'loan', account_id: 'account' }],
      account_movements: [{ id: 'payment', workspace_id: 'workspace', payment_transaction_id: 'payment' }]
    }
    const graph = await resolveSalesOrderTransactionGraph('workspace', 'order', 'supabase')
    expect(graph.order?.linkedLoanId).toBe('loan')
    expect(graph.loans).toHaveLength(1)
    expect(graph.payments).toHaveLength(1)
    expect(graph.accountMovements).toHaveLength(1)
    expect(graph.customers).toHaveLength(1)
    expect(graph.partners).toHaveLength(1)
    expect(state.queries).toContainEqual({ table: 'sales_orders', filters: { workspace_id: 'workspace', id: 'order' } })
    expect(state.queries).toContainEqual({ table: 'rpc:list_visible_customers', filters: { workspace_id: 'workspace', id: 'customer' } })
    expect(state.queries).toContainEqual({ table: 'rpc:list_visible_business_partners', filters: { workspace_id: 'workspace', id: 'partner' } })
    expect(state.queries.some(query => query.table === 'customers' || query.table === 'business_partners')).toBe(false)
    expect(state.queries).toContainEqual({ table: 'inventory_transactions', filters: { workspace_id: 'workspace', reference_id: 'order' } })
    expect(state.queries).toContainEqual({ table: 'account_movements', filters: { workspace_id: 'workspace', payment_transaction_id: 'payment' } })
  })

  it('fails closed when an authoritative relationship query is denied', async () => {
    state.failedTable = 'inventory_transactions'
    await expect(resolveSalesOrderTransactionGraph('workspace', 'order', 'supabase'))
      .rejects.toThrow('Audit could not read inventory_transactions')
  })

  it('fails closed if the authorized partner read RPC is denied', async () => {
    state.rows.sales_orders = [{ id: 'order', workspace_id: 'workspace', customer_id: 'customer', items: [] }]
    state.failedTable = 'rpc:list_visible_customers'
    await expect(resolveSalesOrderTransactionGraph('workspace', 'order', 'supabase'))
      .rejects.toThrow('Audit could not read customers')
  })

  it('reads Local-mode records directly from SQLite without writes or Supabase calls', async () => {
    state.sqliteRows = [
      { entity_type: 'sales_orders', payload: JSON.stringify({ id: 'order', workspaceId: 'workspace', items: [], customerId: 'customer' }) },
      { entity_type: 'customers', payload: JSON.stringify({ id: 'customer', workspaceId: 'workspace' }) }
    ]
    const graph = await resolveSalesOrderTransactionGraph('workspace', 'order', 'sqlite')
    expect(graph.order?.id).toBe('order')
    expect(graph.customers).toHaveLength(1)
    expect(state.queries).toHaveLength(0)
    expect(state.sqliteQueries).toHaveLength(1)
    expect(state.sqliteQueries[0]).toMatch(/^SELECT /)
  })
})
