import { describe, expect, it, vi } from 'vitest'
import { createLiveFetch, liveChildEnv, liveTarget, parseLiveConfig, preflightLive, redactLiveText } from './live.mjs'
import { validateRunOptions } from './controller.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const anon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`
const source = [
  'ATLAS_LIVE_SUPABASE_URL=https://project.supabase.co/',
  `ATLAS_LIVE_SUPABASE_KEY=${anon}`,
  'ATLAS_LIVE_TEST_EMAIL=dev-test@example.com',
  'ATLAS_LIVE_TEST_PASSWORD=example-password',
  `ATLAS_LIVE_WORKSPACE_ID=${id}`,
  'ATLAS_LIVE_WORKSPACE_NAME=DEV TEST Atlas'
].join('\n')

describe('hosted Supabase test boundary', () => {
  it('requires an exact dedicated workspace and public client key', () => {
    const config = parseLiveConfig(source)
    expect(liveTarget(config)).toEqual({ host: 'project.supabase.co', workspaceId: id, workspaceName: 'DEV TEST Atlas' })
    expect(() => parseLiveConfig(source.replace('DEV TEST Atlas', 'Business Atlas'))).toThrow('live_config_invalid')
    expect(() => parseLiveConfig(source.replace(anon, 'sb_secret_example'))).toThrow('live_service_key_forbidden')
    expect(() => parseLiveConfig(source.replace(anon, `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`))).toThrow('live_service_key_forbidden')
    expect(() => parseLiveConfig(source.replace('https://project.supabase.co/', 'http://project.supabase.co/'))).toThrow('live_config_invalid')
    expect(() => parseLiveConfig(source.replace('https://project.supabase.co/', 'https://project.supabase.co/evil'))).toThrow('live_config_invalid')
  })

  it('passes only the dedicated credentials to a live child and redacts diagnostics', () => {
    const config = parseLiveConfig(source)
    const env = liveChildEnv(config, { NODE_ENV: 'test' }, 'run-1', { servicesEnabled: true })
    expect(env.ATLAS_LIVE_RUN_ID).toBe('run-1')
    expect(env.ATLAS_LIVE_SUPABASE_URL).toBe('https://project.supabase.co')
    expect(env.ATLAS_LIVE_SERVICES_ENABLED).toBe('true')
    expect(redactLiveText(`${anon} example-password dev-test@example.com Bearer eyJ.eyJ.abc`, config)).not.toMatch(/example-password|dev-test@example.com|header\.|eyJ\.eyJ/)
  })

  it('limits live traffic to one HTTPS origin and refuses redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const guarded = createLiveFetch('https://project.supabase.co', fetchImpl)
    await expect(guarded('https://project.supabase.co/rest/v1/orders')).resolves.toBeInstanceOf(Response)
    expect(fetchImpl).toHaveBeenCalledWith('https://project.supabase.co/rest/v1/orders', expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }))
    await expect(guarded('https://other.supabase.co/rest/v1/orders')).rejects.toThrow('live_network_blocked')
    await expect(guarded('http://project.supabase.co/rest/v1/orders')).rejects.toThrow('live_network_blocked')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://elsewhere.example' } }))
    await expect(guarded('https://project.supabase.co/auth/v1/token')).rejects.toThrow('live_network_redirect_blocked')
  })

  it('registers Sales Orders hosted domains and the paired sales-agent refund statement selection', () => {
    const hosted = validateRunOptions({ suiteId: 'sale-orders', environment: 'hosted-supabase' }).groups
    const domains = hosted.filter(group => group.domainId)
    expect(domains).toHaveLength(30)
    expect(domains.map(group => group.domainId)).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0')))
    expect(domains.every(group => !group.isolatedGroupId && !group.isolatedOnly && group.files.length === 1)).toBe(true)
    expect(domains[0].files).toEqual(['src/dev/testing/suites/saleOrdersHosted01Live.test.ts'])
    expect(domains.at(-1).files).toEqual(['src/dev/testing/suites/saleOrdersHosted30Live.test.ts'])
    expect(hosted.find(group => group.id === 'agent-refund-statement')).toMatchObject({
      isolatedGroupId: 'agent-refund-statement',
      files: ['src/dev/testing/suites/saleOrdersAgentRefundStatementLive.test.ts']
    })
  })

  it('registers the same paired refund statement selection in Business Partners', () => {
    const group = validateRunOptions({ suiteId: 'business-partners', environment: 'hosted-supabase', groupIds: ['agent-refund-statement'] }).groups[0]
    expect(group).toMatchObject({
      id: 'agent-refund-statement',
      isolatedGroupId: 'agent-refund-statement',
      files: ['src/dev/testing/suites/saleOrdersAgentRefundStatementLive.test.ts']
    })
    expect(validateRunOptions({ suiteId: 'business-partners', groupIds: ['agent-refund-statement'] }).groups[0].files)
      .toContain('src/lib/partnerAccountStatementAgentRefund.test.ts')
  })

  it('keeps existing POS and Products hosted and isolated group allowlists separate', () => {
    const posIsolated = validateRunOptions({ suiteId: 'pos' }).groups.map((group) => group.id)
    const posHosted = validateRunOptions({ suiteId: 'pos', environment: 'hosted-supabase' }).groups
    expect(posHosted.map((group) => group.id)).toEqual(posIsolated.filter((groupId) => groupId !== 'printing'))
    expect(posHosted.filter((group) => group.isolatedOnly).map((group) => group.id))
      .toEqual(['cart', 'media-uploads', 'ui-access'])
    expect(posHosted.filter((group) => !group.isolatedOnly).every((group) => group.files.length > 0)).toBe(true)

    const productsIsolated = validateRunOptions({ suiteId: 'products' }).groups
    const productsHosted = validateRunOptions({ suiteId: 'products', environment: 'hosted-supabase' }).groups
    expect(productsHosted.map((group) => group.id)).toEqual(productsIsolated.filter((group) => group.id !== 'printing').map((group) => group.id))
    expect(productsHosted.filter((group) => group.isolatedOnly).map((group) => group.id))
      .toEqual(['import-export-assets', 'product-consumers', 'cloud-hybrid-contracts'])
    expect(productsHosted.filter((group) => !group.isolatedOnly).every((group) => group.files.length > 0)).toBe(true)
    expect(productsIsolated.every((group) => group.files.length > 0)).toBe(true)
  })

  it('blocks a workspace mismatch before any scenario write', async () => {
    const requests = []
    const fetchImpl = vi.fn(async (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input.url)
      requests.push({ path: target.pathname, method: init?.method ?? 'GET' })
      if (target.pathname === '/auth/v1/token') return Response.json({
        access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600,
        user: { id, email: 'dev-test@example.com', aud: 'authenticated', role: 'authenticated' }
      })
      if (target.pathname === '/rest/v1/profiles') return Response.json({ id, current_workspace: id, role: 'admin' })
      if (target.pathname === '/rest/v1/workspaces') return Response.json({ id, name: 'Business Atlas', data_mode: 'cloud' })
      if (target.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
      throw new Error(`unexpected request: ${target.pathname}`)
    })
    await expect(preflightLive(parseLiveConfig(source), { fetchImpl })).rejects.toThrow('live_workspace_mismatch')
    expect(requests.every(({ path }) => path.startsWith('/auth/') || path === '/rest/v1/profiles' || path === '/rest/v1/workspaces')).toBe(true)
  })

  it('preflights POS tables without requiring the Sale Orders schema', async () => {
    const paths = []
    const fetchImpl = vi.fn(async (input) => {
      const target = new URL(typeof input === 'string' ? input : input.url)
      paths.push(target.pathname)
      if (target.pathname === '/auth/v1/token') return Response.json({
        access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600,
        user: { id, email: 'dev-test@example.com', aud: 'authenticated', role: 'authenticated' }
      })
      if (target.pathname === '/rest/v1/profiles') return Response.json({ id, current_workspace: id, role: 'admin' })
      if (target.pathname === '/rest/v1/workspaces') return Response.json(target.searchParams.get('select') === 'id'
        ? [{ id }] : { id, name: 'DEV TEST Atlas', data_mode: 'cloud' })
      if (target.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
      if (['sales', 'sale_items', 'inventory', 'stock_batches', 'payment_transactions']
        .some((table) => target.pathname === `/rest/v1/${table}`)) return Response.json([])
      throw new Error(`unexpected request: ${target.pathname}`)
    })
    const result = await preflightLive(parseLiveConfig(source), { fetchImpl, suiteId: 'pos' })
    expect(result.mode).toBe('cloud')
    expect(paths).not.toContain('/rest/v1/sales_orders')
    expect(paths).toContain('/rest/v1/sales')
    expect(paths).toContain('/rest/v1/payment_transactions')
    expect(paths).not.toContain('/rest/v1/rpc/services_module_allowed')
  })

  it('preflights the product catalog and UoM table contracts without requiring order schemas', async () => {
    const paths = []
    const fetchImpl = vi.fn(async (input) => {
      const target = new URL(typeof input === 'string' ? input : input.url)
      paths.push(target.pathname)
      if (target.pathname === '/auth/v1/token') return Response.json({
        access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600,
        user: { id, email: 'dev-test@example.com', aud: 'authenticated', role: 'authenticated' }
      })
      if (target.pathname === '/rest/v1/profiles') return Response.json({ id, current_workspace: id, role: 'admin' })
      if (target.pathname === '/rest/v1/workspaces') return Response.json(target.searchParams.get('select') === 'id'
        ? [{ id }] : { id, name: 'DEV TEST Atlas', data_mode: 'cloud' })
      if (target.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
      if ([
        'products', 'categories', 'product_barcodes', 'product_uoms', 'inventory', 'inventory_transactions', 'storages', 'units',
        'price_books', 'price_book_items',
        'product_discounts'
      ].some((table) => target.pathname === `/rest/v1/${table}`)) return Response.json([])
      if (target.pathname === '/rest/v1/product_commission_rules') return Response.json([])
      throw new Error(`unexpected request: ${target.pathname}`)
    })
    const result = await preflightLive(parseLiveConfig(source), { fetchImpl, suiteId: 'products' })
    expect(result.mode).toBe('cloud')
    expect(paths).toContain('/rest/v1/products')
    expect(paths).toContain('/rest/v1/product_barcodes')
    expect(paths).toContain('/rest/v1/inventory_transactions')
    expect(paths).toContain('/rest/v1/product_uoms')
    expect(paths).toContain('/rest/v1/product_commission_rules')
    expect(paths).not.toContain('/rest/v1/sales_orders')
  })

  it('reports the verified Services module capability for Sale Order live tests', async () => {
    const paths = []
    const fetchImpl = vi.fn(async (input) => {
      const target = new URL(typeof input === 'string' ? input : input.url)
      paths.push(target.pathname)
      if (target.pathname === '/auth/v1/token') return Response.json({
        access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600,
        user: { id, email: 'dev-test@example.com', aud: 'authenticated', role: 'authenticated' }
      })
      if (target.pathname === '/rest/v1/profiles') return Response.json({ id, current_workspace: id, role: 'admin' })
      if (target.pathname === '/rest/v1/workspaces') return Response.json(target.searchParams.get('select') === 'id'
        ? [{ id }] : { id, name: 'DEV TEST Atlas', data_mode: 'cloud' })
      if (target.pathname === '/rest/v1/rpc/services_module_allowed') return Response.json(true)
      if (target.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
      if (target.pathname === '/rest/v1/sales_orders') return Response.json([])
      throw new Error(`unexpected request: ${target.pathname}`)
    })
    const result = await preflightLive(parseLiveConfig(source), { fetchImpl, suiteId: 'sale-orders' })
    expect(result.servicesEnabled).toBe(true)
    expect(paths).toContain('/rest/v1/rpc/services_module_allowed')
  })
})
