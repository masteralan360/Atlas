import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => {
    const rows: Array<Record<string, any>> = []
    const sales = {
        update: vi.fn(async () => 1),
        get: vi.fn(async () => undefined),
        put: vi.fn(async () => 'sale'),
        bulkGet: vi.fn<(ids: unknown[]) => Promise<Array<Record<string, any> | undefined>>>(
            async (ids) => ids.map(() => undefined)
        ),
        bulkPut: vi.fn<(rows: Array<Record<string, any>>) => Promise<void>>(async () => undefined)
    }
    const invoices = {
        update: vi.fn(async () => 1)
    }
    const saleReturns = {
        update: vi.fn(async () => 1)
    }
    const saleReturnItems = {
        where: vi.fn(() => ({
            equals: vi.fn(() => ({
                modify: vi.fn(async () => 1)
            }))
        }))
    }
    const products = {
        update: vi.fn(async () => 1)
    }
    const salesOrders = {
        update: vi.fn(async () => 1)
    }
    const purchaseOrders = {
        update: vi.fn(async () => 1)
    }
    const salesOrderAgentAssignments = {
        delete: vi.fn(async () => 1),
        put: vi.fn(async () => 'assignment')
    }
    const inventoryTransactions = {
        put: vi.fn(async () => 'inventory-transaction')
    }

    const offlineMutations = {
        where: vi.fn((indexName: string) => ({
            equals: vi.fn((value: unknown) => {
                const matchingRows = () => rows.filter((row) => row.status === value)
                const sortRows = async (sourceRows: Array<Record<string, any>>, sortField: string) => {
                    if (indexName !== 'status' || sortField !== 'createdAt') {
                        throw new Error(`Unsupported query: ${indexName}/${sortField}`)
                    }

                    return sourceRows.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
                }
                return {
                    sortBy: vi.fn((sortField: string) => sortRows(matchingRows(), sortField)),
                    filter: vi.fn((predicate: (row: Record<string, any>) => boolean) => ({
                        sortBy: vi.fn((sortField: string) => sortRows(matchingRows().filter(predicate), sortField)),
                        count: vi.fn(async () => matchingRows().filter(predicate).length)
                    })),
                    count: vi.fn(async () => matchingRows().length)
                }
            })
        })),
        update: vi.fn(async (id: string, patch: Record<string, any>) => {
            const row = rows.find((item) => item.id === id)
            if (!row) return 0

            Object.assign(row, patch)
            return 1
        })
    }

    return {
        rows,
        offlineMutations,
        sales,
        invoices,
        saleReturns,
        saleReturnItems,
        products,
        salesOrders,
        purchaseOrders,
        salesOrderAgentAssignments,
        inventoryTransactions,
        reset() {
            rows.splice(0)
            offlineMutations.where.mockClear()
            offlineMutations.update.mockClear()
            sales.update.mockClear()
            sales.get.mockClear()
            sales.put.mockClear()
            sales.bulkGet.mockClear()
            sales.bulkPut.mockClear()
            invoices.update.mockClear()
            saleReturns.update.mockClear()
            saleReturnItems.where.mockClear()
            products.update.mockClear()
            salesOrders.update.mockClear()
            purchaseOrders.update.mockClear()
            salesOrderAgentAssignments.delete.mockClear()
            salesOrderAgentAssignments.put.mockClear()
            inventoryTransactions.put.mockClear()
        }
    }
})

const supabaseMock = vi.hoisted(() => {
    const mutationError = new Error('permission denied')
    const upsert = vi.fn(async (): Promise<{ data: null; error: Error | null }> => ({ data: null, error: mutationError }))
    const insert = vi.fn(async (): Promise<{ data: null; error: Error | null }> => ({ data: null, error: null }))
    const rpc = vi.fn<(...args: unknown[]) => any>(async (..._args: unknown[]) => ({ data: null as any, error: null as any }))
    const orderUpsert = vi.fn(() => ({
        select: vi.fn(async () => ({ data: [] as any[], error: null as any }))
    }))
    let saleLookup: Record<string, any> | null = null
    let activeSalesOrderAssignment: Record<string, any> | null = null
    let pullError: Error | null = null
    const pullRowsByTable = new Map<string, Array<Record<string, any>>>()

    const makeBuilder = (tableName: string) => {
        const builder: Record<string, any> = {}
        Object.assign(builder, {
            select: vi.fn(() => builder),
            eq: vi.fn((column: string) => {
                if (tableName === 'workspaces' && column === 'id') {
                    return Promise.resolve({ data: [], error: pullError })
                }

                return builder
            }),
            gt: vi.fn(() => builder),
            order: vi.fn(() => builder),
            range: vi.fn(async (from: number, to: number) => ({
                data: (pullRowsByTable.get(tableName) ?? []).slice(from, to + 1),
                error: pullError
            })),
            in: vi.fn(() => builder),
            is: vi.fn(() => builder),
            maybeSingle: vi.fn(async () => ({
                data: tableName === 'sales'
                    ? saleLookup
                    : tableName === 'sales_order_agent_assignments'
                        ? activeSalesOrderAssignment
                        : null,
                error: null
            })),
            upsert: tableName === 'sales_orders' || tableName === 'purchase_orders'
                ? orderUpsert
                : upsert,
            insert,
            update: vi.fn(() => ({
                eq: vi.fn(async () => ({ data: null, error: null }))
            })),
            delete: vi.fn(() => ({
                eq: vi.fn(async () => ({ data: null, error: null }))
            }))
        })

        return builder
    }

    const from = vi.fn((tableName: string) => makeBuilder(tableName))

    return {
        client: { from, rpc },
        from,
        mutationError,
        rpc,
        upsert,
        insert,
        orderUpsert,
        setSaleLookup(row: Record<string, any> | null) {
            saleLookup = row
        },
        setPullError(error: Error | null) {
            pullError = error
        },
        setPullRows(tableName: string, rows: Array<Record<string, any>>) {
            pullRowsByTable.set(tableName, rows)
        },
        setActiveSalesOrderAssignment(row: Record<string, any> | null) {
            activeSalesOrderAssignment = row
        },
        reset() {
            from.mockClear()
            rpc.mockClear()
            upsert.mockClear()
            insert.mockClear()
            orderUpsert.mockClear()
            saleLookup = null
            activeSalesOrderAssignment = null
            pullError = null
            pullRowsByTable.clear()
        }
    }
})

const workspaceModeMock = vi.hoisted(() => ({
    isLocalWorkspaceMode: vi.fn(() => false)
}))

const schemaRoutingMock = vi.hoisted(() => ({
    getPartnerSyncWriteRpc: vi.fn((tableName: string) => tableName === 'business_partners'
        ? 'sync_business_partner'
        : undefined),
    getVisibilityScopedTableRpc: vi.fn<(tableName: string) => string | undefined>(() => undefined)
}))

vi.mock('@/auth/supabase', () => ({
    isSupabaseConfigured: true,
    supabase: {
        from: supabaseMock.from,
        rpc: supabaseMock.rpc
    }
}))

vi.mock('@/local-db', () => ({
    db: {
        offline_mutations: dbMock.offlineMutations,
        sales: dbMock.sales,
        invoices: dbMock.invoices,
        sale_returns: dbMock.saleReturns,
        sale_return_items: dbMock.saleReturnItems,
        products: dbMock.products,
        sales_orders: dbMock.salesOrders,
        purchase_orders: dbMock.purchaseOrders,
        sales_order_agent_assignments: dbMock.salesOrderAgentAssignments,
        inventory_transactions: dbMock.inventoryTransactions
    }
}))

vi.mock('@/local-db/inventory', () => ({
    syncProductStockSnapshot: vi.fn(async () => undefined)
}))

vi.mock('@/local-db/productBarcodes', () => ({
    syncProductBarcodeCachesForWorkspace: vi.fn(async () => undefined)
}))

vi.mock('@/local-db/payments', () => ({
    synchronizeOrderPaymentReferences: vi.fn(async () => [])
}))

vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: vi.fn((_label: string, action: () => PromiseLike<unknown>) => action())
}))

vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: vi.fn(() => supabaseMock.client),
    getSupabaseRemoteTableName: vi.fn((tableName: string) => tableName),
    getPartnerSyncWriteRpc: schemaRoutingMock.getPartnerSyncWriteRpc,
    getVisibilityScopedTableRpc: schemaRoutingMock.getVisibilityScopedTableRpc
}))

vi.mock('@/workspace/workspaceMode', () => ({
    isLocalWorkspaceMode: workspaceModeMock.isLocalWorkspaceMode
}))

import {
    fullSync,
    isExistingCommissionEntryRetry,
    isRecoverableCashierShiftTerminalReplayMutation,
    isRecoverablePriceBookMutation,
    orderMutationsForSync,
    processMutationQueue,
    pullChanges,
    shouldApplyRemoteItem
} from './syncEngine'

describe('immutable commission entry retry detection', () => {
    it('accepts only a duplicate-key retry for the same ledger entry id', () => {
        expect(isExistingCommissionEntryRetry(
            { code: '23505' },
            'entry-1',
            'entry-1'
        )).toBe(true)
        expect(isExistingCommissionEntryRetry(
            { code: '23505' },
            'another-entry',
            'entry-1'
        )).toBe(false)
        expect(isExistingCommissionEntryRetry(
            { code: '42501' },
            'entry-1',
            'entry-1'
        )).toBe(false)
    })
})
import { inspectRemoteMutationPayload, prepareRemoteMutationPayload } from './syncPayloadContract'

describe('Price Book sync recovery', () => {
    it('removes only explicitly classified local fields from mutation payloads', () => {
        const payload = prepareRemoteMutationPayload('products', {
            id: 'product-1',
            skuKey: 'desk',
            quantity: 10,
            futureFlag: true,
            syncStatus: 'pending'
        })

        expect(payload).toMatchObject({ id: 'product-1', future_flag: true })
        expect(payload).not.toHaveProperty('sku_key')
        expect(payload).not.toHaveProperty('quantity')
        expect(payload).not.toHaveProperty('sync_status')
    })

    it('syncs partnerName while excluding historical name metadata', () => {
        const payload = prepareRemoteMutationPayload('business_partners', {
            id: 'partner-1',
            partnerName: 'Northwind Trading',
            name: 'Historical company name',
            contactName: 'Historical contact name',
            email: 'legacy@example.test',
            country: 'Iraq'
        })

        expect(payload).toMatchObject({
            id: 'partner-1',
            partner_name: 'Northwind Trading'
        })
        expect(payload).not.toHaveProperty('name')
        expect(payload).not.toHaveProperty('contact_name')
        expect(payload).not.toHaveProperty('email')
        expect(payload).not.toHaveProperty('country')
    })

    it('explains valid, excluded, and schema-rejected payload fields', () => {
        const rows = inspectRemoteMutationPayload('products', {
            id: 'product-1',
            name: 'Desk',
            skuKey: 'desk',
            futureFlag: true
        }, "Schema mismatch: Supabase does not recognize products.future_flag. Original error: Could not find the 'future_flag' column of 'products' in the schema cache")

        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'name', status: 'valid' }),
            expect.objectContaining({ field: 'sku_key', status: 'excluded' }),
            expect.objectContaining({ field: 'future_flag', status: 'invalid' })
        ]))
    })

    it('only treats transient Price Book failures as recoverable', () => {
        expect(isRecoverablePriceBookMutation({
            entityType: 'price_book_items',
            error: 'fetch failed: network timeout'
        })).toBe(true)

        for (const error of [
            'permission denied by row-level security (42501)',
            'duplicate key violates unique constraint (23505)',
            'Price book item must reference a price book in the same workspace (23514)'
        ]) {
            expect(isRecoverablePriceBookMutation({ entityType: 'price_book_items', error })).toBe(false)
        }
        expect(isRecoverablePriceBookMutation({ entityType: 'products', error: 'permission denied' })).toBe(false)
    })

    it('retries only an interrupted terminal cashier-shift replay', () => {
        const error = 'A cashier shift occurrence must start as active.'
        expect(isRecoverableCashierShiftTerminalReplayMutation({
            entityType: 'cashier_shift_occurrences',
            operation: 'update',
            payload: { status: 'terminated' },
            error
        })).toBe(true)
        expect(isRecoverableCashierShiftTerminalReplayMutation({
            entityType: 'cashier_shift_occurrences',
            operation: 'create',
            payload: { status: 'completed' },
            error
        })).toBe(true)
        expect(isRecoverableCashierShiftTerminalReplayMutation({
            entityType: 'cashier_shift_occurrences',
            operation: 'update',
            payload: { status: 'terminated' },
            error: 'The occurrence policy must match its assignment.'
        })).toBe(true)
        expect(isRecoverableCashierShiftTerminalReplayMutation({
            entityType: 'cashier_shift_occurrences',
            operation: 'update',
            payload: { status: 'terminated' },
            error: 'A finalized cashier shift occurrence is immutable.'
        })).toBe(true)
        expect(isRecoverableCashierShiftTerminalReplayMutation({
            entityType: 'cashier_shift_occurrences',
            operation: 'update',
            payload: { status: 'active' },
            error
        })).toBe(false)
        expect(isRecoverableCashierShiftTerminalReplayMutation({
            entityType: 'cashier_shift_occurrences',
            operation: 'delete',
            payload: { status: 'terminated' },
            error
        })).toBe(false)
        expect(isRecoverableCashierShiftTerminalReplayMutation({
            entityType: 'sales',
            operation: 'update',
            payload: { status: 'terminated' },
            error
        })).toBe(false)
    })

    it('applies the newer timestamp when concurrent rows have the same version', () => {
        const local = {
            version: 2,
            updatedAt: '2026-07-12T08:00:00.000Z',
            syncStatus: 'synced'
        }
        expect(shouldApplyRemoteItem('price_book_items', local, {
            version: 2,
            updatedAt: '2026-07-12T09:00:00.000Z'
        })).toBe(true)
        expect(shouldApplyRemoteItem('price_book_items', local, {
            version: 2,
            updatedAt: '2026-07-12T07:00:00.000Z'
        })).toBe(false)
    })

    it('preserves pending and conflicting local records during a pull', () => {
        const remote = { version: 99, updatedAt: '2026-07-12T10:00:00.000Z' }

        expect(shouldApplyRemoteItem('products', {
            version: 1,
            updatedAt: '2026-07-12T08:00:00.000Z',
            syncStatus: 'pending'
        }, remote)).toBe(false)
        expect(shouldApplyRemoteItem('products', {
            version: 1,
            updatedAt: '2026-07-12T08:00:00.000Z',
            syncStatus: 'conflict'
        }, remote)).toBe(false)
    })
})

describe('agent deletion ordering', () => {
    it('retires an agent before its business partner when both deletes are queued together', () => {
        const ordered = orderMutationsForSync([
            {
                id: 'a-partner-delete',
                workspaceId: 'workspace-1',
                entityType: 'business_partners',
                entityId: 'partner-1',
                operation: 'delete',
                payload: { id: 'partner-1' },
                createdAt: '2026-08-26T00:00:00.000Z'
            },
            {
                id: 'z-agent-delete',
                workspaceId: 'workspace-1',
                entityType: 'agents',
                entityId: 'agent-1',
                operation: 'delete',
                payload: { id: 'agent-1', businessPartnerId: 'partner-1' },
                createdAt: '2026-08-26T00:00:00.000Z'
            }
        ])

        expect(ordered.map((mutation) => mutation.id)).toEqual([
            'z-agent-delete',
            'a-partner-delete'
        ])
    })
})

describe('tracked commission snapshot ordering', () => {
    it('syncs an offline workspace mode change before its new sales order', () => {
        const ordered = orderMutationsForSync([
            {
                id: 'order-first-in-time',
                workspaceId: 'workspace-1',
                entityType: 'sales_orders',
                entityId: 'order-1',
                operation: 'create',
                payload: {
                    id: 'order-1',
                    workspaceId: 'workspace-1',
                    commissionMode: 'tracked',
                    commissionModeCapturedAt: '2026-09-12T08:00:00.000Z'
                },
                createdAt: '2026-09-12T08:00:00.000Z'
            },
            {
                id: 'workspace-setting',
                workspaceId: 'workspace-1',
                entityType: 'workspaces',
                entityId: 'workspace-1',
                operation: 'update',
                payload: { id: 'workspace-1', sales_agent_commission_mode: 'tracked' },
                createdAt: '2026-09-12T08:00:01.000Z'
            }
        ])

        expect(ordered.map((mutation) => mutation.id)).toEqual([
            'workspace-setting',
            'order-first-in-time'
        ])
    })
})

describe('delivery mutation ordering', () => {
    it('replays a shipment before its event when parallel writes queued the event first', () => {
        const ordered = orderMutationsForSync([
            {
                id: 'shipment-event-mutation',
                workspaceId: 'workspace-1',
                entityType: 'delivery_shipment_events',
                entityId: 'shipment-event-1',
                operation: 'create',
                payload: { id: 'shipment-event-1', shipmentId: 'shipment-1' },
                createdAt: '2026-08-15T10:00:00.000Z'
            },
            {
                id: 'shipment-mutation',
                workspaceId: 'workspace-1',
                entityType: 'delivery_shipments',
                entityId: 'shipment-1',
                operation: 'create',
                payload: { id: 'shipment-1', merchantProfileId: 'merchant-1' },
                createdAt: '2026-08-15T10:00:01.000Z'
            },
            {
                id: 'unrelated-mutation',
                workspaceId: 'workspace-2',
                entityType: 'products',
                entityId: 'product-1',
                operation: 'update',
                payload: { id: 'product-1', name: 'Desk' },
                createdAt: '2026-08-15T10:00:02.000Z'
            }
        ])

        expect(ordered.map((mutation) => mutation.id)).toEqual([
            'shipment-mutation',
            'shipment-event-mutation',
            'unrelated-mutation'
        ])
    })

    it('puts recovered merchant prerequisites before the shipment and its event', () => {
        const ordered = orderMutationsForSync([
            {
                id: 'shipment-event-mutation',
                workspaceId: 'workspace-1',
                entityType: 'delivery_shipment_events',
                entityId: 'shipment-event-1',
                operation: 'create',
                payload: { id: 'shipment-event-1', shipmentId: 'shipment-1' },
                createdAt: '2026-08-15T10:00:00.000Z'
            },
            {
                id: 'shipment-mutation',
                workspaceId: 'workspace-1',
                entityType: 'delivery_shipments',
                entityId: 'shipment-1',
                operation: 'create',
                payload: {
                    id: 'shipment-1',
                    merchantProfileId: 'merchant-profile-1',
                    merchantBusinessPartnerId: 'partner-1'
                },
                createdAt: '2026-08-15T10:00:01.000Z'
            },
            {
                id: 'merchant-profile-mutation',
                workspaceId: 'workspace-1',
                entityType: 'delivery_merchant_profiles',
                entityId: 'merchant-profile-1',
                operation: 'create',
                payload: { id: 'merchant-profile-1', businessPartnerId: 'partner-1' },
                createdAt: '2026-08-15T10:00:02.000Z'
            },
            {
                id: 'partner-mutation',
                workspaceId: 'workspace-1',
                entityType: 'business_partners',
                entityId: 'partner-1',
                operation: 'create',
                payload: { id: 'partner-1' },
                createdAt: '2026-08-15T10:00:03.000Z'
            }
        ])

        expect(ordered.map((mutation) => mutation.id)).toEqual([
            'partner-mutation',
            'merchant-profile-mutation',
            'shipment-mutation',
            'shipment-event-mutation'
        ])
    })

    it('replays the payment transaction before the settlement update that references it', () => {
        const ordered = orderMutationsForSync([
            {
                id: 'settlement-update',
                workspaceId: 'workspace-1',
                entityType: 'delivery_settlements',
                entityId: 'settlement-1',
                operation: 'update',
                payload: { id: 'settlement-1', paymentTransactionId: 'payment-1' },
                createdAt: '2026-08-15T10:00:00.000Z'
            },
            {
                id: 'payment-create',
                workspaceId: 'workspace-1',
                entityType: 'payment_transactions',
                entityId: 'payment-1',
                operation: 'create',
                payload: { id: 'payment-1' },
                createdAt: '2026-08-15T10:00:01.000Z'
            }
        ])

        expect(ordered.map((mutation) => mutation.id)).toEqual([
            'payment-create',
            'settlement-update'
        ])
    })
})

describe('sales-agent commission reconciliation ordering', () => {
    it('closes used plan and membership revisions before inserting replacements', () => {
        const mutations = [
            {
                id: 'new-membership', workspaceId: 'workspace-1', entityType: 'agent_commission_memberships',
                entityId: 'membership-2', operation: 'create',
                payload: { id: 'membership-2', agentId: 'agent-1', planId: 'plan-2' },
                createdAt: '2026-08-24T10:00:00.000Z'
            },
            {
                id: 'new-plan', workspaceId: 'workspace-1', entityType: 'agent_commission_plans',
                entityId: 'plan-2', operation: 'create',
                payload: { id: 'plan-2', level: 'level_1' },
                createdAt: '2026-08-24T10:00:00.000Z'
            },
            {
                id: 'close-membership', workspaceId: 'workspace-1', entityType: 'agent_commission_memberships',
                entityId: 'membership-1', operation: 'update',
                payload: { id: 'membership-1', agentId: 'agent-1', effectiveTo: '2026-08-24T10:00:00.000Z' },
                createdAt: '2026-08-24T10:00:00.000Z'
            },
            {
                id: 'close-plan', workspaceId: 'workspace-1', entityType: 'agent_commission_plans',
                entityId: 'plan-1', operation: 'update',
                payload: { id: 'plan-1', level: 'level_1', effectiveTo: '2026-08-24T10:00:00.000Z' },
                createdAt: '2026-08-24T10:00:00.000Z'
            }
        ]

        const orderedIds = orderMutationsForSync(mutations).map((mutation) => mutation.id)
        expect(orderedIds.indexOf('close-plan')).toBeLessThan(orderedIds.indexOf('new-plan'))
        expect(orderedIds.indexOf('close-membership')).toBeLessThan(orderedIds.indexOf('new-membership'))
        expect(orderedIds.indexOf('new-plan')).toBeLessThan(orderedIds.indexOf('new-membership'))
    })

    it('puts committed order, assignment, membership, plan, and return state before reconciliation', () => {
        const reconciliation = {
            id: 'reconcile',
            workspaceId: 'workspace-1',
            entityType: 'sales_agent_commission_reconciliation',
            entityId: 'order-1',
            operation: 'update',
            payload: {
                orderId: 'order-1',
                assignmentId: 'assignment-1',
                membershipId: 'membership-1',
                planId: 'plan-1',
                orderReturnId: 'return-1'
            },
            createdAt: '2026-08-24T10:00:00.000Z'
        } as const
        const ordered = orderMutationsForSync([
            reconciliation,
            {
                ...reconciliation,
                id: 'return', entityType: 'order_returns', entityId: 'return-1', operation: 'create',
                payload: { id: 'return-1', orderId: 'order-1' }, createdAt: '2026-08-24T10:00:01.000Z'
            },
            {
                ...reconciliation,
                id: 'assignment', entityType: 'sales_order_agent_assignments', entityId: 'assignment-1', operation: 'create',
                payload: { id: 'assignment-1', orderId: 'order-1' }, createdAt: '2026-08-24T10:00:02.000Z'
            },
            {
                ...reconciliation,
                id: 'membership', entityType: 'agent_commission_memberships', entityId: 'membership-1', operation: 'create',
                payload: { id: 'membership-1', planId: 'plan-1' }, createdAt: '2026-08-24T10:00:03.000Z'
            },
            {
                ...reconciliation,
                id: 'plan', entityType: 'agent_commission_plans', entityId: 'plan-1', operation: 'update',
                payload: { id: 'plan-1' }, createdAt: '2026-08-24T10:00:04.000Z'
            },
            {
                ...reconciliation,
                id: 'order', entityType: 'sales_orders', entityId: 'order-1', operation: 'update',
                payload: { id: 'order-1' }, createdAt: '2026-08-24T10:00:05.000Z'
            }
        ])

        expect(ordered.at(-1)?.id).toBe('reconcile')
        expect(new Set(ordered.slice(0, -1).map((mutation) => mutation.id))).toEqual(new Set([
            'return', 'assignment', 'membership', 'plan', 'order'
        ]))
    })
})

describe('fullSync error reporting', () => {
    beforeEach(() => {
        dbMock.reset()
        supabaseMock.reset()
        workspaceModeMock.isLocalWorkspaceMode.mockReset()
        workspaceModeMock.isLocalWorkspaceMode.mockReturnValue(false)
        schemaRoutingMock.getPartnerSyncWriteRpc.mockReset()
        schemaRoutingMock.getPartnerSyncWriteRpc.mockImplementation((tableName: string) => tableName === 'business_partners'
            ? 'sync_business_partner'
            : undefined)
        schemaRoutingMock.getVisibilityScopedTableRpc.mockReset()
        schemaRoutingMock.getVisibilityScopedTableRpc.mockReturnValue(undefined)
    })

    it.each(['inventory', 'stock_batches'])('quarantines legacy %s snapshots instead of replaying them', async (entityType) => {
        dbMock.rows.push({
            id: `${entityType}-mutation`,
            workspaceId: 'workspace-1',
            entityType,
            entityId: `${entityType}-1`,
            operation: 'update',
            createdAt: '2026-09-09T10:00:00.000Z',
            status: 'pending',
            payload: { quantity: -1 },
        })

        const result = await processMutationQueue('user-1')

        expect(result).toMatchObject({ success: 0, failed: 1 })
        expect(dbMock.rows[0]).toMatchObject({ status: 'failed' })
        expect(dbMock.rows[0].error).toEqual(expect.any(String))
        expect(supabaseMock.from).not.toHaveBeenCalled()
        expect(supabaseMock.rpc).not.toHaveBeenCalled()
    })

    it('replays a stock adjustment through the atomic RPC and stores server quantities', async () => {
        supabaseMock.rpc.mockResolvedValueOnce({
            data: {
                transaction: {
                    id: 'adjustment-1', workspace_id: 'workspace-1', product_id: 'product-1',
                    storage_id: 'storage-1', transaction_type: 'stock_adjustment', quantity_delta: 20,
                    previous_quantity: 80, new_quantity: 100, adjustment_reason: 'correction',
                    created_at: '2026-09-09T10:00:00.000Z', updated_at: '2026-09-09T10:00:01.000Z',
                    version: 1, is_deleted: false,
                },
                inventory: { id: 'inventory-1', quantity: 100 },
                already_applied: false,
            },
            error: null,
        })
        dbMock.rows.push({
            id: 'adjustment-mutation', workspaceId: 'workspace-1', entityType: 'inventory_transactions',
            entityId: 'adjustment-1', operation: 'create', createdAt: '2026-09-09T10:00:00.000Z',
            status: 'pending',
            payload: {
                id: 'adjustment-1', workspaceId: 'workspace-1', productId: 'product-1',
                storageId: 'storage-1', transactionType: 'stock_adjustment', quantityDelta: 20,
                previousQuantity: 80, newQuantity: 100, adjustmentReason: 'correction',
            },
        })

        const result = await processMutationQueue('user-1')

        expect(result).toMatchObject({ success: 1, failed: 0, errors: [] })
        expect(supabaseMock.rpc).toHaveBeenCalledWith('apply_stock_adjustment', {
            p_transaction: expect.objectContaining({
                id: 'adjustment-1', transaction_type: 'stock_adjustment', quantity_delta: 20,
            }),
        })
        expect(dbMock.inventoryTransactions.put).toHaveBeenCalledWith(expect.objectContaining({
            id: 'adjustment-1', previousQuantity: 80, newQuantity: 100,
            syncStatus: 'synced',
        }))
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced', error: undefined })
    })

    it('retries a stock adjustment after a transient RPC failure', async () => {
        supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: new Error('network disconnected') })
        dbMock.rows.push({
            id: 'adjustment-mutation', workspaceId: 'workspace-1', entityType: 'inventory_transactions',
            entityId: 'adjustment-1', operation: 'create', createdAt: '2026-09-09T10:00:00.000Z',
            status: 'pending',
            payload: {
                id: 'adjustment-1', workspaceId: 'workspace-1', productId: 'product-1',
                storageId: 'storage-1', transactionType: 'stock_adjustment', quantityDelta: 20,
                previousQuantity: 80, newQuantity: 100, adjustmentReason: 'correction',
            },
        })

        expect(await processMutationQueue('user-1')).toMatchObject({ success: 0, failed: 1 })
        expect(dbMock.rows[0]).toMatchObject({ status: 'failed', error: 'network disconnected' })

        supabaseMock.rpc.mockResolvedValueOnce({
            data: {
                transaction: {
                    id: 'adjustment-1', workspace_id: 'workspace-1', product_id: 'product-1',
                    storage_id: 'storage-1', transaction_type: 'stock_adjustment', quantity_delta: 20,
                    previous_quantity: 80, new_quantity: 100, adjustment_reason: 'correction',
                },
                inventory: { id: 'inventory-1', quantity: 100 },
                already_applied: true,
            },
            error: null,
        })

        expect(await processMutationQueue('user-1')).toMatchObject({ success: 1, failed: 0 })
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced', error: undefined })
        expect(supabaseMock.rpc).toHaveBeenCalledTimes(2)
    })

    it('retires legacy duplicate-candidate mutations without syncing or pulling them', async () => {
        dbMock.rows.push({
            id: 'merge-candidate-mutation',
            workspaceId: 'workspace-1',
            entityType: 'business_partner_merge_candidates',
            entityId: 'merge-candidate-1',
            operation: 'create',
            payload: { id: 'merge-candidate-1' },
            createdAt: '2026-09-05T00:00:00.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result).toMatchObject({ success: true, pushed: 1 })
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced' })
        expect(supabaseMock.from).not.toHaveBeenCalledWith('business_partner_merge_candidates')
    })

    it('replays a queued business partner through its privacy-checked write RPC', async () => {
        dbMock.rows.push({
            id: 'partner-mutation',
            workspaceId: 'workspace-1',
            entityType: 'business_partners',
            entityId: 'partner-1',
            operation: 'update',
            payload: {
                id: 'partner-1',
                workspaceId: 'workspace-1',
                partnerName: 'NameNameName',
                updatedAt: '2026-09-05T18:00:00.000Z'
            },
            createdAt: '2026-09-05T18:00:00.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result).toMatchObject({ success: true, pushed: 1 })
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced' })
        expect(supabaseMock.rpc).toHaveBeenCalledWith('sync_business_partner', expect.objectContaining({
            p_operation: 'upsert',
            p_entity_id: 'partner-1',
            p_workspace_id: 'workspace-1',
            p_payload: expect.objectContaining({ partner_name: 'NameNameName' })
        }))
    })

    it('pulls business partners from the redacted directory RPC instead of the raw table', async () => {
        const rpcBuilder = {
            gt: vi.fn(() => rpcBuilder),
            order: vi.fn(() => rpcBuilder),
            range: vi.fn(async () => ({ data: [], error: null }))
        }
        schemaRoutingMock.getVisibilityScopedTableRpc.mockImplementation((tableName: string) => tableName === 'business_partners'
            ? 'list_visible_business_partners'
            : undefined)
        supabaseMock.rpc.mockImplementation((...args: unknown[]) => args[0] === 'list_visible_business_partners'
            ? rpcBuilder
            : Promise.resolve({ data: null, error: null }))

        await pullChanges('workspace-1', '1970-01-01T00:00:00.000Z')

        expect(supabaseMock.rpc).toHaveBeenCalledWith('list_visible_business_partners', {
            p_workspace_id: 'workspace-1'
        })
        expect(supabaseMock.from).not.toHaveBeenCalledWith('business_partners')
    })

    it('persists large sales pulls in bounded batches and reports row progress', async () => {
        const remoteSales = Array.from({ length: 501 }, (_, index) => ({
            id: `sale-${index}`,
            workspace_id: 'workspace-1',
            updated_at: '2026-09-08T00:00:00.000Z'
        }))
        supabaseMock.setPullRows('sales', remoteSales)
        dbMock.sales.bulkGet.mockImplementation(async (ids: unknown[]) => ids.map((id) => (
            id === 'sale-0' ? { id, syncStatus: 'pending' } : undefined
        )))
        const progress: Array<{
            completed: number
            total: number
            detail?: { table: string; completed: number; total: number }
        }> = []

        const result = await pullChanges(
            'workspace-1',
            '1970-01-01T00:00:00.000Z',
            (completed, total, detail) => progress.push({ completed, total, detail })
        )

        expect(result).toMatchObject({ pulled: 500, errors: [] })
        expect(dbMock.sales.bulkPut).toHaveBeenCalledTimes(3)
        const writtenSales = dbMock.sales.bulkPut.mock.calls.flatMap((call) => call[0])
        expect(writtenSales).toHaveLength(500)
        expect(writtenSales).not.toContainEqual(expect.objectContaining({ id: 'sale-0' }))
        expect(progress).toContainEqual(expect.objectContaining({
            completed: 45,
            total: 94,
            detail: { table: 'sales', completed: 250, total: 501 }
        }))
        expect(progress).toContainEqual(expect.objectContaining({
            completed: 45,
            total: 94,
            detail: { table: 'sales', completed: 501, total: 501 }
        }))
    })

    it('returns a failed result with the mutation error and leaves the queued mutation marked failed', async () => {
        dbMock.rows.push({
            id: 'mutation-1',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-1',
            operation: 'update',
            payload: {
                id: 'product-1',
                name: 'Desk',
                skuKey: 'desk',
                quantity: 510,
                storageId: 'storage-1',
                syncStatus: 'pending',
                lastSyncedAt: null,
                updatedAt: '2026-06-03T00:00:00.000Z'
            },
            createdAt: '2026-06-03T00:00:00.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result).toMatchObject({
            success: false,
            pushed: 0,
            pulled: 0,
            errors: [expect.stringContaining('Sync integrity issue:')]
        })
        expect(dbMock.rows[0]).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('Sync integrity issue:')
        })
        expect(dbMock.offlineMutations.update).toHaveBeenCalledWith('mutation-1', { status: 'syncing' })
        expect(dbMock.offlineMutations.update).toHaveBeenLastCalledWith('mutation-1', expect.objectContaining({
            status: 'failed',
            error: expect.stringContaining('Sync integrity issue:')
        }))

        expect(supabaseMock.upsert).toHaveBeenCalledTimes(1)
        const firstUpsertCall = supabaseMock.upsert.mock.calls[0] as unknown as [Record<string, unknown>]
        const payload = firstUpsertCall[0]
        expect(payload).toMatchObject({
            id: 'product-1',
            name: 'Desk',
            workspace_id: 'workspace-1',
            updated_at: '2026-06-03T00:00:00.000Z'
        })
        expect(payload).not.toHaveProperty('sync_status')
        expect(payload).not.toHaveProperty('last_synced_at')
        expect(payload).not.toHaveProperty('sku_key')
        expect(payload).not.toHaveProperty('quantity')
        expect(payload).not.toHaveProperty('storage_id')
    })

    it('reconciles an order before uploading its commission payout', async () => {
        const events: string[] = []
        supabaseMock.rpc.mockImplementation(async (...rpcArgs: unknown[]) => {
            const [name, rawArgs] = rpcArgs
            const args = rawArgs && typeof rawArgs === 'object'
                ? rawArgs as Record<string, unknown>
                : {}
            events.push(`rpc:${String(name)}:${String(args.p_order_id ?? '')}`)
            return { data: null, error: null }
        })
        supabaseMock.insert.mockImplementation(async () => {
            events.push('insert:payout')
            return { data: null, error: null }
        })
        dbMock.rows.push({
            id: 'commission-payout-mutation',
            workspaceId: 'workspace-1',
            entityType: 'agent_commission_entries',
            entityId: 'commission-payout-1',
            operation: 'create',
            payload: {
                id: 'commission-payout-1',
                orderId: 'sales-order-1',
                assignmentId: 'assignment-1',
                agentId: 'agent-1',
                kind: 'payout',
                status: 'paid',
                amount: -8000,
                currency: 'iqd'
            },
            createdAt: '2026-08-25T12:36:50.058Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(events).toEqual([
            'rpc:reconcile_sales_agent_commission:sales-order-1',
            'insert:payout'
        ])
        expect(supabaseMock.insert).toHaveBeenCalledWith(expect.objectContaining({
            id: 'commission-payout-1',
            order_id: 'sales-order-1',
            assignment_id: 'assignment-1',
            amount: -8000
        }))
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced', error: undefined })
    })

    it('retries and repairs product mutations that previously failed because of sku_key', async () => {
        dbMock.rows.push({
            id: 'sku-key-mutation',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-1',
            operation: 'update',
            payload: {
                id: 'product-1',
                name: 'Desk',
                skuKey: 'desk',
                quantity: 510,
                storageId: 'storage-1'
            },
            createdAt: '2026-07-13T00:00:00.000Z',
            status: 'failed',
            error: "Could not find the 'sku_key' column of 'products' in the schema cache"
        })
        supabaseMock.upsert.mockResolvedValueOnce({ data: null, error: null })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced' })
        const retryUpsertCall = supabaseMock.upsert.mock.calls[0] as unknown as [Record<string, unknown>]
        const payload = retryUpsertCall[0]
        expect(payload).not.toHaveProperty('sku_key')
        expect(payload).not.toHaveProperty('quantity')
        expect(payload).not.toHaveProperty('storage_id')
    })

    it.each(['sales_account', 'order_creator_product'] as const)(
        'adopts the existing server beneficiary for a duplicate %s assignment',
        async (assignmentSource) => {
            const duplicateAssignmentError = Object.assign(
                new Error('duplicate key value violates unique constraint "sales_order_agent_assignments_one_active_agent_idx"'),
                { code: '23505' }
            )
            dbMock.rows.push({
                id: 'duplicate-automatic-assignment',
                workspaceId: 'workspace-1',
                entityType: 'sales_order_agent_assignments',
                entityId: 'assignment-local-duplicate',
                operation: 'create',
                payload: {
                    id: 'assignment-local-duplicate',
                    orderId: 'order-1',
                    agentId: 'agent-1',
                    assignmentSource,
                    assignedAt: '2026-08-29T00:00:00.000Z'
                },
                createdAt: '2026-08-29T00:00:00.000Z',
                status: 'pending'
            })
            supabaseMock.upsert.mockResolvedValueOnce({ data: null, error: duplicateAssignmentError })
            supabaseMock.setActiveSalesOrderAssignment({
                id: 'assignment-server',
                workspace_id: 'workspace-1',
                order_id: 'order-1',
                agent_id: 'agent-1',
                assignment_source: assignmentSource,
                assigned_at: '2026-08-29T00:00:00.000Z',
                unassigned_at: null,
                is_deleted: false,
                version: 1
            })

            const result = await fullSync('user-1', 'workspace-1', null)

            expect(result.success).toBe(true)
            expect(dbMock.rows[0]).toMatchObject({ status: 'synced', error: undefined })
            expect(dbMock.salesOrderAgentAssignments.delete).toHaveBeenCalledWith('assignment-local-duplicate')
            expect(dbMock.salesOrderAgentAssignments.put).toHaveBeenCalledWith(expect.objectContaining({
                id: 'assignment-server',
                workspaceId: 'workspace-1',
                orderId: 'order-1',
                agentId: 'agent-1',
                assignmentSource,
                syncStatus: 'synced'
            }))
        }
    )

    it('keeps an unknown-column mutation, blocks later writes for that record, and syncs unrelated work', async () => {
        const schemaError = Object.assign(
            new Error("Could not find the 'future_flag' column of 'products' in the schema cache"),
            { code: 'PGRST204' }
        )
        supabaseMock.upsert
            .mockResolvedValueOnce({ data: null, error: schemaError })
            .mockResolvedValueOnce({ data: null, error: null })
        dbMock.rows.push({
            id: 'product-schema-mismatch',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-1',
            operation: 'update',
            payload: { id: 'product-1', name: 'Desk', futureFlag: true },
            createdAt: '2026-07-13T00:00:00.000Z',
            status: 'pending'
        }, {
            id: 'product-follow-up',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-1',
            operation: 'update',
            payload: { id: 'product-1', name: 'Desk v2' },
            createdAt: '2026-07-13T00:00:01.000Z',
            status: 'pending'
        }, {
            id: 'independent-category',
            workspaceId: 'workspace-1',
            entityType: 'categories',
            entityId: 'category-1',
            operation: 'create',
            payload: { id: 'category-1', name: 'Office' },
            createdAt: '2026-07-13T00:00:02.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result).toMatchObject({ success: false, pushed: 1, pulled: 0 })
        expect(result.errors).toEqual([
            expect.stringContaining('Schema mismatch: Supabase does not recognize products.future_flag')
        ])
        expect(supabaseMock.upsert).toHaveBeenCalledTimes(2)
        expect(dbMock.rows[0]).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('Schema mismatch:')
        })
        expect(dbMock.rows[1]).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('This later change was blocked to preserve record order.')
        })
        expect(dbMock.rows[2]).toMatchObject({ status: 'synced' })
        expect(dbMock.products.update).toHaveBeenCalledWith('product-1', { syncStatus: 'conflict' })
    })

    it('reports pull failures instead of treating an empty pull as successful', async () => {
        supabaseMock.setPullError(new Error('permission denied by row-level security'))

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(false)
        expect(result.pulled).toBe(0)
        expect(result.errors).toContain('products: permission denied by row-level security')
        expect(result.errors).toContain('workspaces: permission denied by row-level security')
    })

    it('leaves dependent Price Book items pending when their parent book fails', async () => {
        dbMock.rows.push({
            id: 'price-book-mutation',
            workspaceId: 'workspace-1',
            entityType: 'price_books',
            entityId: 'price-book-1',
            operation: 'create',
            payload: { id: 'price-book-1', name: 'Wholesale' },
            createdAt: '2026-06-03T00:00:00.000Z',
            status: 'pending'
        }, {
            id: 'price-book-item-mutation',
            workspaceId: 'workspace-1',
            entityType: 'price_book_items',
            entityId: 'price-book-item-1',
            operation: 'create',
            payload: {
                id: 'price-book-item-1',
                priceBookId: 'price-book-1',
                productId: 'product-1',
                costPrice: 10,
                price: 12,
                currency: 'usd'
            },
            createdAt: '2026-06-03T00:00:01.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(false)
        expect(supabaseMock.upsert).toHaveBeenCalledTimes(1)
        expect(dbMock.rows[0]).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('Sync integrity issue:')
        })
        expect(dbMock.rows[1]).toMatchObject({ status: 'pending' })
    })

    it('replaces the temporary offline sale id display with the server sequence id', async () => {
        supabaseMock.rpc.mockResolvedValueOnce({
            data: {
                sequence_id: 7,
                system_verified: true,
                system_review_status: 'approved',
                system_review_reason: null
            },
            error: null
        })
        dbMock.rows.push({
            id: 'mutation-2',
            workspaceId: 'workspace-1',
            entityType: 'sales',
            entityId: '65cd27b9-0000-4000-8000-000000000000',
            operation: 'create',
            payload: {
                id: '65cd27b9-0000-4000-8000-000000000000',
                total_amount: 1000,
                settlement_currency: 'iqd',
                sales_exchange: [{
                    base_currency: 'usd',
                    quote_currency: 'iqd',
                    base_amount: 100,
                    quote_amount: 145000,
                    source: 'manual',
                    captured_at: '2026-06-03T00:00:00.000Z',
                    rate_side: 'mid',
                    source_price_id: null,
                    source_price_updated_at: null
                }],
                items: []
            },
            createdAt: '2026-06-03T00:00:00.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(supabaseMock.rpc).toHaveBeenCalledWith('complete_sale', {
            payload: expect.objectContaining({
                id: '65cd27b9-0000-4000-8000-000000000000',
                settlement_currency: 'iqd',
                sales_exchange: expect.arrayContaining([
                    expect.objectContaining({
                        base_currency: 'usd',
                        quote_currency: 'iqd',
                        base_amount: 100,
                        quote_amount: 145000
                    })
                ])
            })
        })
        expect(dbMock.sales.update).toHaveBeenCalledWith(
            '65cd27b9-0000-4000-8000-000000000000',
            expect.objectContaining({
                sequenceId: 7,
                syncStatus: 'synced',
                systemVerified: true,
                systemReviewStatus: 'approved'
            })
        )
        expect(dbMock.invoices.update).toHaveBeenCalledWith(
            '65cd27b9-0000-4000-8000-000000000000',
            expect.objectContaining({
                sequenceId: 7,
                invoiceid: '#00007',
                syncStatus: 'synced'
            })
        )
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced' })
    })

    it('replaces an offline order placeholder with the server-assigned workspace number', async () => {
        supabaseMock.orderUpsert.mockReturnValueOnce({
            select: vi.fn(async () => ({
                data: [{ id: 'sales-order-1', order_number: 'SO-2026-00051' }],
                error: null
            }))
        })
        dbMock.rows.push({
            id: 'sales-order-mutation',
            workspaceId: 'workspace-1',
            entityType: 'sales_orders',
            entityId: 'sales-order-1',
            operation: 'create',
            payload: {
                id: 'sales-order-1',
                workspaceId: 'workspace-1',
                orderNumber: 'SO-PENDING-LOCAL',
                version: 1
            },
            createdAt: '2026-08-04T00:00:00.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(dbMock.salesOrders.update).toHaveBeenCalledWith(
            'sales-order-1',
            expect.objectContaining({
                orderNumber: 'SO-2026-00051',
                syncStatus: 'synced'
            })
        )
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced' })
    })

    it('preserves an invoice order link when pushing an offline mutation', async () => {
        supabaseMock.upsert.mockResolvedValueOnce({ data: null, error: null })
        dbMock.rows.push({
            id: 'mutation-invoice-1',
            workspaceId: 'workspace-1',
            entityType: 'invoices',
            entityId: '65cd27b9-0000-4000-8000-000000000001',
            operation: 'create',
            payload: {
                id: '65cd27b9-0000-4000-8000-000000000001',
                workspaceId: 'workspace-1',
                invoiceid: '#00008',
                orderId: '65cd27b9-0000-4000-8000-000000000002',
                totalAmount: 1000,
                settlementCurrency: 'iqd',
                pdfBlobA4: new Blob(['pdf']),
                syncStatus: 'pending',
                lastSyncedAt: null
            },
            createdAt: '2026-06-03T00:00:00.000Z',
            status: 'pending'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(supabaseMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
            id: '65cd27b9-0000-4000-8000-000000000001',
            order_id: '65cd27b9-0000-4000-8000-000000000002'
        }))
        const invoiceUpsertCall = supabaseMock.upsert.mock.calls[0] as unknown as [Record<string, unknown>]
        const invoicePayload = invoiceUpsertCall[0]
        expect(invoicePayload).not.toHaveProperty('pdf_blob_a4')
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced' })
    })

    it('recovers an interrupted sale create using the existing server row sequence id', async () => {
        supabaseMock.rpc.mockResolvedValueOnce({
            data: null,
            error: Object.assign(new Error('duplicate key value'), { code: '23505' })
        })
        supabaseMock.setSaleLookup({
            id: '65cd27b9-0000-4000-8000-000000000000',
            sequence_id: 8,
            system_verified: true,
            system_review_status: 'approved',
            system_review_reason: null
        })
        dbMock.rows.push({
            id: 'mutation-3',
            workspaceId: 'workspace-1',
            entityType: 'sales',
            entityId: '65cd27b9-0000-4000-8000-000000000000',
            operation: 'create',
            payload: {
                id: '65cd27b9-0000-4000-8000-000000000000',
                total_amount: 1000,
                settlement_currency: 'iqd',
                items: []
            },
            createdAt: '2026-06-03T00:00:00.000Z',
            status: 'syncing'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(dbMock.sales.update).toHaveBeenCalledWith(
            '65cd27b9-0000-4000-8000-000000000000',
            expect.objectContaining({
                sequenceId: 8,
                syncStatus: 'synced'
            })
        )
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced', error: undefined })
    })

    it('retries a failed offline sale create instead of leaving the temporary id forever', async () => {
        supabaseMock.rpc.mockResolvedValueOnce({
            data: { sequence_id: 9 },
            error: null
        })
        dbMock.rows.push({
            id: 'mutation-4',
            workspaceId: 'workspace-1',
            entityType: 'sales',
            entityId: '65cd27b9-0000-4000-8000-000000000000',
            operation: 'create',
            payload: {
                id: '65cd27b9-0000-4000-8000-000000000000',
                total_amount: 1000,
                settlement_currency: 'iqd',
                items: []
            },
            createdAt: '2026-06-03T00:00:00.000Z',
            status: 'failed',
            error: 'network timeout'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(dbMock.sales.update).toHaveBeenCalledWith(
            '65cd27b9-0000-4000-8000-000000000000',
            expect.objectContaining({
                sequenceId: 9,
                syncStatus: 'synced'
            })
        )
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced', error: undefined })
    })

    it('retries a fractional sale return with its exact quantity and stable return and line ids', async () => {
        dbMock.rows.push({
            id: 'mutation-return-1',
            workspaceId: 'workspace-1',
            entityType: 'sales',
            entityId: 'sale-1',
            operation: 'update',
            payload: {
                __rpc_action: 'process_sale_return',
                p_return_id: 'return-1',
                p_sale_id: 'sale-1',
                p_items: [{
                    id: 'return-line-1',
                    sale_item_id: 'sale-item-1',
                    quantity: 1.5
                }],
                p_return_reason: 'Damaged',
                p_refund_method: null
            },
            createdAt: '2026-06-03T00:00:00.000Z',
            status: 'failed',
            error: 'network timeout'
        })

        const result = await fullSync('user-1', 'workspace-1', null)

        expect(result.success).toBe(true)
        expect(supabaseMock.rpc).toHaveBeenCalledWith('process_sale_return', {
            p_return_id: 'return-1',
            p_sale_id: 'sale-1',
            p_items: [{
                id: 'return-line-1',
                sale_item_id: 'sale-item-1',
                quantity: 1.5
            }],
            p_return_reason: 'Damaged',
            p_refund_method: null
        })
        expect(dbMock.saleReturns.update).toHaveBeenCalledWith(
            'return-1',
            expect.objectContaining({ syncStatus: 'synced' })
        )
        expect(dbMock.rows[0]).toMatchObject({ status: 'synced' })
    })
})
