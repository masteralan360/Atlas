import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const workspaceId = '00000000-0000-4000-8000-000000000001'
const partnerId = '00000000-0000-4000-8000-000000000002'
const sellerUserId = '00000000-0000-4000-8000-000000000003'
const saleId = '00000000-0000-4000-8000-000000000004'
const fullReturnSaleId = '00000000-0000-4000-8000-000000000005'
const returnedAt = '2026-10-23T10:00:00.000Z'
type Row = Record<string, any>

function statementClient(agentType = 'seller') {
  const rows: Record<string, Row[]> = {
    'crm.agents': [{ id: '00000000-0000-4000-8000-000000000006', workspace_id: workspaceId,
      business_partner_id: partnerId, agent_type: agentType, linked_user_id: sellerUserId, is_deleted: false }],
    'public.sales': [
      { id: saleId, total_amount: 70, returned_amount: 30, original_total_amount: 100 },
      { id: fullReturnSaleId, total_amount: 0, returned_amount: 50, original_total_amount: 50 },
    ].map((sale, index) => ({ ...sale, workspace_id: workspaceId, cashier_id: sellerUserId,
      settlement_currency: 'usd', sequence_id: index + 1, created_at: '2026-10-22T10:00:00.000Z' })),
    // public.sale_returns has status-based lifecycle; it has no is_deleted column.
    'public.sale_returns': [
      { id: '00000000-0000-4000-8000-000000000007', sale_id: saleId, refund_amount: 30, status: 'posted' },
      { id: '00000000-0000-4000-8000-000000000008', sale_id: saleId, refund_amount: 5, status: 'voided' },
      { id: '00000000-0000-4000-8000-000000000009', sale_id: fullReturnSaleId, refund_amount: 50, status: 'posted' },
      { id: '00000000-0000-4000-8000-000000000010', sale_id: partnerId, refund_amount: 500, status: 'posted' },
    ].map(row => ({ ...row, workspace_id: workspaceId, returned_at: returnedAt, created_at: returnedAt })),
  }
  rows['public.sale_returns'].push({ ...rows['public.sale_returns'][0],
    id: '00000000-0000-4000-8000-000000000011', workspace_id: 'another-workspace' })
  const reads: Array<{ table: string; filters: Array<[string, string, unknown]> }> = []

  function tableQuery(table: string) {
    const read = { table, filters: [] as Array<[string, string, unknown]> }
    reads.push(read)
    let start = 0
    let end = Infinity
    let single = false
    const query = {
      select: (_columns: string) => query,
      eq(column: string, value: unknown) {
        if (table === 'public.sale_returns' && column === 'is_deleted') {
          throw new Error('column sale_returns.is_deleted does not exist')
        }
        read.filters.push(['eq', column, value]); return query
      },
      in(column: string, values: unknown[]) { read.filters.push(['in', column, values]); return query },
      gte(column: string, value: unknown) { read.filters.push(['gte', column, value]); return query },
      lt(column: string, value: unknown) { read.filters.push(['lt', column, value]); return query },
      order: (_column: string, _options: unknown) => query,
      range(from: number, to: number) { start = from; end = to + 1; return query },
      limit(count: number) { end = count; return query },
      maybeSingle() { single = true; return query },
      then(resolve: (value: { data: unknown; error: null }) => unknown) {
        const data = (rows[table] || []).filter(row => read.filters.every(([operator, column, value]) => {
          if (operator === 'eq') return row[column] === value
          if (operator === 'in') return (value as unknown[]).includes(row[column])
          if (operator === 'gte') return row[column] >= String(value)
          return row[column] < String(value)
        })).slice(start, end)
        return Promise.resolve({ data: single ? data[0] ?? null : data, error: null }).then(resolve)
      },
    }
    return query
  }
  function schema(name: string) {
    return {
      from: (table: string) => tableQuery(`${name}.${table}`),
      rpc: async () => ({ data: [{ id: partnerId, workspace_id: workspaceId, partner_name: 'Seller Agent', role: 'agent' }], error: null }),
    }
  }
  return { reads, client: { schema, from: schema('public').from,
    rpc: async () => ({ data: 'admin', error: null }) } }
}

let functionBundle: string
beforeAll(async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../../supabase/functions/partner-account-statement-period/index.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'statement-request-boundary', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/functions-js\/edge-runtime\.d\.ts$/ }, () => ({ path: 'edge-types', namespace: 'statement-test' }))
      builder.onResolve({ filter: /_shared\/supabase\.ts$/ }, () => ({ path: 'request-client', namespace: 'statement-test' }))
      builder.onLoad({ filter: /.*/, namespace: 'statement-test' }, args => ({ contents: args.path === 'edge-types' ? '' : `
        export function createRequestClient() { return globalThis.__statementClient }
        export async function getAuthenticatedUser() { return { user: { id: '${sellerUserId}' }, error: null } }
      ` }))
    } }],
  })
  functionBundle = bundled.outputFiles[0].text
})

async function requestStatement(agentType?: string) {
  const { client, reads } = statementClient(agentType)
  let handler!: (req: Request) => Promise<Response>
  const logError = vi.fn()
  runInNewContext(functionBundle, { Request, Response, Headers, console: { error: logError },
    __statementClient: client, Deno: { serve: (callback: typeof handler) => { handler = callback } } })
  const response = await handler(new Request('https://example.test/partner-account-statement-period', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, partnerId, period: { type: 'allTime' } }),
  }))
  return { response, body: await response.json(), reads, logError }
}

describe('Seller partner statement Edge Function', () => {
  it('loads partial/full POS returns using posted status and keeps them informational', async () => {
    const { response, body, reads, logError } = await requestStatement()
    expect(response.status).toBe(200)
    expect(logError).not.toHaveBeenCalled()
    expect(reads.some((read) => read.table.startsWith('delivery.'))).toBe(false)
    expect(body.isSellerAgentStatement).toBe(true)
    const [ledger] = body.ledgers
    expect(ledger.closingBalance).toBe(0)
    expect(ledger.entries).toHaveLength(4)
    const returns = ledger.entries.filter((entry: Row) => entry.descriptionKey === 'sellerReturnedPosSale')
    expect(returns.map((entry: Row) => [entry.relatedReturnId, entry.salesActivityAmount]).sort()).toEqual([
      ['00000000-0000-4000-8000-000000000007', -30],
      ['00000000-0000-4000-8000-000000000009', -50],
    ])
    expect(ledger.entries.every((entry: Row) => entry.delta === 0)).toBe(true)
    expect(reads.find(read => read.table === 'public.sale_returns')?.filters).toEqual([
      ['eq', 'workspace_id', workspaceId], ['in', 'sale_id', [saleId, fullReturnSaleId]], ['eq', 'status', 'posted'],
    ])
  })

  it('does not load Seller POS activity for a Field Agent', async () => {
    const { response, body, reads, logError } = await requestStatement('field_agent')
    expect(response.status).toBe(200)
    expect(logError).not.toHaveBeenCalled()
    expect(body.isSellerAgentStatement).toBe(false)
    expect(body.ledgers).toEqual([])
    expect(reads.some(read => read.table === 'public.sale_returns')).toBe(false)
  })
})
