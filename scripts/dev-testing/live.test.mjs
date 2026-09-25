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
    const env = liveChildEnv(config, { NODE_ENV: 'test' }, 'run-1')
    expect(env.ATLAS_LIVE_RUN_ID).toBe('run-1')
    expect(env.ATLAS_LIVE_SUPABASE_URL).toBe('https://project.supabase.co')
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

  it('keeps the hosted and isolated group allowlists separate', () => {
    const hosted = validateRunOptions({ suiteId: 'sale-orders', environment: 'hosted-supabase' }).groups
    expect(hosted.map((group) => group.id)).toEqual([
      'matrix', 'printing', 'account-statement', 'lifecycle', 'pricing', 'related-units',
      'payments', 'ui-access', 'live-transactions'
    ])
    expect(hosted.filter((group) => group.isolatedGroupId).map((group) => group.isolatedGroupId))
      .toEqual(validateRunOptions({ suiteId: 'sale-orders' }).groups.map((group) => group.id))
    expect(() => validateRunOptions({ suiteId: 'pos', environment: 'hosted-supabase' })).toThrow('live_suite_unavailable')
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
})
