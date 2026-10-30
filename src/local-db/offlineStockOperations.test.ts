import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveBusinessUser, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'
import { currentStockOperation } from './offlineStockContext'
import { needsOfflineStockOperation, runOfflineStockOperation, replayOfflineStockOperation, type OfflineStockOperation } from './offlineStockOperations'
import { supabase } from '@/auth/supabase'
import { cacheOfflineStockAvailability, readOfflineStockAvailability } from './offlineStockAvailability'
import { resolveStockRow } from './offlineStockAliases'
vi.mock('./inventory', () => ({ syncProductStockSnapshot: vi.fn() }))
vi.mock('./paymentAccounts', () => ({ mirrorPaymentAccountTransactionLocally: vi.fn() }))
vi.mock('@/auth/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), schema: () => ({ from: vi.fn(), rpc: vi.fn() }) }, isSupabaseConfigured: true }))

const workspace = '00000000-0000-4000-8000-000000000701'
const actor = '00000000-0000-4000-8000-000000000702'
const inventoryId = '00000000-0000-4000-8000-000000000703'
const productId = '00000000-0000-4000-8000-000000000704'
const storageId = '00000000-0000-4000-8000-000000000705'

describe('durable offline stock operations', () => {
  beforeAll(() => {
    const storage = new Map<string, string>()
    const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), get length() { return storage.size } }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() } })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage, location: { hash: '', origin: 'http://localhost', pathname: '/' }, dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
  })
  beforeEach(async () => {
    await db.delete(); await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: workspace, dataMode: 'cloud' })
    setActiveBusinessUser(actor, 'admin', workspace)
    setNetworkStatus(false)
    await db.inventory.put({ id: inventoryId, workspaceId: workspace, productId, storageId, quantity: 10,
      version: 1, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', isDeleted: false, syncStatus: 'synced', lastSyncedAt: null })
  })
  afterAll(async () => { await db.delete(); clearWorkspaceModeSnapshot(workspace); setNetworkStatus(true); setActiveBusinessUser(null) })

  it('commits the stock effect and immutable outbox together', async () => {
    expect(await needsOfflineStockOperation(workspace)).toBe(true)
    await runOfflineStockOperation(workspace, 'adjustment', async () => {
      expect(currentStockOperation(workspace)?.kind).toBe('adjustment')
      await db.inventory.update(inventoryId, { quantity: 8, version: 2 })
    })
    expect(await db.inventory.get(inventoryId)).toMatchObject({ quantity: 8, syncStatus: 'pending' })
    const commands = await db.offline_mutations.toArray()
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ entityType: 'stock_operations', status: 'pending', payload: { actorId: actor, version: 1, sequence: 1 } })
    expect(commands[0].payload.effects).toMatchObject([{ table: 'inventory', before: { quantity: 10 }, after: { quantity: 8 } }])
    expect(currentStockOperation()).toBeUndefined()
  })
  it('rolls back every effect if a payment or later persistence step fails', async () => {
    await expect(runOfflineStockOperation(workspace, 'checkout', async () => {
      await db.inventory.update(inventoryId, { quantity: 4 })
      throw new Error('payment rejected')
    })).rejects.toThrow('payment rejected')
    expect(await db.inventory.get(inventoryId)).toMatchObject({ quantity: 10, syncStatus: 'synced' })
    expect(await db.offline_mutations.count()).toBe(0)
  })
  it('keeps repeated movements separate and records their dependency', async () => {
    for (const quantity of [9, 7]) await runOfflineStockOperation(workspace, 'adjustment', () => db.inventory.update(inventoryId, { quantity }))
    const commands = await db.offline_mutations.orderBy('createdAt').toArray()
    expect(commands).toHaveLength(2)
    expect(commands[1].payload.dependencies).toEqual([commands[0].id])
    await db.close(); await db.open()
    expect(await db.offline_mutations.count()).toBe(2)
    expect(await db.inventory.get(inventoryId)).toMatchObject({ quantity: 7 })
  })
  it('rejects cross-workspace writes and does not leak its context to another transaction', async () => {
    await expect(runOfflineStockOperation(workspace, 'adjustment', () => db.inventory.update(inventoryId, { workspaceId: actor }))).rejects.toThrow()
    expect(await db.inventory.get(inventoryId)).toMatchObject({ workspaceId: workspace })
    expect(currentStockOperation()).toBeUndefined()
  })
  it('preserves ordinary Local mode without queuing Cloud work', async () => {
    writeWorkspaceModeSnapshot({ workspaceId: workspace, dataMode: 'local' })
    expect(await needsOfflineStockOperation(workspace)).toBe(false)
    await runOfflineStockOperation(workspace, 'adjustment', () => db.inventory.update(inventoryId, { quantity: 6 }))
    expect(await db.offline_mutations.count()).toBe(0)
  })
  it('keeps later offline deltas while confirming a rebased server result', async () => {
    await cacheOfflineStockAvailability(workspace, [{ productId, storageId, onHand: 10, reserved: 0, available: 10 }])
    for (const quantity of [8, 7]) await runOfflineStockOperation(workspace, 'adjustment', () => db.inventory.update(inventoryId, { quantity }))
    const queued = await db.offline_mutations.orderBy('createdAt').toArray()
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: { id: queued[0].id,
      rows: [{ table: 'inventory', row: { id: inventoryId, workspace_id: workspace, product_id: productId, storage_id: storageId, quantity: 5, version: 4 } }],
      availability: [{ productId, storageId, onHand: 5, reserved: 0, available: 5 }],
    }, error: null } as never)
    await replayOfflineStockOperation(queued[0].payload as unknown as OfflineStockOperation)
    expect(await db.inventory.get(inventoryId)).toMatchObject({ quantity: 4, syncStatus: 'pending' })
    expect(await readOfflineStockAvailability(workspace, [{ productId, storageId }])).toMatchObject([{ onHand: 4, available: 4 }])
    expect(await db.offline_mutations.get(queued[0].id)).toMatchObject({ status: 'synced' })
    expect(await db.offline_mutations.get(queued[1].id)).toMatchObject({ status: 'pending' })
  })
  it('protects aggregate reservations even when their orders are not visible locally', async () => {
    await cacheOfflineStockAvailability(workspace, [{ productId, storageId, onHand: 10, reserved: 8, available: 2 }])
    expect(await db.sales_orders.count()).toBe(0)
    expect(await readOfflineStockAvailability(workspace, [{ productId, storageId }])).toMatchObject([{ reserved: 8, available: 2 }])
    await expect(readOfflineStockAvailability(workspace, [{ productId, storageId: actor }])).rejects.toThrow()
  })
  it('cannot replay dependent work before confirmation or use another signed-in actor', async () => {
    for (const quantity of [8, 7]) await runOfflineStockOperation(workspace, 'adjustment', () => db.inventory.update(inventoryId, { quantity }))
    const queued = await db.offline_mutations.orderBy('createdAt').toArray()
    await expect(replayOfflineStockOperation(queued[1].payload as unknown as OfflineStockOperation)).rejects.toThrow()
    setActiveBusinessUser(productId, 'admin', workspace)
    await expect(replayOfflineStockOperation(queued[0].payload as unknown as OfflineStockOperation)).rejects.toThrow()
    expect(await db.inventory.get(inventoryId)).toMatchObject({ quantity: 7 })
  })
  it('maps child references by table without rewriting a shared return/payment UUID', () => {
    const aliases = [{ table: 'payment_transactions', from: inventoryId, to: productId }]
    expect(resolveStockRow(aliases, 'sale_returns', { id: inventoryId, saleReturnId: inventoryId, paymentTransactionId: inventoryId }))
      .toEqual({ id: inventoryId, saleReturnId: inventoryId, paymentTransactionId: productId })
  })

  it('translates only dependent document revisions after canonical staging adds a server version', async () => {
    const id = storageId
    await runOfflineStockOperation(workspace, 'purchase_order', () => db.purchase_orders.put({ id, workspaceId: workspace, version: 1, status: 'received', syncStatus: 'pending' } as never))
    await runOfflineStockOperation(workspace, 'purchase_order', () => db.purchase_orders.update(id, { version: 2, status: 'cancelled' }))
    const queued = await db.offline_mutations.orderBy('createdAt').toArray()
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: { id: queued[0].id, rows: [{ table: 'purchase_orders', row: { id, workspace_id: workspace, status: 'received', version: 2 } }] }, error: null } as never)
    await replayOfflineStockOperation(queued[0].payload as unknown as OfflineStockOperation)
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: { id: queued[1].id, rows: [{ table: 'purchase_orders', row: { id, workspace_id: workspace, status: 'cancelled', version: 3 } }] }, error: null } as never)
    await replayOfflineStockOperation(queued[1].payload as unknown as OfflineStockOperation)
    expect(vi.mocked(supabase.rpc).mock.lastCall?.[1]?.p_operation.effects).toMatchObject([{ before: { version: 2 }, after: { version: 3 } }])
    expect(await db.purchase_orders.get(id)).toMatchObject({ version: 3, syncStatus: 'synced' })
    expect((queued[1].payload.effects as { before: { version: number } }[])[0].before.version).toBe(1)
  })
  it('keeps a pending child when a server-generated sale-item ID replaces the local ID', async () => {
    const localId = inventoryId, confirmedId = productId
    await runOfflineStockOperation(workspace, 'exchange', () => db.sale_items.put({ id: localId, workspaceId: workspace, version: 1, quantity: 2, returnedQuantity: 0, syncStatus: 'pending' } as never))
    await runOfflineStockOperation(workspace, 'return', () => db.sale_items.update(localId, { returnedQuantity: 1, version: 2 } as never))
    const queued = await db.offline_mutations.orderBy('createdAt').toArray()
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: { id: queued[0].id,
      aliases: [{ table: 'sale_items', from: localId, to: confirmedId }],
      rows: [{ table: 'sale_items', row: { id: confirmedId, workspace_id: workspace, quantity: 2, returned_quantity: 0, version: 1 } }],
    }, error: null } as never)
    await replayOfflineStockOperation(queued[0].payload as unknown as OfflineStockOperation)
    expect(await db.sale_items.get(localId)).toBeUndefined()
    expect(await db.sale_items.get(confirmedId)).toMatchObject({ returnedQuantity: 1, version: 2, syncStatus: 'pending' })
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: { id: queued[1].id, rows: [{ table: 'sale_items', row: { id: confirmedId, workspace_id: workspace, returned_quantity: 1, version: 2 } }] }, error: null } as never)
    await replayOfflineStockOperation(queued[1].payload as unknown as OfflineStockOperation)
    expect(vi.mocked(supabase.rpc).mock.lastCall?.[1]?.p_operation.effects).toMatchObject([{ id: confirmedId, before: { id: confirmedId }, after: { id: confirmedId, returned_quantity: 1 } }])
    expect(await db.sale_items.get(confirmedId)).toMatchObject({ returnedQuantity: 1, syncStatus: 'synced' })
  })

})
