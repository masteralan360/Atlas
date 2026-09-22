import { beforeEach, describe, expect, it, vi } from 'vitest'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000002'

const dbMock = vi.hoisted(() => {
    let customer: Record<string, unknown> | undefined

    return {
        customers: {
            get: vi.fn(async () => customer),
            put: vi.fn(async (next: Record<string, unknown>) => {
                customer = { ...next }
                return next.id
            }),
            update: vi.fn(async (_id: string, changes: Record<string, unknown>) => {
                customer = customer ? { ...customer, ...changes } : customer
                return customer ? 1 : 0
            })
        },
        sales_orders: {
            where: vi.fn(() => ({
                equals: vi.fn(() => ({
                    and: vi.fn(() => ({
                        toArray: vi.fn(async () => [])
                    }))
                }))
            }))
        },
        setCustomer(next: Record<string, unknown> | undefined) {
            customer = next ? { ...next } : undefined
        },
        getCustomer() {
            return customer
        },
        reset() {
            customer = undefined
            this.customers.get.mockClear()
            this.customers.put.mockClear()
            this.customers.update.mockClear()
            this.sales_orders.where.mockClear()
        }
    }
})

const supabaseMock = vi.hoisted(() => {
    const rpc = vi.fn<(...args: unknown[]) => Promise<{ data: null; error: null }>>(async () => ({ data: null, error: null }))
    const from = vi.fn()

    return {
        client: { rpc, from },
        rpc,
        from,
        reset() {
            rpc.mockClear()
            from.mockClear()
        }
    }
})

vi.mock('./database', () => ({ db: dbMock }))

vi.mock('./hooks', () => ({
    addToOfflineMutations: vi.fn(),
    fetchTableFromSupabase: vi.fn()
}))

vi.mock('@/hooks/useNetworkStatus', () => ({
    useNetworkStatus: vi.fn(() => true)
}))

vi.mock('@/lib/network', () => ({
    isOnline: vi.fn(() => true)
}))

vi.mock('@/lib/supabaseSchema', () => ({
    getPartnerSyncWriteRpc: vi.fn((tableName: string) => tableName === 'customers'
        ? 'sync_customer'
        : tableName === 'suppliers'
            ? 'sync_supplier'
            : undefined),
    getSupabaseClientForTable: vi.fn(() => supabaseMock.client)
}))

vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: vi.fn((_label: string, action: () => PromiseLike<unknown>) => action())
}))

vi.mock('@/workspace/workspaceMode', () => ({
    isLocalWorkspaceMode: vi.fn(() => false)
}))

vi.mock('@/auth/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() }
}))

vi.mock('@/permissions/useViewOwnRecordScope', () => ({
    useViewOwnRecordScope: vi.fn()
}))

vi.mock('@/permissions/workspacePermissionsState', () => ({
    useOptionalWorkspacePermissions: vi.fn()
}))

vi.mock('./businessPartnerPrivacy', () => ({
    canAccessBusinessPartnerFacetInLocalCache: vi.fn(() => true),
    canAccessBusinessPartnerInLocalCache: vi.fn(() => true)
}))

vi.mock('./businessPartners', () => ({
    ensurePartnerFacet: vi.fn(),
    getBusinessPartnerByAnyId: vi.fn(),
    recalculateBusinessPartnerSummary: vi.fn()
}))

import { recalculateCustomerSummary, sanitizeSyncPayload } from './orders'

describe('order related-unit Cloud request contract', () => {
    it('keeps immutable line snapshots in the JSON payload while removing client-only sync metadata', () => {
        const payload = sanitizeSyncPayload('sales_orders', {
            id: 'order-related',
            workspaceId: WORKSPACE_ID,
            syncStatus: 'pending',
            lastSyncedAt: null,
            items: [{
                id: 'line-related',
                quantity: 2,
                unitRelationshipId: 'relationship-carton-sheet',
                unitRef: 'builtin:carton',
                baseUnitRef: 'builtin:sheet',
                baseUnitCode: 'sheet',
                unitFactor: 20,
                inventoryQuantity: 40,
                freeBonusInventoryQuantity: 20
            }]
        })

        expect(payload).toMatchObject({
            workspace_id: WORKSPACE_ID,
            items: [expect.objectContaining({
                unitRelationshipId: 'relationship-carton-sheet',
                unitRef: 'builtin:carton',
                baseUnitRef: 'builtin:sheet',
                unitFactor: 20,
                inventoryQuantity: 40,
                freeBonusInventoryQuantity: 20
            })]
        })
        expect(payload).not.toHaveProperty('sync_status')
        expect(payload).not.toHaveProperty('last_synced_at')
    })
})

describe('order counterparty summary sync', () => {
    beforeEach(() => {
        dbMock.reset()
        supabaseMock.reset()
        dbMock.setCustomer({
            id: CUSTOMER_ID,
            workspaceId: WORKSPACE_ID,
            businessPartnerId: '00000000-0000-4000-8000-000000000003',
            partnerName: 'Canonical customer name',
            // These values can exist in a pre-migration browser cache.
            name: 'Retired customer name',
            contactName: 'Retired contact name',
            email: 'legacy@example.test',
            country: 'Iraq',
            defaultCurrency: 'iqd',
            totalOrders: 99,
            totalSpent: 123,
            outstandingBalance: 456,
            creditLimit: 0,
            createdAt: '2026-09-05T10:00:00.000Z',
            updatedAt: '2026-09-05T10:00:00.000Z',
            syncStatus: 'pending',
            lastSyncedAt: null,
            version: 1,
            isDeleted: false,
            isLocked: false
        })
    })

    it('uses the privacy-checked customer RPC after an order changes its summary', async () => {
        await recalculateCustomerSummary(WORKSPACE_ID, CUSTOMER_ID)

        expect(supabaseMock.from).not.toHaveBeenCalled()
        expect(supabaseMock.rpc).toHaveBeenCalledWith('sync_customer', expect.objectContaining({
            p_operation: 'upsert',
            p_entity_id: CUSTOMER_ID,
            p_workspace_id: WORKSPACE_ID,
            p_payload: expect.objectContaining({
                partner_name: 'Canonical customer name',
                total_orders: 0,
                total_spent: 0,
                outstanding_balance: 0
            })
        }))

        const request = supabaseMock.rpc.mock.calls[0]?.[1] as { p_payload?: Record<string, unknown> } | undefined
        const payload = request?.p_payload ?? {}
        expect(payload).not.toHaveProperty('name')
        expect(payload).not.toHaveProperty('contact_name')
        expect(payload).not.toHaveProperty('email')
        expect(payload).not.toHaveProperty('country')
        expect(dbMock.getCustomer()).toMatchObject({ syncStatus: 'synced' })
    })
})
