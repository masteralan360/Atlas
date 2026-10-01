import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => {
    const state: { salesOrder?: Record<string, any>; purchaseOrder?: Record<string, any> } = {}
    const makeTable = (key: 'salesOrder' | 'purchaseOrder') => ({
        get: vi.fn(async () => state[key] ? { ...state[key] } : undefined),
        update: vi.fn(async (_id: string, changes: Record<string, unknown>) => {
            if (!state[key]) return 0
            state[key] = { ...state[key], ...changes }
            return 1
        }),
        put: vi.fn(async (order: Record<string, any>) => {
            state[key] = { ...order }
            return order.id
        })
    })
    const sales_orders = makeTable('salesOrder')
    const purchase_orders = makeTable('purchaseOrder')
    return {
        sales_orders,
        purchase_orders,
        offline_mutations: {},
        transaction: vi.fn(async (_mode: string, _tables: unknown[], callback: () => Promise<unknown>) => callback()),
        setOrder(kind: 'sales' | 'purchase', order?: Record<string, any>) {
            state[kind === 'sales' ? 'salesOrder' : 'purchaseOrder'] = order ? { ...order } : undefined
        },
        getOrder(kind: 'sales' | 'purchase') {
            return state[kind === 'sales' ? 'salesOrder' : 'purchaseOrder']
        },
        reset() {
            state.salesOrder = undefined
            state.purchaseOrder = undefined
            for (const table of [sales_orders, purchase_orders]) {
                table.get.mockClear()
                table.update.mockClear()
                table.put.mockClear()
            }
            this.transaction.mockClear()
        }
    }
})

const remote = vi.hoisted(() => {
    let response: { data: any; error: any } = { data: null, error: null }
    const builder: Record<string, any> = {}
    builder.eq = vi.fn(() => builder)
    builder.select = vi.fn(() => builder)
    builder.maybeSingle = vi.fn(async () => response)
    const update = vi.fn(() => builder)
    const from = vi.fn(() => ({ update }))
    const client = { from }
    return {
        builder,
        client,
        from,
        update,
        setResponse(next: { data: any; error: any }) { response = next },
        reset() {
            response = { data: null, error: null }
            from.mockClear()
            update.mockClear()
            builder.eq.mockClear()
            builder.select.mockClear()
            builder.maybeSingle.mockClear()
        }
    }
})

const network = vi.hoisted(() => ({ isOnline: vi.fn(() => true) }))
const modes = vi.hoisted(() => ({ isLocalWorkspaceMode: vi.fn(() => false) }))
const queue = vi.hoisted(() => ({ add: vi.fn(async () => undefined) }))

vi.mock('./database', () => ({ db: dbMock }))
vi.mock('./offlineMutations', () => ({ addToOfflineMutations: queue.add }))
vi.mock('@/lib/network', () => ({ isOnline: network.isOnline }))
vi.mock('@/workspace/workspaceMode', () => ({ isLocalWorkspaceMode: modes.isLocalWorkspaceMode }))
vi.mock('@/lib/supabaseSchema', () => ({ getSupabaseClientForTable: vi.fn(() => remote.client) }))
vi.mock('@/lib/supabaseRequest', () => ({
    isRetriableWebRequestError: vi.fn(() => false),
    normalizeSupabaseActionError: vi.fn((error: unknown) => error instanceof Error ? error : new Error(String((error as any)?.message || error))),
    runSupabaseAction: vi.fn((_label: string, action: () => PromiseLike<unknown>) => action())
}))

import { getLocalizedOrderError } from '@/lib/orderErrors'
import { setOrderArchived } from './orderArchiving'

const order = (kind: 'sales' | 'purchase', overrides: Record<string, unknown> = {}) => ({
    id: 'order-1',
    workspaceId: 'workspace-1',
    status: 'cancelled',
    returnStatus: 'none',
    isArchived: false,
    isDeleted: false,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    version: 3,
    syncStatus: 'synced',
    lastSyncedAt: '2026-09-25T10:00:00.000Z',
    orderNumber: kind === 'sales' ? 'SO-001' : 'PO-001',
    total: 1250,
    ...overrides
})

describe('order archiving persistence', () => {
    beforeEach(() => {
        dbMock.reset()
        remote.reset()
        network.isOnline.mockReturnValue(true)
        modes.isLocalWorkspaceMode.mockReturnValue(false)
        queue.add.mockClear()
    })

    it.each(['sales', 'purchase'] as const)('sends only is_archived for an eligible %s order and updates its cache', async (kind) => {
        const existing = order(kind)
        dbMock.setOrder(kind, existing)
        remote.setResponse({ data: { id: existing.id, is_archived: true }, error: null })

        const saved = await setOrderArchived(existing.id, kind, true)

        expect(remote.from).toHaveBeenCalledWith(`${kind}_orders`)
        expect(remote.update).toHaveBeenCalledExactlyOnceWith({ is_archived: true })
        expect(remote.builder.eq.mock.calls).toEqual([
            ['id', existing.id],
            ['workspace_id', existing.workspaceId],
            ['is_archived', false]
        ])
        expect(dbMock[kind === 'sales' ? 'sales_orders' : 'purchase_orders'].update).toHaveBeenCalledWith(existing.id, {
            isArchived: true,
            syncStatus: 'synced',
            lastSyncedAt: expect.any(String)
        })
        expect(saved).toMatchObject({
            isArchived: true,
            status: 'cancelled',
            orderNumber: existing.orderNumber,
            total: existing.total,
            updatedAt: existing.updatedAt,
            version: existing.version
        })
        expect(queue.add).not.toHaveBeenCalled()
    })

    it('allows a fully returned sales order while preserving its lifecycle status', async () => {
        const existing = order('sales', { status: 'completed', returnStatus: 'full' })
        dbMock.setOrder('sales', existing)
        remote.setResponse({ data: { id: existing.id, is_archived: true }, error: null })

        await expect(setOrderArchived(existing.id, 'sales', true)).resolves.toMatchObject({
            isArchived: true,
            status: 'completed',
            returnStatus: 'full'
        })
    })

    it('rejects ineligible orders before sending a remote request', async () => {
        const existing = order('sales', { status: 'completed' })
        dbMock.setOrder('sales', existing)

        await expect(setOrderArchived(existing.id, 'sales', true)).rejects.toThrow('order_archive_not_allowed')
        expect(remote.from).not.toHaveBeenCalled()
        expect(dbMock.getOrder('sales')).toEqual(existing)
    })

    it('waits for pending cloud order changes to sync before archiving', async () => {
        const existing = order('sales', { syncStatus: 'pending' })
        dbMock.setOrder('sales', existing)

        await expect(setOrderArchived(existing.id, 'sales', true)).rejects.toThrow('order_archive_wait_for_sync')

        expect(remote.from).not.toHaveBeenCalled()
        expect(dbMock.getOrder('sales')).toEqual(existing)
    })

    it('keeps the local order unchanged when Supabase rejects the archive', async () => {
        const existing = order('purchase')
        dbMock.setOrder('purchase', existing)
        remote.setResponse({ data: null, error: { code: '23514', message: 'order_archive_not_allowed' } })

        const failure = await setOrderArchived(existing.id, 'purchase', true).catch((error: unknown) => error)

        expect(failure).toBeInstanceOf(Error)
        expect(getLocalizedOrderError(failure, ((key: string) => key) as any)).toBe('orders.archive.notAllowed')
        expect(dbMock.getOrder('purchase')).toEqual(existing)
        expect(dbMock.purchase_orders.update).not.toHaveBeenCalled()
    })

    it('unarchives through the same flag-only request and leaves status unchanged', async () => {
        const existing = order('purchase', { isArchived: true, status: 'cancelled' })
        dbMock.setOrder('purchase', existing)
        remote.setResponse({ data: { id: existing.id, is_archived: false }, error: null })

        await expect(setOrderArchived(existing.id, 'purchase', false)).resolves.toMatchObject({
            isArchived: false,
            status: 'cancelled'
        })
        expect(remote.update).toHaveBeenCalledExactlyOnceWith({ is_archived: false })
        expect(remote.builder.eq).toHaveBeenNthCalledWith(3, 'is_archived', true)
    })

    it('queues the unchanged order snapshot when offline', async () => {
        const existing = order('sales')
        dbMock.setOrder('sales', existing)
        network.isOnline.mockReturnValue(false)

        await expect(setOrderArchived(existing.id, 'sales', true)).resolves.toMatchObject({ isArchived: true })

        expect(remote.from).not.toHaveBeenCalled()
        expect(dbMock.sales_orders.put).toHaveBeenCalledWith(expect.objectContaining({
            isArchived: true,
            status: existing.status,
            orderNumber: existing.orderNumber,
            total: existing.total,
            updatedAt: existing.updatedAt,
            version: existing.version,
            syncStatus: 'pending'
        }))
        expect(queue.add).toHaveBeenCalledWith(
            'sales_orders', existing.id, 'update', expect.objectContaining({ isArchived: true }), existing.workspaceId
        )
    })

    it('writes only the local flag in Local mode', async () => {
        const existing = order('sales')
        dbMock.setOrder('sales', existing)
        modes.isLocalWorkspaceMode.mockReturnValue(true)

        await expect(setOrderArchived(existing.id, 'sales', true)).resolves.toMatchObject({ isArchived: true })

        expect(remote.from).not.toHaveBeenCalled()
        expect(dbMock.sales_orders.update).toHaveBeenCalledExactlyOnceWith(existing.id, { isArchived: true })
    })
})
