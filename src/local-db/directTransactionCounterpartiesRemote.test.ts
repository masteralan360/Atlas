import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { db } from './database'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setNetworkStatus } from '@/lib/network'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { readWorkspaceDataHydration } from '@/workspace/workspaceDataFreshness'

const workspaceId = '00000000-0000-4000-8000-000000000831'
const remote = vi.hoisted(() => ({ data: {} as Record<string, unknown>, args: {} as Record<string, unknown>,
  signal: undefined as AbortSignal | undefined, defer: false, release: undefined as (() => void) | undefined }))
vi.mock('@/lib/supabaseSchema', () => ({ getSupabaseClientForTable: () => ({
  rpc: (_name: string, args: Record<string, unknown>) => {
    remote.args = args
    const result = remote.defer ? new Promise<{ data: typeof remote.data; error: null }>(resolve => {
      remote.release = () => resolve({ data: remote.data, error: null })
    }) : Promise.resolve({ data: remote.data, error: null })
    return Object.assign(result, {
      abortSignal(signal: AbortSignal) { remote.signal = signal; return this },
    })
  },
}) }))

let fetchPage: typeof import('./directTransactionCounterparties').fetchDirectCounterparties
describe('Agent counterparty remote read contract', () => {
  beforeAll(async () => {
    installTestBrowser()
    ;({ fetchDirectCounterparties: fetchPage } = await import('./directTransactionCounterparties'))
  }, 90_000)
  beforeEach(async () => {
    installTestBrowser(); await db.delete(); await db.open()
    setNetworkStatus(true); writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'cloud' })
    remote.signal = undefined
    remote.defer = false
    remote.release = undefined
    remote.data = { totalCount: 1, items: [{ partner: { id: 'partner-remote', workspace_id: workspaceId,
      partner_name: 'Remote Agent', role: 'agent', agent_facet_id: 'agent-remote', version: 1, is_deleted: false },
      agent: { id: 'agent-remote', workspace_id: workspaceId, business_partner_id: 'partner-remote', agent_type: 'seller',
        status: 'active', version: 1, is_deleted: false }, customType: null }] }
  })
  afterAll(async () => { await db.delete() })

  it('passes complete source constraints and AbortSignal, resolving distinct partner/Agent IDs', async () => {
    const controller = new AbortController()
    const result = await fetchPage(workspaceId, { scope: 'agents', selectedPartnerId: 'partner-remote', search: 'Agent', page: 2, pageSize: 10 }, controller.signal)
    expect(remote.args).toMatchObject({ p_workspace_id: workspaceId, p_scope: 'agents', p_selected_partner_id: 'partner-remote',
      p_search: 'Agent', p_page: 2, p_page_size: 10 })
    expect(remote.signal).toBeInstanceOf(AbortSignal)
    expect(result.items[0].partner.id).toBe('partner-remote')
    expect(result.items[0].agent?.id).toBe('agent-remote')
    expect(readWorkspaceDataHydration(workspaceId, 'supabase', ['agents'])?.lastResult?.state).toBe('complete')
  })

  it('preserves pending partner identities and conflicting Agent rows during a refresh', async () => {
    await fetchPage(workspaceId, { scope: 'all', page: 1, pageSize: 20 })
    await db.business_partners.update('partner-remote', { partnerName: 'Pending edit', syncStatus: 'pending' })
    await db.agents.update('agent-remote', { zone: 'Conflict edit', syncStatus: 'conflict' })
    await fetchPage(workspaceId, { scope: 'all', page: 1, pageSize: 20 })
    expect((await db.business_partners.get('partner-remote'))?.partnerName).toBe('Pending edit')
    expect((await db.agents.get('agent-remote'))?.zone).toBe('Conflict edit')
  })

  it('treats an empty refresh as an empty result and malformed identities as a failed freshness check', async () => {
    remote.data = { totalCount: 0, items: [] }
    expect(await fetchPage(workspaceId, { scope: 'all', page: 1, pageSize: 20 })).toEqual({ items: [], totalCount: 0 })
    remote.data = { totalCount: 1, items: [{ partner: { id: 'foreign', workspace_id: 'another-workspace', partner_name: 'Hidden' } }] }
    await expect(fetchPage(workspaceId, { scope: 'agents', page: 1, pageSize: 20 })).rejects.toThrow('Invalid counterparty')
    expect(readWorkspaceDataHydration(workspaceId, 'supabase', ['agents'])?.lastResult?.state).toBe('error')
  })

  it('cancels an abandoned read before writing the cache or reporting completion', async () => {
    const controller = new AbortController()
    remote.defer = true
    const pending = fetchPage(workspaceId, { scope: 'agents', page: 1, pageSize: 20 }, controller.signal)
    await vi.waitFor(() => expect(remote.signal).toBeDefined())
    controller.abort()
    expect(remote.signal?.aborted).toBe(true)
    remote.release!()
    await expect(pending).rejects.toThrow()
    expect(await db.business_partners.count()).toBe(0)
    expect(readWorkspaceDataHydration(workspaceId, 'supabase', ['agents'])?.lastResult?.state).not.toBe('complete')
  })
})
