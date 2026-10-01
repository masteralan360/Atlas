import { describe, expect, it, vi } from 'vitest'
import { parseLiveConfig, preflightLive } from './live.mjs'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const anon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`
const config = parseLiveConfig([
  'ATLAS_LIVE_SUPABASE_URL=https://project.supabase.co/',
  `ATLAS_LIVE_SUPABASE_KEY=${anon}`,
  'ATLAS_LIVE_TEST_EMAIL=dev-test@example.com',
  'ATLAS_LIVE_TEST_PASSWORD=example-password',
  `ATLAS_LIVE_WORKSPACE_ID=${workspaceId}`,
  'ATLAS_LIVE_WORKSPACE_NAME=DEV TEST Atlas'
].join('\n'))

function partnerStatementFetch({ unavailableTable } = {}) {
  const requests = []
  const fetchImpl = vi.fn(async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input.url)
    const request = {
      path: target.pathname,
      method: init?.method ?? 'GET',
      profile: init?.headers?.get?.('accept-profile') ?? null
    }
    requests.push(request)
    if (request.path === '/auth/v1/token') return Response.json({
      access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600,
      user: { id: workspaceId, email: 'dev-test@example.com', aud: 'authenticated', role: 'authenticated' }
    })
    if (request.path === '/rest/v1/profiles') return Response.json({ id: workspaceId, current_workspace: workspaceId, role: 'admin' })
    if (request.path === '/rest/v1/workspaces') return Response.json(target.searchParams.get('select') === 'id'
      ? [{ id: workspaceId }] : { id: workspaceId, name: 'DEV TEST Atlas', data_mode: 'cloud' })
    if (request.path === '/auth/v1/logout') return new Response(null, { status: 204 })
    if (unavailableTable && request.path === `/rest/v1/${unavailableTable}`) {
      return Response.json({ message: 'table unavailable' }, { status: 404 })
    }
    if ([
      '/rest/v1/agents', '/rest/v1/sales_orders',
      '/rest/v1/payment_transactions', '/rest/v1/order_returns', '/rest/v1/order_return_items'
    ].includes(request.path)) return Response.json([])
    throw new Error(`unexpected request: ${request.path}`)
  })
  return { fetchImpl, requests }
}

describe('Business Partner hosted statement preflight', () => {
  it('checks scoped CRM and payment-return read contracts before running hosted cases', async () => {
    const { fetchImpl, requests } = partnerStatementFetch()
    const result = await preflightLive(config, { fetchImpl, suiteId: 'business-partners' })

    expect(result.mode).toBe('cloud')
    expect(requests.filter(request => request.path.startsWith('/rest/v1/')).every(request => request.method === 'GET')).toBe(true)
    expect(requests.filter(request => request.profile === 'crm').map(request => request.path)).toEqual(expect.arrayContaining([
      '/rest/v1/agents', '/rest/v1/sales_orders'
    ]))
    expect(requests.map(request => request.path)).toEqual(expect.arrayContaining([
      '/rest/v1/payment_transactions', '/rest/v1/order_returns', '/rest/v1/order_return_items'
    ]))
  })

  it('blocks cleanly when return history cannot be read', async () => {
    const { fetchImpl, requests } = partnerStatementFetch({ unavailableTable: 'order_returns' })

    await expect(preflightLive(config, { fetchImpl, suiteId: 'business-partners' })).rejects.toThrow('live_schema_unavailable')
    expect(requests.map(request => request.path)).not.toContain('/rest/v1/order_return_items')
    expect(requests.filter(request => request.path.startsWith('/rest/v1/')).every(request => request.method === 'GET')).toBe(true)
  })
})
