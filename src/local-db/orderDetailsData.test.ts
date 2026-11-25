import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'
import type { SalesOrder } from './models'

const workspaceId = '00000000-0000-4000-8000-000000000001'
const orderId = '00000000-0000-4000-8000-000000000002'
const timestamp = '2026-11-25T10:00:00Z'
const request = vi.hoisted(() => ({
    from: vi.fn(),
    eq: vi.fn(),
    abortSignal: vi.fn(),
    maybeSingle: vi.fn(),
}))

vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: () => ({ from: request.from }),
    getSupabaseRemoteTableName: (table: string) => table,
}))
vi.mock('@/auth', () => ({ useOptionalAuth: () => null }))
vi.mock('@/workspace', () => ({ useWorkspace: vi.fn() }))
vi.mock('./storagePermissions', () => ({ useStorageAccess: vi.fn() }))
vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: (_label: string, run: () => unknown) => run(),
    normalizeSupabaseActionError: (error: unknown) => error,
}))

let refreshOrderDetails: typeof import('./orderDetailsData').refreshOrderDetails

describe('single-order Cloud and Hybrid refresh', () => {
    beforeAll(async () => {
        installTestBrowser()
        const detailsData = await import('./orderDetailsData')
        refreshOrderDetails = detailsData.refreshOrderDetails
    }, 30_000)

    beforeEach(async () => {
        await db.delete()
        await db.open()
        vi.clearAllMocks()
        request.from.mockReturnValue({ select: () => request })
        request.eq.mockReturnValue(request)
        request.abortSignal.mockReturnValue(request)
        request.maybeSingle.mockResolvedValue({ data: {
            id: orderId, workspace_id: workspaceId, version: 2, status: 'completed', updated_at: timestamp, items: []
        }, error: null })
        await db.sales_orders.put({
            id: orderId, workspaceId, version: 1, status: 'pending', syncStatus: 'synced',
            updatedAt: timestamp, createdAt: timestamp, lastSyncedAt: timestamp, isDeleted: false, isArchived: false,
            orderNumber: 'SO-1', customerId: 'customer', customerName: 'Customer', items: [],
            subtotal: 0, discount: 0, tax: 0, total: 0, currency: 'usd',
            exchangeRate: null, exchangeRateSource: null, exchangeRateTimestamp: null,
            isPaid: false, paymentStatus: 'unpaid', paidAmount: 0, balanceAmount: 0, initialPaymentAmount: 0,
            isInstallmentBased: false, installmentCount: 0,
        } satisfies SalesOrder)
    })

    afterAll(async () => { await db.delete() })

    it.each(['cloud', 'hybrid'] as const)('reconciles a cached pending %s order using its workspace and ID', async dataMode => {
        writeWorkspaceModeSnapshot({ workspaceId, dataMode })
        const { signal } = new AbortController()
        await expect(refreshOrderDetails(workspaceId, orderId, 'sales', signal)).resolves.toMatchObject({ version: 2, status: 'completed' })
        expect(request.from).toHaveBeenCalledWith('sales_orders')
        expect(request.eq.mock.calls).toEqual([['workspace_id', workspaceId], ['id', orderId]])
        expect(request.abortSignal).toHaveBeenCalledWith(signal)
        expect(await db.sales_orders.get(orderId)).toMatchObject({ version: 2, status: 'completed' })
    })

    it.each(['pending', 'conflict'] as const)('preserves a %s local order', async syncStatus => {
        writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'hybrid' })
        await db.sales_orders.update(orderId, { syncStatus })
        await refreshOrderDetails(workspaceId, orderId, 'sales')
        expect(await db.sales_orders.get(orderId)).toMatchObject({ version: 1, status: 'pending', syncStatus })
    })

    it('ignores a remote snapshot older than a concurrent Dexie update', async () => {
        writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'cloud' })
        await db.sales_orders.update(orderId, { version: 3, status: 'cancelled' })
        await refreshOrderDetails(workspaceId, orderId, 'sales')
        expect(await db.sales_orders.get(orderId)).toMatchObject({ version: 3, status: 'cancelled' })
    })

    it('leaves Dexie alone when the detail request is cancelled', async () => {
        writeWorkspaceModeSnapshot({ workspaceId, dataMode: 'cloud' })
        const controller = new AbortController()
        controller.abort()
        await expect(refreshOrderDetails(workspaceId, orderId, 'sales', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(await db.sales_orders.get(orderId)).toMatchObject({ version: 1, status: 'pending' })
    })
})
