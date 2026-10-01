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
  getWorkspaceScopedPartnerReadRpc: (table: string) => table === 'business_partners' ? 'list_visible_business_partners' : undefined,
  getSupabaseClientForTable: () => ({
    from: (table: string) => makeQuery(table, table),
    rpc: (name: string, args: { p_workspace_id: string }) => makeQuery(`rpc:${name}`, 'business_partners', args.p_workspace_id)
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

import { resolveLoanTransactionGraph } from './loanGraph'

describe('Loan audit source requests', () => {
  beforeEach(() => {
    state.rows = {}
    state.queries = []
    state.failedTable = ''
    state.sqliteRows = []
    state.sqliteQueries = []
  })

  it('reads the loan and its payment, reversal, account, schedule, and partner graph with workspace scope', async () => {
    state.rows = {
      loans: [{ id: 'loan', workspace_id: 'workspace', linked_party_type: 'business_partner', linked_party_id: 'partner',
        origination_transaction_id: 'origin' }],
      loan_payments: [{ id: 'repayment', workspace_id: 'workspace', loan_id: 'loan', payment_transaction_id: 'payment' }],
      loan_installments: [{ id: 'installment', workspace_id: 'workspace', loan_id: 'loan' }],
      payment_transactions: [
        { id: 'origin', workspace_id: 'workspace', source_record_id: 'loan', account_id: 'account' },
        { id: 'payment', workspace_id: 'workspace', source_record_id: 'loan', account_id: 'account' },
        { id: 'reversal', workspace_id: 'workspace', source_record_id: 'loan', reversal_of_transaction_id: 'payment' }
      ],
      account_movements: [{ id: 'movement', workspace_id: 'workspace', payment_transaction_id: 'payment' }],
      payment_accounts: [{ id: 'account', workspace_id: 'workspace' }],
      business_partners: [{ id: 'partner', workspace_id: 'workspace' }]
    }
    const graph = await resolveLoanTransactionGraph('workspace', 'loan', 'supabase')
    expect(graph.loan?.id).toBe('loan')
    expect(graph.loanPayments.map(row => row.id)).toEqual(['repayment'])
    expect(graph.installments.map(row => row.id)).toEqual(['installment'])
    expect(graph.payments.map(row => row.id).sort()).toEqual(['origin', 'payment', 'reversal'])
    expect(graph.accountMovements).toHaveLength(1)
    expect(graph.paymentAccounts).toHaveLength(1)
    expect(graph.partners).toHaveLength(1)
    expect(state.queries).toContainEqual({ table: 'loans', filters: { workspace_id: 'workspace', id: 'loan' } })
    expect(state.queries).toContainEqual({ table: 'rpc:list_visible_business_partners', filters: { workspace_id: 'workspace', id: 'partner' } })
    expect(state.queries).toContainEqual({ table: 'account_movements', filters: {
      workspace_id: 'workspace', payment_transaction_id: ['origin', 'payment', 'reversal']
    } })
    expect(state.queries.every(query => query.filters.workspace_id === 'workspace')).toBe(true)
  })

  it('fails closed when a required authoritative graph read is denied', async () => {
    state.failedTable = 'loan_installments'
    await expect(resolveLoanTransactionGraph('workspace', 'loan', 'supabase'))
      .rejects.toThrow('Audit could not read loan_installments')
  })

  it('reads Local-mode records only from SQLite and never writes', async () => {
    state.sqliteRows = [
      { entity_type: 'loans', payload: JSON.stringify({ id: 'loan', workspaceId: 'workspace' }) },
      { entity_type: 'loan_payments', payload: JSON.stringify({ id: 'payment', loanId: 'loan' }) }
    ]
    const graph = await resolveLoanTransactionGraph('workspace', 'loan', 'sqlite')
    expect(graph.loan?.id).toBe('loan')
    expect(graph.loanPayments).toHaveLength(1)
    expect(state.queries).toHaveLength(0)
    expect(state.sqliteQueries).toHaveLength(1)
    expect(state.sqliteQueries[0]).toMatch(/^SELECT /)
  })
})
