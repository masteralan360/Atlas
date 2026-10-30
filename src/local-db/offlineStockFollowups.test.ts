import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { db } from './database'
import { runOfflineStockFollowups } from './offlineStockFollowups'

const remote = vi.hoisted(() => ({ rpc: vi.fn(), reorder: vi.fn() }))
vi.mock('@/auth/supabase', () => ({ supabase: { rpc: remote.rpc } }))
vi.mock('./reorderTransferRules', () => ({ evaluateReorderTransferRulesForProduct: remote.reorder }))

const key = 'stock-followup:v1:workspace:actor:operation'
const job = { key, value: JSON.stringify({ workspaceId: 'workspace', actorId: 'actor', operationId: 'operation', productIds: ['product'], orderIds: ['order'] }) }

describe('confirmed stock operation follow-ups', () => {
  beforeAll(installTestBrowser)
  beforeEach(async () => {
    await db.delete(); await db.open()
    setActiveBusinessWorkspace('workspace'); setNetworkStatus(true)
    remote.rpc.mockReset().mockResolvedValue({ error: null })
    remote.reorder.mockReset().mockResolvedValue(0)
    await db.app_settings.put(job)
  })
  afterAll(async () => { await db.delete(); setActiveBusinessWorkspace(null) })

  it('retains an unsuccessful job through reopen and removes it only after successful reconciliation', async () => {
    remote.rpc.mockResolvedValueOnce({ error: new Error('network unavailable') })
    await runOfflineStockFollowups('actor')
    expect(await db.app_settings.get(key)).toEqual(job)
    db.close(); await db.open()
    await runOfflineStockFollowups('actor')
    expect(remote.reorder).toHaveBeenCalledWith('workspace', 'product', 'operation')
    expect(await db.app_settings.get(key)).toBeUndefined()
  })
  it('waits for related pending transactions without deleting or repeating business operations', async () => {
    await db.offline_mutations.put({ id: 'pending', entityId: 'pending', workspaceId: 'workspace', entityType: 'stock_operations', operation: 'create', createdAt: new Date().toISOString(), status: 'failed',
      payload: { effects: [{ table: 'inventory', after: { productId: 'product' } }] } })
    await runOfflineStockFollowups('actor')
    expect(remote.rpc).not.toHaveBeenCalled()
    await db.offline_mutations.update('pending', { status: 'synced' })
    await runOfflineStockFollowups('actor')
    expect(remote.reorder).toHaveBeenCalledOnce()
    expect(await db.offline_mutations.get('pending')).toMatchObject({ status: 'synced' })
  })
  it('does not run another actor or workspace’s jobs', async () => {
    await runOfflineStockFollowups('someone-else')
    setActiveBusinessWorkspace('another-workspace')
    await runOfflineStockFollowups('actor')
    expect(remote.rpc).not.toHaveBeenCalled()
    expect(await db.app_settings.get(key)).toEqual(job)
  })
})
