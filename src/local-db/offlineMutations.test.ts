import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutationStore = vi.hoisted(() => {
    const rows: Array<Record<string, any>> = []
    const deliveryMerchantProfiles: Array<Record<string, any>> = []
    const businessPartners: Array<Record<string, any>> = []
    const deliveryShipments: Array<Record<string, any>> = []
    const deliveryShipmentEvents: Array<Record<string, any>> = []
    const salesOrders: Array<Record<string, any>> = []
    const agents: Array<Record<string, any>> = []
    const salesOrderAgentAssignments: Array<Record<string, any>> = []

    const table = {
        where: vi.fn((indexName: string) => ({
            equals: vi.fn((key: unknown) => {
                if (indexName === '[entityType+entityId+status]') {
                    return {
                        first: vi.fn(async () => {
                            const [entityType, entityId, status] = key as [string, string, string]
                            return rows.find((row) =>
                                row.entityType === entityType
                                && row.entityId === entityId
                                && row.status === status
                            )
                        })
                    }
                }

                if (indexName === 'status') {
                    return {
                        filter: vi.fn((predicate: (row: Record<string, any>) => boolean) => ({
                            toArray: vi.fn(async () => rows.filter((row) => row.status === key && predicate(row)))
                        }))
                    }
                }

                throw new Error(`Unsupported index: ${indexName}`)
            })
        })),
        add: vi.fn(async (row: Record<string, any>) => {
            rows.push({ ...row })
            return row.id
        }),
        update: vi.fn(async (id: string, patch: Record<string, any>) => {
            const row = rows.find((item) => item.id === id)
            if (!row) return 0

            Object.assign(row, patch)
            return 1
        }),
        delete: vi.fn(async (id: string) => {
            const index = rows.findIndex((row) => row.id === id)
            if (index === -1) return 0

            rows.splice(index, 1)
            return 1
        }),
        bulkUpdate: vi.fn(async (updates: Array<{ key: string, changes: Record<string, any> }>) => {
            for (const { key, changes } of updates) {
                const row = rows.find((item) => item.id === key)
                if (row) Object.assign(row, changes)
            }
            return updates.length
        })
    }

    const merchantProfilesTable = {
        get: vi.fn(async (id: string) => deliveryMerchantProfiles.find((profile) => profile.id === id))
    }

    const businessPartnersTable = {
        get: vi.fn(async (id: string) => businessPartners.find((partner) => partner.id === id))
    }

    const deliveryShipmentsTable = {
        get: vi.fn(async (id: string) => deliveryShipments.find((shipment) => shipment.id === id))
    }

    const deliveryShipmentEventsTable = {
        where: vi.fn((indexName: string) => ({
            equals: vi.fn((key: [string, string]) => {
                if (indexName !== '[workspaceId+shipmentId]') {
                    throw new Error(`Unsupported delivery event index: ${indexName}`)
                }
                return {
                    toArray: vi.fn(async () => deliveryShipmentEvents.filter((event) => (
                        event.workspaceId === key[0] && event.shipmentId === key[1]
                    )))
                }
            })
        }))
    }

    const byIdTable = (rows: Array<Record<string, any>>) => ({
        get: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
        update: vi.fn(async (id: string, patch: Record<string, any>) => {
            const row = rows.find((item) => item.id === id)
            if (!row) return 0

            Object.assign(row, patch)
            return 1
        })
    })
    const salesOrdersTable = byIdTable(salesOrders)
    const agentsTable = byIdTable(agents)
    const salesOrderAgentAssignmentsTable = byIdTable(salesOrderAgentAssignments)

    return {
        rows,
        table,
        deliveryMerchantProfiles,
        businessPartners,
        deliveryShipments,
        deliveryShipmentEvents,
        salesOrders,
        agents,
        salesOrderAgentAssignments,
        merchantProfilesTable,
        businessPartnersTable,
        deliveryShipmentsTable,
        deliveryShipmentEventsTable,
        salesOrdersTable,
        agentsTable,
        salesOrderAgentAssignmentsTable,
        reset() {
            rows.splice(0)
            deliveryMerchantProfiles.splice(0)
            businessPartners.splice(0)
            deliveryShipments.splice(0)
            deliveryShipmentEvents.splice(0)
            salesOrders.splice(0)
            agents.splice(0)
            salesOrderAgentAssignments.splice(0)
            table.where.mockClear()
            table.add.mockClear()
            table.update.mockClear()
            table.delete.mockClear()
            table.bulkUpdate.mockClear()
            merchantProfilesTable.get.mockClear()
            businessPartnersTable.get.mockClear()
            salesOrdersTable.get.mockClear()
            agentsTable.get.mockClear()
            salesOrderAgentAssignmentsTable.get.mockClear()
            salesOrderAgentAssignmentsTable.update.mockClear()
        }
    }
})

const idMock = vi.hoisted(() => {
    let nextId = 0
    const generateId = vi.fn(() => `offline-mutation-${++nextId}`)

    return {
        generateId,
        reset() {
            nextId = 0
            generateId.mockClear()
        }
    }
})

const workspaceModeMock = vi.hoisted(() => ({
    isLocalWorkspaceMode: vi.fn(() => false)
}))

vi.mock('./database', () => ({
    db: {
        offline_mutations: mutationStore.table,
        delivery_merchant_profiles: mutationStore.merchantProfilesTable,
        business_partners: mutationStore.businessPartnersTable,
        delivery_shipments: mutationStore.deliveryShipmentsTable,
        delivery_shipment_events: mutationStore.deliveryShipmentEventsTable,
        sales_orders: mutationStore.salesOrdersTable,
        agents: mutationStore.agentsTable,
        sales_order_agent_assignments: mutationStore.salesOrderAgentAssignmentsTable,
    }
}))

vi.mock('@/lib/utils', () => ({
    generateId: idMock.generateId
}))

vi.mock('@/workspace/workspaceMode', () => ({
    isLocalWorkspaceMode: workspaceModeMock.isLocalWorkspaceMode
}))

import { addToOfflineMutations, retrySchemaMismatchMutations, retrySyncIntegrityMutations } from './offlineMutations'

describe('addToOfflineMutations', () => {
    beforeEach(() => {
        mutationStore.reset()
        idMock.reset()
        workspaceModeMock.isLocalWorkspaceMode.mockReset()
        workspaceModeMock.isLocalWorkspaceMode.mockReturnValue(false)
    })

    it('merges repeated pending updates for the same entity', async () => {
        await addToOfflineMutations(
            'products',
            'product-1',
            'update',
            { name: 'Original', quantity: 1 },
            'workspace-1'
        )

        await addToOfflineMutations(
            'products',
            'product-1',
            'update',
            { quantity: 2, price: 100 },
            'workspace-1'
        )

        expect(mutationStore.rows).toHaveLength(1)
        expect(mutationStore.rows[0]).toMatchObject({
            operation: 'update',
            payload: {
                name: 'Original',
                quantity: 2,
                price: 100
            },
            status: 'pending'
        })
        expect(mutationStore.table.add).toHaveBeenCalledTimes(1)
        expect(mutationStore.table.update).toHaveBeenCalledTimes(1)
    })

    it('keeps an offline create as create when later fields are updated', async () => {
        await addToOfflineMutations(
            'customers',
            'customer-1',
            'create',
            { name: 'Draft customer' },
            'workspace-1'
        )

        await addToOfflineMutations(
            'customers',
            'customer-1',
            'update',
            { phone: '555-0100' },
            'workspace-1'
        )

        expect(mutationStore.rows).toHaveLength(1)
        expect(mutationStore.rows[0]).toMatchObject({
            operation: 'create',
            payload: {
                name: 'Draft customer',
                phone: '555-0100'
            }
        })
    })

    it('drops an offline create when the entity is deleted before sync', async () => {
        await addToOfflineMutations(
            'categories',
            'category-1',
            'create',
            { name: 'Temporary' },
            'workspace-1'
        )

        await addToOfflineMutations(
            'categories',
            'category-1',
            'delete',
            {},
            'workspace-1'
        )

        expect(mutationStore.rows).toHaveLength(0)
        expect(mutationStore.table.delete).toHaveBeenCalledWith('offline-mutation-1')
    })

    it('coalesces a pending update into a delete mutation with entity id in the payload', async () => {
        await addToOfflineMutations(
            'suppliers',
            'supplier-1',
            'update',
            { name: 'Supplier A' },
            'workspace-1'
        )

        await addToOfflineMutations(
            'suppliers',
            'supplier-1',
            'delete',
            { deletedBy: 'user-1' },
            'workspace-1'
        )

        expect(mutationStore.rows).toHaveLength(1)
        expect(mutationStore.rows[0]).toMatchObject({
            operation: 'delete',
            payload: {
                deletedBy: 'user-1',
                id: 'supplier-1'
            }
        })
        expect(mutationStore.table.update).toHaveBeenCalledTimes(1)
    })

    it('does not queue mutations for local-only workspaces', async () => {
        workspaceModeMock.isLocalWorkspaceMode.mockReturnValue(true)

        await addToOfflineMutations(
            'products',
            'product-1',
            'update',
            { name: 'Local product' },
            'local-workspace-1'
        )

        expect(mutationStore.rows).toHaveLength(0)
        expect(mutationStore.table.add).not.toHaveBeenCalled()
    })

    it('queues only stock-adjustment inventory transactions', async () => {
        await addToOfflineMutations(
            'inventory_transactions',
            'transfer-transaction',
            'create',
            { transactionType: 'transfer_out' },
            'workspace-1'
        )
        await addToOfflineMutations(
            'inventory_transactions',
            'stock-adjustment-transaction',
            'create',
            { transactionType: 'stock_adjustment' },
            'workspace-1'
        )
        await addToOfflineMutations(
            'inventory_transactions',
            'sale-transaction',
            'create',
            { transactionType: 'sale' },
            'workspace-1'
        )
        await addToOfflineMutations(
            'inventory_transactions',
            'purchase-transaction',
            'create',
            { transactionType: 'purchase' },
            'workspace-1'
        )

        expect(mutationStore.rows).toHaveLength(1)
        expect(mutationStore.rows[0]).toMatchObject({
            entityType: 'inventory_transactions',
            entityId: 'stock-adjustment-transaction',
            operation: 'create'
        })
    })

    it('requeues schema mismatches only after an explicit retry request', async () => {
        mutationStore.rows.push({
            id: 'schema-mismatch',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-1',
            operation: 'update',
            payload: { id: 'product-1', futureFlag: true },
            createdAt: '2026-07-13T00:00:00.000Z',
            status: 'failed',
            error: 'Schema mismatch: Supabase does not recognize products.future_flag.'
        }, {
            id: 'permission-failure',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-2',
            operation: 'update',
            payload: { id: 'product-2' },
            createdAt: '2026-07-13T00:00:00.000Z',
            status: 'failed',
            error: 'permission denied'
        })

        await expect(retrySchemaMismatchMutations('workspace-1')).resolves.toBe(1)

        expect(mutationStore.rows[0]).toMatchObject({ status: 'pending', error: undefined })
        expect(mutationStore.rows[1]).toMatchObject({ status: 'failed', error: 'permission denied' })
    })

    it('requeues all deterministic integrity failures only after an explicit retry request', async () => {
        mutationStore.rows.push({
            id: 'permission-failure',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-1',
            operation: 'update',
            payload: { id: 'product-1' },
            createdAt: '2026-07-13T00:00:00.000Z',
            status: 'failed',
            error: 'permission denied for table products'
        }, {
            id: 'validation-failure',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-2',
            operation: 'update',
            payload: { id: 'product-2' },
            createdAt: '2026-07-13T00:00:00.000Z',
            status: 'failed',
            error: 'violates check constraint "inventory_quantity_check"'
        }, {
            id: 'network-failure',
            workspaceId: 'workspace-1',
            entityType: 'products',
            entityId: 'product-3',
            operation: 'update',
            payload: { id: 'product-3' },
            createdAt: '2026-07-13T00:00:00.000Z',
            status: 'failed',
            error: 'network timeout'
        })

        await expect(retrySyncIntegrityMutations('workspace-1')).resolves.toBe(2)

        expect(mutationStore.rows[0]).toMatchObject({ status: 'pending', error: undefined })
        expect(mutationStore.rows[1]).toMatchObject({ status: 'pending', error: undefined })
        expect(mutationStore.rows[2]).toMatchObject({ status: 'failed', error: 'network timeout' })
    })

    it('repairs an assignment mutation from its valid local order before retrying it', async () => {
        mutationStore.salesOrders.push({
            id: 'order-1', workspaceId: 'workspace-correct', isDeleted: false
        })
        mutationStore.agents.push({
            id: 'agent-1', workspaceId: 'workspace-correct', isDeleted: false
        })
        mutationStore.salesOrderAgentAssignments.push({
            id: 'assignment-1', workspaceId: 'workspace-stale', orderId: 'order-1',
            agentId: 'agent-1', isDeleted: false, syncStatus: 'conflict', lastSyncedAt: '2026-09-01T00:00:00.000Z'
        })
        mutationStore.rows.push({
            id: 'assignment-failure', workspaceId: 'workspace-stale',
            entityType: 'sales_order_agent_assignments', entityId: 'assignment-1', operation: 'create',
            payload: { id: 'assignment-1', workspace_id: 'workspace-stale', order_id: 'order-1', agent_id: 'agent-1' },
            createdAt: '2026-09-12T00:00:00.000Z', status: 'failed',
            error: 'Sync integrity issue: Sales order must belong to the assignment workspace'
        })

        await expect(retrySyncIntegrityMutations('workspace-stale')).resolves.toBe(1)

        expect(mutationStore.rows[0]).toMatchObject({
            workspaceId: 'workspace-correct', status: 'pending', error: undefined,
            payload: {
                workspaceId: 'workspace-correct', workspace_id: 'workspace-correct',
                orderId: 'order-1', order_id: 'order-1', agentId: 'agent-1', agent_id: 'agent-1'
            }
        })
        expect(mutationStore.salesOrderAgentAssignments[0]).toMatchObject({
            workspaceId: 'workspace-correct', syncStatus: 'pending', lastSyncedAt: null
        })
    })

    it('does not rewrite an assignment when its local agent is from another workspace', async () => {
        mutationStore.salesOrders.push({
            id: 'order-1', workspaceId: 'workspace-correct', isDeleted: false
        })
        mutationStore.agents.push({
            id: 'agent-1', workspaceId: 'workspace-other', isDeleted: false
        })
        mutationStore.rows.push({
            id: 'assignment-failure', workspaceId: 'workspace-stale',
            entityType: 'sales_order_agent_assignments', entityId: 'assignment-1', operation: 'create',
            payload: { orderId: 'order-1', agentId: 'agent-1' },
            createdAt: '2026-09-12T00:00:00.000Z', status: 'failed',
            error: 'Sync integrity issue: Sales order must belong to the assignment workspace'
        })

        await expect(retrySyncIntegrityMutations('workspace-stale')).resolves.toBe(0)

        expect(mutationStore.rows[0]).toMatchObject({
            workspaceId: 'workspace-stale', status: 'failed',
            payload: { orderId: 'order-1', agentId: 'agent-1' }
        })
    })

    it('requeues the local merchant profile before retrying a failed shipment', async () => {
        mutationStore.deliveryMerchantProfiles.push({
            id: 'merchant-profile-1',
            workspaceId: 'workspace-1',
            businessPartnerId: 'partner-1',
            version: 1,
            isDeleted: false
        })
        mutationStore.businessPartners.push({
            id: 'partner-1',
            workspaceId: 'workspace-1',
            version: 1,
            isDeleted: false
        })
        mutationStore.rows.push({
            id: 'shipment-failure',
            workspaceId: 'workspace-1',
            entityType: 'delivery_shipments',
            entityId: 'shipment-1',
            operation: 'create',
            payload: {
                id: 'shipment-1',
                merchantProfileId: 'merchant-profile-1',
                merchantBusinessPartnerId: 'partner-1'
            },
            createdAt: '2026-08-15T00:00:00.000Z',
            status: 'failed',
            error: 'Sync integrity issue: Shipment links must belong to the same workspace'
        })

        await expect(retrySyncIntegrityMutations('workspace-1')).resolves.toBe(1)

        expect(mutationStore.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                entityType: 'delivery_merchant_profiles',
                entityId: 'merchant-profile-1',
                operation: 'create',
                status: 'pending'
            }),
            expect.objectContaining({
                entityType: 'business_partners',
                entityId: 'partner-1',
                operation: 'create',
                status: 'pending'
            })
        ]))
        expect(mutationStore.rows[0]).toMatchObject({ status: 'pending', error: undefined })
    })

    it('queues postponed voice cleanup after retrying a failed redispatch', async () => {
        mutationStore.deliveryShipments.push({
            id: 'shipment-voice-1', workspaceId: 'workspace-1', status: 'assigned', isDeleted: false
        })
        mutationStore.deliveryShipmentEvents.push({
            id: 'postponed-event-1', workspaceId: 'workspace-1', shipmentId: 'shipment-voice-1',
            status: 'postponed', isDeleted: false,
            voiceReasonPath: 'workspace-1/shipment-voice-1/postponed/reason.flac'
        })
        mutationStore.rows.push({
            id: 'shipment-voice-failure', workspaceId: 'workspace-1', entityType: 'delivery_shipments',
            entityId: 'shipment-voice-1', operation: 'update', payload: { status: 'assigned' },
            createdAt: '2026-08-25T00:00:00.000Z', status: 'failed',
            error: 'Sync integrity issue: Direct deletion from storage tables is not allowed. Use the Storage API instead.'
        })

        await expect(retrySyncIntegrityMutations('workspace-1')).resolves.toBe(1)

        expect(mutationStore.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                entityType: 'delivery_voice_cleanup',
                entityId: 'shipment-voice-1',
                operation: 'delete',
                payload: {
                    shipmentId: 'shipment-voice-1',
                    eventIds: ['postponed-event-1'],
                    paths: ['workspace-1/shipment-voice-1/postponed/reason.flac']
                },
                status: 'pending'
            })
        ]))
    })
})
