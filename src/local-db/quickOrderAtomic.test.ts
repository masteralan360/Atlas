import { queryClient } from '@/query/queryClient'
import 'fake-indexeddb/auto'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const browser = vi.hoisted(() => {
    const rows = new Map<string, string>()
    const storage = {
        get length() {
            return rows.size
        },
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
        clear: () => rows.clear(),
        key: (index: number) => Array.from(rows.keys())[index] ?? null
    }

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'http://localhost', hash: '', pathname: '/' }
    })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
    Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: () => undefined })
    Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value: () => undefined })
    Object.defineProperty(globalThis, 'dispatchEvent', { configurable: true, value: () => true })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr', style: {} },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({
                type: '',
                style: {},
                appendChild: () => undefined,
                setAttribute: () => undefined
            }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: true, userAgent: 'vitest' }
    })
    Object.defineProperty(globalThis, 'Element', {
        configurable: true,
        value: class Element {
            matches() { return false }
        }
    })
    Object.defineProperty(globalThis, 'DOMMatrix', {
        configurable: true,
        value: class DOMMatrix {}
    })
    Object.defineProperty(globalThis, 'ImageData', {
        configurable: true,
        value: class ImageData {}
    })
    Object.defineProperty(globalThis, 'Path2D', {
        configurable: true,
        value: class Path2D {}
    })
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
        configurable: true,
        value: () => 'blob:test'
    })

    return { storage }
})

const supabaseMock = vi.hoisted(() => {
    const rpc = vi.fn()
    const minimumPrices = vi.fn<(...args: unknown[]) => Promise<{ data: unknown[]; error: unknown }>>(async () => ({ data: [], error: null }))
    const upsert = vi.fn((payload: unknown) => {
        const rows = Array.isArray(payload) ? payload : [payload]
        const response = { data: [], error: null }
        return {
            select: async () => ({
                data: rows.map((row) => ({
                    id: (row as { id?: string }).id,
                    order_number: 'SO-2026-00999'
                })),
                error: null
            }),
            then: <TResult1 = typeof response, TResult2 = never>(
                onfulfilled?: ((value: typeof response) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
            ) => Promise.resolve(response).then(onfulfilled, onrejected)
        }
    })
    const insert = vi.fn(async () => ({ data: [], error: null }))
    const createSelectQuery = (data: unknown[] = []) => {
        const response = { data, error: null }
        const query = {
            eq: () => query,
            order: () => query,
            range: () => query,
            then: <TResult1 = typeof response, TResult2 = never>(
                onfulfilled?: ((value: typeof response) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
            ) => Promise.resolve(response).then(onfulfilled, onrejected)
        }
        return query
    }
    const select = vi.fn(() => createSelectQuery())
    const from = vi.fn(() => ({ upsert, insert, select }))
    return { rpc, minimumPrices, upsert, insert, createSelectQuery, select, from }
})

vi.mock('@/auth/supabase', () => {
    const rpc = (name: string, args: Record<string, unknown>) => name === 'validate_staff_minimum_selling_prices'
        ? supabaseMock.minimumPrices(name, args)
        : supabaseMock.rpc(name, args)
    return {
        supabase: {
            rpc,
            from: supabaseMock.from,
            schema: () => ({ from: supabaseMock.from, rpc })
        }
    }
})

vi.mock('@/lib/supabaseRequest', () => ({
    isRetriableWebRequestError: () => false,
    normalizeSupabaseActionError: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    runSupabaseAction: async (_label: string, action: () => PromiseLike<unknown>) => action()
}))

import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { SERVICES_VIRTUAL_STORAGE_ID } from '@/lib/catalogItem'
import { toSnakeCase } from '@/lib/utils'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import { createCompletedSalesOrder, createQuickSalesOrder, createSalesOrder, recalculateCustomerSummary, updateSalesOrder } from './orders'
import { recalculateBusinessPartnerSummary } from './businessPartners'
import { processPartnerSummaryJobs, type PartnerSummaryTarget } from './partnerSummaryJobs'
import { assertOrderFinancialEffects } from '@/dev/testing/assertions/orderEffects'
import { initialPaymentRegression } from '@/dev/testing/salesOrderResilience/scenarios/regressionScenarios'
import { createPosServiceNameMetadata } from '@/lib/posServiceName'
import type { CrudTraceHandle } from '@/dev/crud-debugger/trace'

async function seedLegacySummaryJobs(targets: PartnerSummaryTarget[]) {
    await db.partner_summary_jobs.bulkPut(targets.map(target => ({...target,
        id:JSON.stringify([target.workspaceId,target.table,target.entityId]),revision:crypto.randomUUID()})))
}

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001'
const USER_ID = '10000000-0000-4000-8000-000000000002'
const PARTNER_ID = '10000000-0000-4000-8000-000000000003'
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000004'
const PRODUCT_ID = '10000000-0000-4000-8000-000000000005'
const SERVICE_ID = '10000000-0000-4000-8000-000000000008'
const STORAGE_ID = '10000000-0000-4000-8000-000000000006'
const INVENTORY_ID = '10000000-0000-4000-8000-000000000007'
const SECOND_STORAGE_ID = '10000000-0000-4000-8000-000000000010'
const SECOND_INVENTORY_ID = '10000000-0000-4000-8000-000000000011'
const PAYMENT_ACCOUNT_ID = '10000000-0000-4000-8000-000000000009'

type SalesOrderCreateInput = Parameters<typeof createCompletedSalesOrder>[1]

function baseEntity(id: string) {
    return {
        id,
        workspaceId: WORKSPACE_ID,
        createdAt: '2026-08-31T08:00:00.000Z',
        updatedAt: '2026-08-31T08:00:00.000Z',
        syncStatus: 'synced' as const,
        lastSyncedAt: '2026-08-31T08:00:00.000Z',
        version: 1,
        isDeleted: false
    }
}

function deferredSummaryWrites() {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    supabaseMock.rpc.mockImplementation(async (name: string, args: Record<string, any>) => {
        if (name === 'sync_customer' || name === 'sync_business_partner') await gate
        return successfulInitialOrderResponse(name, args)
    })
    return release
}

function successfulInitialOrderResponse(name: string, args: Record<string, any>) {
    return { data: name === 'create_sales_order_with_initial_payment' ? {
        order: { ...args.p_order, order_number: 'SO-2026-00999' },
        payment: { ...args.p_transaction, reference_label: 'SO-2026-00999' }
    } : null, error: null }
}

async function finishSummaryRefresh(customerId = CUSTOMER_ID, partnerId = PARTNER_ID) {
    await processPartnerSummaryJobs(WORKSPACE_ID)
    // Join both queues so background work cannot leak into the next fixture.
    await Promise.all([
        recalculateCustomerSummary(WORKSPACE_ID, customerId),
        recalculateBusinessPartnerSummary(WORKSPACE_ID, partnerId)
    ])
}

function quickOrderInput(paidAmount = 100): SalesOrderCreateInput {
    return {
        businessPartnerId: PARTNER_ID,
        customerId: CUSTOMER_ID,
        customerName: 'Fast Checkout Customer',
        salesAccountAgentId: null,
        commissionEnabled: false,
        sourceStorageId: STORAGE_ID,
        items: [{
            id: crypto.randomUUID(),
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            productName: 'Fast Checkout Product',
            productSku: 'FAST-001',
            unit: 'pcs',
            quantity: 1,
            lineTotal: 100,
            originalCurrency: 'usd',
            originalUnitPrice: 100,
            convertedUnitPrice: 100,
            settlementCurrency: 'usd',
            costPrice: 40,
            convertedCostPrice: 40,
            batchAllocations: null
        }],
        subtotal: 100,
        discount: 0,
        tax: 0,
        total: 100,
        currency: 'usd',
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        exchangeRates: null,
        status: 'draft',
        approvalStatus: null,
        approvalRequestedBy: null,
        approvalRequestedAt: null,
        approvalReviewedBy: null,
        approvalReviewedAt: null,
        expectedDeliveryDate: null,
        actualDeliveryDate: null,
        isPaid: true,
        paymentStatus: 'paid',
        paidAmount,
        balanceAmount: 0,
        paidAt: '2026-08-31T09:00:00.000Z',
        paymentMethod: 'cash',
        initialPaymentAmount: 0,
        initialPaymentAccountId: null,
        initialPaymentAccountNameSnapshot: null,
        linkedLoanId: null,
        isInstallmentBased: false,
        installmentCount: 0,
        installmentFrequency: null,
        firstDueDate: null,
        nextDueDate: null,
        reservedAt: null,
        shippingAddress: '',
        notes: '',
        isLocked: false,
        sourceChannel: 'manual',
        marketplaceOrderId: null,
        createdBy: USER_ID
    }
}

function unpaidQuickOrderInput(status: 'draft' | 'pending' | 'completed'): SalesOrderCreateInput {
    const input = quickOrderInput()
    return {
        ...input,
        status,
        isPaid: false,
        paymentStatus: 'unpaid',
        paidAmount: 0,
        balanceAmount: input.total,
        paidAt: null
    }
}

function serviceQuickOrderInput(): SalesOrderCreateInput {
    const input = quickOrderInput()
    return {
        ...input,
        sourceStorageId: null,
        items: [{
            ...input.items[0],
            id: crypto.randomUUID(),
            productId: SERVICE_ID,
            storageId: SERVICES_VIRTUAL_STORAGE_ID,
            productName: 'Fast Checkout Service - NewService',
            metadata: createPosServiceNameMetadata('Fast Checkout Service', 'NewService'),
            productSku: '',
            unit: 'service',
            costPrice: 0,
            convertedCostPrice: 0
        }]
    }
}

function freeOnlyQuickOrderInput(freeBonusQuantity = 1): SalesOrderCreateInput {
    const input = quickOrderInput(0)
    return {
        ...input,
        status: 'completed',
        items: [{
            ...input.items[0],
            id: crypto.randomUUID(),
            quantity: 0,
            freeBonusQuantity,
            lineTotal: 0
        }],
        subtotal: 0,
        total: 0,
        isPaid: true,
        paymentStatus: 'paid',
        paidAmount: 0,
        balanceAmount: 0,
        paidAt: '2026-08-31T09:00:00.000Z'
    }
}

function installSuccessfulRpcResponse(inventoryQuantity = 4) {
    supabaseMock.rpc.mockImplementationOnce(async (_name: string, args: { payload: any }) => {
        const orderPayload = args.payload.order
        const paymentPayload = args.payload.payment
        const completedAt = '2026-08-31T09:00:01.000Z'
        return {
            data: {
                order: {
                    ...orderPayload,
                    order_number: 'SO-2026-00999',
                    status: 'completed',
                    actual_delivery_date: completedAt,
                    reserved_at: completedAt,
                    items: orderPayload.items.map((item: Record<string, unknown>) => ({
                        ...item,
                        reservedQuantity: item.inventoryQuantity ?? item.quantity,
                        fulfilledQuantity: item.inventoryQuantity ?? item.quantity,
                        batchAllocations: null
                    })),
                    updated_at: completedAt,
                    sync_status: 'synced'
                },
                payment: {
                    ...paymentPayload,
                    workspace_id: WORKSPACE_ID,
                    source_module: 'orders',
                    source_type: 'sales_order',
                    source_subrecord_id: null,
                    payment_method: 'cash',
                    paid_at: completedAt,
                    counterparty_name: 'Fast Checkout Customer',
                    reference_label: 'SO-2026-00999',
                    note: null,
                    created_by: USER_ID,
                    reversal_of_transaction_id: null,
                    metadata: { orderStatus: 'completed' },
                    created_at: completedAt,
                    updated_at: completedAt,
                    version: 1,
                    is_deleted: false
                },
                inventory: [{
                    id: INVENTORY_ID,
                    workspace_id: WORKSPACE_ID,
                    product_id: PRODUCT_ID,
                    storage_id: STORAGE_ID,
                    quantity: inventoryQuantity,
                    created_at: '2026-08-31T08:00:00.000Z',
                    updated_at: completedAt,
                    version: 2,
                    is_deleted: false
                }],
                stock_batches: [],
                replayed: false
            },
            error: null
        }
    })
}

function installSuccessfulServiceRpcResponse() {
    supabaseMock.rpc.mockImplementationOnce(async (_name: string, args: { payload: any }) => {
        const orderPayload = args.payload.order
        const paymentPayload = args.payload.payment
        const completedAt = '2026-08-31T09:00:01.000Z'
        return {
            data: {
                order: {
                    ...orderPayload,
                    order_number: 'SO-2026-01000',
                    status: 'completed',
                    actual_delivery_date: completedAt,
                    reserved_at: completedAt,
                    updated_at: completedAt,
                    sync_status: 'synced'
                },
                payment: {
                    ...paymentPayload,
                    workspace_id: WORKSPACE_ID,
                    source_module: 'orders',
                    source_type: 'sales_order',
                    source_subrecord_id: null,
                    payment_method: 'cash',
                    paid_at: completedAt,
                    counterparty_name: 'Fast Checkout Customer',
                    reference_label: 'SO-2026-01000',
                    note: null,
                    created_by: USER_ID,
                    reversal_of_transaction_id: null,
                    metadata: { orderStatus: 'completed' },
                    created_at: completedAt,
                    updated_at: completedAt,
                    version: 1,
                    is_deleted: false
                },
                inventory: [],
                stock_batches: [],
                replayed: false
            },
            error: null
        }
    })
}

describe('atomic POS Quick Order completion', () => {
    beforeAll(async () => {
        await db.open()
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        browser.storage.clear()
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        setNetworkStatus(true)
        setActiveBusinessWorkspace(WORKSPACE_ID)
        setActiveBusinessUser(USER_ID, 'admin', WORKSPACE_ID)
        vi.clearAllMocks()
        supabaseMock.minimumPrices.mockReset().mockResolvedValue({ data: [], error: null })
        supabaseMock.rpc.mockReset().mockImplementation(async (name, args) => successfulInitialOrderResponse(name, args))

        await db.users.put({
            ...baseEntity(USER_ID), email: 'quick-order@example.test', name: 'Quick Order test admin', role: 'admin'
        })
        await db.profiles.put({
            id: USER_ID, workspaceId: WORKSPACE_ID, currentWorkspaceId: WORKSPACE_ID,
            name: 'Quick Order test admin', role: 'admin'
        })

        await db.business_partners.put({
            ...baseEntity(PARTNER_ID),
            partnerName: 'Fast Checkout Customer',
            phone: '07500000000',
            defaultCurrency: 'usd',
            role: 'customer',
            customerFacetId: CUSTOMER_ID,
            mergedIntoBusinessPartnerId: null,
            totalSalesOrders: 0,
            totalSalesValue: 0,
            receivableBalance: 0,
            totalPurchaseOrders: 0,
            totalPurchaseValue: 0,
            payableBalance: 0,
            totalLoanCount: 0,
            loanOutstandingBalance: 0,
            netExposure: 0
        } as never)
        await db.customers.put({
            ...baseEntity(CUSTOMER_ID),
            businessPartnerId: PARTNER_ID,
            partnerName: 'Fast Checkout Customer',
            phone: '07500000000',
            defaultCurrency: 'usd',
            totalOrders: 0,
            totalSpent: 0,
            outstandingBalance: 0
        } as never)
        await db.products.put({
            ...baseEntity(PRODUCT_ID),
            sku: 'FAST-001',
            name: 'Fast Checkout Product',
            unit: 'pcs',
            currency: 'usd',
            price: 100,
            costPrice: 40,
            quantity: 5,
            minStockLevel: 0,
            storageId: STORAGE_ID,
            isService: false
        } as never)
        await db.inventory.put({
            ...baseEntity(INVENTORY_ID),
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            quantity: 5
        })
    })

    afterAll(async () => {
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        await db.delete()
    })

    describe('sales order form summary refresh', () => {
        for (const dataMode of ['cloud', 'hybrid'] as const) {
            for (const paymentMethod of ['cash', 'loan'] as const) {
                it(`${dataMode}: creates a ${paymentMethod} draft without waiting for catalog or payment-reference reads`, async () => {
                    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode })
                    const input = { ...unpaidQuickOrderInput('draft'), paymentMethod }
                    const stages: string[] = []
                    const trace: CrudTraceHandle = {
                        id: 'draft-creation-performance',
                        setEntityId: () => undefined, setWorkspaceMode: () => undefined, addPendingStage: () => undefined,
                        measure: async (label, _layer, work) => { stages.push(label); return work() }
                    }
                    const catalogRead = vi.spyOn(db.products, 'bulkGet').mockRejectedValue(new Error('Unrelated catalog hydration is blocked'))
                    try {
                        const order = await createSalesOrder(WORKSPACE_ID, input, USER_ID, {
                            requireRemoteConfirmation: true, deferSummaryRefresh: true, trace,
                            minimumPriceValidationItems: [{ productId: PRODUCT_ID, effectiveSellingPrice: 100, currency: 'usd' }]
                        })
                        expect(order).toMatchObject({ status: 'draft', paymentMethod, orderNumber: 'SO-2026-00999', syncStatus: 'synced' })
                        expect(catalogRead).not.toHaveBeenCalled()
                        expect(stages).toContain('crudDebugger.stages.salesOrderMinimumPrices')
                        expect(stages).not.toContain('crudDebugger.stages.salesOrderProductCosts')
                        expect(stages).not.toContain('crudDebugger.stages.salesOrderPaymentReferences')
                        expect(supabaseMock.minimumPrices).toHaveBeenCalledWith('validate_staff_minimum_selling_prices', expect.objectContaining({
                            p_workspace_id: WORKSPACE_ID,
                            p_items: [expect.objectContaining({ product_id: PRODUCT_ID, effective_selling_price: 100 })]
                        }))
                        expect(await db.payment_transactions.count()).toBe(0)
                    } finally {
                        catalogRead.mockRestore()
                        await finishSummaryRefresh()
                    }
                })
            }

            it(`${dataMode}: still rejects a server minimum-price violation before saving the order`, async () => {
                writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode })
                supabaseMock.minimumPrices.mockResolvedValueOnce({ data: [{
                    line_index: 0, product_id: PRODUCT_ID, product_name: 'Fast Checkout Product', minimum_selling_price: 120
                }], error: null })
                await expect(createSalesOrder(WORKSPACE_ID, unpaidQuickOrderInput('draft'), USER_ID, {
                    requireRemoteConfirmation: true,
                    minimumPriceValidationItems: [{ productId: PRODUCT_ID, effectiveSellingPrice: 100, currency: 'usd' }]
                })).rejects.toMatchObject({ name: 'MinimumSellingPriceViolationError' })
                expect(await db.sales_orders.count()).toBe(0)
                expect(supabaseMock.upsert).not.toHaveBeenCalled()
                expect(await db.payment_transactions.count()).toBe(0)
            })

            for (const paid of [false, true]) {
                it(`${dataMode}: a server cost rejection cannot confirm a ${paid ? 'paid' : 'unpaid'} draft`, async () => {
                    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode })
                    const rejection = new Error('Fast Checkout Product cannot be sold until a cost is added.')
                    if (paid) supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: rejection })
                    else supabaseMock.upsert.mockImplementationOnce(() => ({
                        select: async () => ({ data: null, error: rejection })
                    }) as unknown as ReturnType<typeof supabaseMock.upsert>)
                    const progress = vi.fn()
                    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
                    try {
                        await expect(createSalesOrder(WORKSPACE_ID, paid ? quickOrderInput() : unpaidQuickOrderInput('draft'), USER_ID, {
                            requireRemoteConfirmation: true, deferSummaryRefresh: true, onProgress: progress,
                            minimumPriceValidationItems: [{ productId: PRODUCT_ID, effectiveSellingPrice: 100, currency: 'usd' }]
                        })).rejects.toThrow('remote_order_save_confirmation_failed')
                        expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ stageKey: 'orders.form.saveProgressComplete' }))
                        expect((await db.sales_orders.toArray()).every((order) => order.syncStatus !== 'synced')).toBe(true)
                        expect(await db.payment_transactions.count()).toBe(0)
                        expect(await db.payment_account_movements.count()).toBe(0)
                        expect(await db.partner_summary_jobs.count()).toBe(0)
                    } finally { log.mockRestore() }
                })
            }
        }

        it.each([
            { dataMode: 'local' as const, online: true, requireRemoteConfirmation: true },
            { dataMode: 'cloud' as const, online: false, requireRemoteConfirmation: true },
            { dataMode: 'cloud' as const, online: true, requireRemoteConfirmation: false }
        ])('keeps local cost validation for $dataMode / online=$online / confirmed=$requireRemoteConfirmation', async ({ dataMode, online, requireRemoteConfirmation }) => {
            writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode })
            setNetworkStatus(online)
            await db.products.update(PRODUCT_ID, { costPrice: null })
            await expect(createSalesOrder(WORKSPACE_ID, unpaidQuickOrderInput('draft'), USER_ID, {
                requireRemoteConfirmation,
                minimumPriceValidationItems: [{ productId: PRODUCT_ID, effectiveSellingPrice: 100, currency: 'usd' }]
            })).rejects.toThrow('cannot be sold until a cost is added')
            expect(await db.sales_orders.count()).toBe(0)
            expect(supabaseMock.upsert).not.toHaveBeenCalled()
            expect(await db.payment_transactions.count()).toBe(0)
        })

        it('checks only this order\'s Price Book items through their compound index', async () => {
            writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
            const priceBookId = crypto.randomUUID()
            await db.price_books.put({ ...baseEntity(priceBookId), name: 'Large customer price book' })
            await db.business_partners.update(PARTNER_ID, { priceBookId })
            await db.price_book_items.bulkPut([
                { ...baseEntity('relevant-book-item'), priceBookId, productId: PRODUCT_ID, costPrice: 40, price: 100, currency: 'usd' },
                ...Array.from({ length: 1_000 }, (_, index) => ({
                    ...baseEntity(`unrelated-book-item-${index}`), priceBookId, productId: `unrelated-product-${index}`,
                    costPrice: null, price: 1, currency: 'usd' as const
                }))
            ])
            const bookReads = vi.spyOn(db.price_book_items, 'where')
            try {
                const order = await createSalesOrder(WORKSPACE_ID, unpaidQuickOrderInput('draft'), USER_ID)
                expect(order.status).toBe('draft')
                expect(bookReads).toHaveBeenCalledWith('[priceBookId+productId]')
                expect(bookReads).not.toHaveBeenCalledWith('priceBookId')
                await db.price_book_items.update('relevant-book-item', { costPrice: null })
                await expect(createSalesOrder(WORKSPACE_ID, unpaidQuickOrderInput('draft'), USER_ID))
                    .rejects.toThrow('Price Book cost is added')
            } finally { bookReads.mockRestore() }
        })

        it('batches fallback minimum-price product reads and preserves repeated line validation', async () => {
            const input = unpaidQuickOrderInput('draft')
            input.items = Array.from({ length: 20 }, () => ({ ...input.items[0], id: crypto.randomUUID() }))
            input.subtotal = input.total = input.balanceAmount = 2_000
            const individualRead = vi.spyOn(db.products, 'get')
            const batchRead = vi.spyOn(db.products, 'bulkGet')
            try {
                await createSalesOrder(WORKSPACE_ID, input, USER_ID, { requireRemoteConfirmation: true, deferSummaryRefresh: true })
                expect(individualRead).not.toHaveBeenCalled()
                expect(batchRead).toHaveBeenCalledWith([PRODUCT_ID])
                expect(supabaseMock.minimumPrices).toHaveBeenCalledWith('validate_staff_minimum_selling_prices', expect.objectContaining({
                    p_items: Array.from({ length: 20 }, () => expect.objectContaining({ product_id: PRODUCT_ID, effective_selling_price: 100 }))
                }))
            } finally {
                individualRead.mockRestore()
                batchRead.mockRestore()
                await finishSummaryRefresh()
            }
        })

        it('still repairs an existing payment reference when retrying creation of a saved draft', async () => {
            const input = { ...unpaidQuickOrderInput('draft'), paymentMethod: 'loan' as const }
            const options = { orderId: crypto.randomUUID(), requireRemoteConfirmation: true, deferSummaryRefresh: true }
            const order = await createSalesOrder(WORKSPACE_ID, input, USER_ID, options)
            await finishSummaryRefresh()
            await db.payment_transactions.put({
                ...baseEntity('legacy-down-payment'), sourceModule: 'orders', sourceType: 'sales_order',
                sourceRecordId: order.id, direction: 'incoming', amount: 20, currency: 'usd', paymentMethod: 'cash',
                paidAt: order.createdAt, referenceLabel: 'SO-PENDING-OLD-REFERENCE'
            })
            await createSalesOrder(WORKSPACE_ID, input, USER_ID, options)
            await finishSummaryRefresh()
            expect(await db.payment_transactions.get('legacy-down-payment')).toMatchObject({
                referenceLabel: 'SO-2026-00999', amount: 20, direction: 'incoming', syncStatus: 'synced'
            })
            expect(await db.sales_orders.count()).toBe(1)
            expect(await db.payment_transactions.count()).toBe(1)
        })

        it('keeps database-normalized UoM snapshots in the local order cache after save', async () => {
            const uomId = crypto.randomUUID()
            let selectedColumns = ''
            supabaseMock.upsert.mockImplementationOnce((payload: unknown) => {
                const rows = Array.isArray(payload) ? payload : [payload]
                const response = { data: [], error: null }
                return {
                    select: async (columns: string) => {
                        selectedColumns = columns
                        return {
                            data: rows.map((row) => {
                                const order = row as { id?: string; items?: Array<Record<string, unknown>> }
                                return {
                                    id: order.id,
                                    order_number: 'SO-2026-00999',
                                    items: (order.items ?? []).map((item) => ({
                                        ...item,
                                        uomId,
                                        uomNameSnapshot: 'Piece',
                                        unitRef: 'builtin:piece',
                                        unit: 'piece',
                                        unitNameSnapshot: 'Piece',
                                        baseUnitRef: 'builtin:piece',
                                        baseUnitCode: 'piece',
                                        baseUnitNameSnapshot: 'Piece',
                                        unitFactor: 1,
                                        inventoryQuantity: item.quantity,
                                        freeBonusInventoryQuantity: 0
                                    }))
                                }
                            }),
                            error: null
                        }
                    },
                    then: <TResult1 = typeof response, TResult2 = never>(
                        onfulfilled?: ((value: typeof response) => TResult1 | PromiseLike<TResult1>) | null,
                        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
                    ) => Promise.resolve(response).then(onfulfilled, onrejected)
                } as unknown as ReturnType<typeof supabaseMock.upsert>
            })

            const saved = await createSalesOrder(WORKSPACE_ID, unpaidQuickOrderInput('draft'), USER_ID, {
                deferSummaryRefresh: true
            })
            const expectedSnapshot = {
                uomId,
                uomNameSnapshot: 'Piece',
                baseUnitCode: 'piece',
                unitFactor: 1,
                inventoryQuantity: 1
            }

            expect(selectedColumns).toBe('id, order_number, items')
            expect(saved.items[0]).toMatchObject(expectedSnapshot)
            expect((await db.sales_orders.get(saved.id))?.items[0]).toMatchObject(expectedSnapshot)
            await finishSummaryRefresh()
        })

        for (const dataMode of ['cloud', 'hybrid'] as const) {
            for (const paid of [false, true]) {
                it(`${dataMode}: confirms a ${paid ? 'paid' : 'unpaid'} draft without calculating or uploading summaries`, async () => {
                    writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode })
                    const release = deferredSummaryWrites()
                    const progress: string[] = []
                    const beforePartner = await db.business_partners.get(PARTNER_ID)
                    const beforeCustomer = await db.customers.get(CUSTOMER_ID)
                    const invalidation = vi.spyOn(queryClient, 'invalidateQueries')
                    try {
                        const order = await createSalesOrder(WORKSPACE_ID,
                            paid ? quickOrderInput() : unpaidQuickOrderInput('draft'), USER_ID, {
                                requireRemoteConfirmation: true, deferSummaryRefresh: true,
                                onProgress: report => progress.push(report.stageKey),
                            })
                        expect(order).toMatchObject({ orderNumber: 'SO-2026-00999', syncStatus: 'synced', status: 'draft' })
                        expect(progress.at(-1)).toBe('orders.form.saveProgressComplete')
                        expect(await assertOrderFinancialEffects(order.id, paid ? 100 : 0, paid ? 0 : 100)).toHaveLength(paid ? 1 : 0)
                        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
                        expect(await db.payment_account_movements.count()).toBe(0)
                        expect(await db.partner_summary_jobs.count()).toBe(0)
                        expect(await db.offline_mutations.count()).toBe(0)
                        expect(await db.business_partners.get(PARTNER_ID)).toEqual(beforePartner)
                        expect(await db.customers.get(CUSTOMER_ID)).toEqual(beforeCustomer)
                        expect(supabaseMock.rpc.mock.calls.some(([name]) => name === 'sync_customer' || name === 'sync_business_partner')).toBe(false)
                        expect(invalidation).toHaveBeenCalledWith({ queryKey: ['atlas','workspace',WORKSPACE_ID,'business-partners'] })
                    } finally { release(); invalidation.mockRestore() }
                })
            }

            it(`${dataMode}: moving an order to another customer invalidates the directory without overwriting either partner`, async () => {
                writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode })
                const order = await createSalesOrder(WORKSPACE_ID, unpaidQuickOrderInput('draft'), USER_ID)
                const newPartnerId = crypto.randomUUID()
                const newCustomerId = crypto.randomUUID()
                await db.business_partners.put({ ...(await db.business_partners.get(PARTNER_ID))!, id: newPartnerId, customerFacetId: newCustomerId })
                await db.customers.put({ ...(await db.customers.get(CUSTOMER_ID))!, id: newCustomerId, businessPartnerId: newPartnerId })
                const before = await db.business_partners.toArray()
                const invalidation = vi.spyOn(queryClient, 'invalidateQueries')
                try {
                    const updated = await updateSalesOrder(order.id, { businessPartnerId: newPartnerId,
                        customerId: newCustomerId, notes: 'Updated draft' }, { requireRemoteConfirmation: true })
                    expect(updated).toMatchObject({ customerId: newCustomerId, businessPartnerId: newPartnerId, notes: 'Updated draft' })
                    expect(await db.sales_orders.get(order.id)).toMatchObject({ syncStatus: 'synced' })
                    expect(await db.business_partners.toArray()).toEqual(before)
                    expect(invalidation).toHaveBeenCalledWith({ queryKey: ['atlas','workspace',WORKSPACE_ID,'business-partners'] })
                    expect(await assertOrderFinancialEffects(order.id,0,100)).toHaveLength(0)
                } finally { invalidation.mockRestore() }
            })
        }

        it('keeps Local saves fully refreshed and makes no remote writes even when deferral is requested', async () => {
            writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
            const order = await createSalesOrder(WORKSPACE_ID, unpaidQuickOrderInput('draft'), USER_ID,
                { requireRemoteConfirmation: true, deferSummaryRefresh: true })
            expect((await db.customers.get(CUSTOMER_ID))?.totalOrders).toBe(1)
            expect((await db.business_partners.get(PARTNER_ID))?.totalSalesOrders).toBe(1)
            expect(await assertOrderFinancialEffects(order.id, 0, 100)).toHaveLength(0)
            expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
            expect(supabaseMock.upsert).not.toHaveBeenCalled()
            expect(supabaseMock.rpc).not.toHaveBeenCalled()
            expect(await db.partner_summary_jobs.count()).toBe(0)
        })

        it('confirms a paid save even if the retired summary-job storage is unavailable', async () => {
            const options = { requireRemoteConfirmation: true, orderId: crypto.randomUUID(),
                initialPaymentTransactionId: crypto.randomUUID(), onProgress: vi.fn() }
            const put = vi.spyOn(db.partner_summary_jobs,'bulkPut').mockRejectedValue(new Error('Disk full'))
            try {
                const order = await createSalesOrder(WORKSPACE_ID,quickOrderInput(),USER_ID,options)
                expect(put).not.toHaveBeenCalled()
                expect(options.onProgress).toHaveBeenCalledWith(expect.objectContaining({ stageKey:'orders.form.saveProgressComplete' }))
                expect(await assertOrderFinancialEffects(order.id,100,0)).toHaveLength(1)
                expect(await db.sales_orders.count()).toBe(1)
            } finally { put.mockRestore() }
        })

        it('retires old summary intents without replaying payments or altering the offline business queue', async () => {
            const order = await createSalesOrder(WORKSPACE_ID,unpaidQuickOrderInput('draft'),USER_ID)
            await seedLegacySummaryJobs([{ workspaceId:WORKSPACE_ID,table:'customers',entityId:CUSTOMER_ID }])
            await db.customers.delete(CUSTOMER_ID)
            supabaseMock.rpc.mockClear()
            await processPartnerSummaryJobs(WORKSPACE_ID)
            expect(supabaseMock.rpc).not.toHaveBeenCalled()
            expect(await db.partner_summary_jobs.count()).toBe(0)
            expect(await db.offline_mutations.count()).toBe(0)
            expect(await assertOrderFinancialEffects(order.id,0,100)).toHaveLength(0)
        })
    })

    it('uses one RPC and mirrors its order, payment, and inventory result', async () => {
        installSuccessfulRpcResponse()
        const progress: string[] = []

        const completed = await createCompletedSalesOrder(
            WORKSPACE_ID,
            quickOrderInput(),
            USER_ID,
            { onProgress: (stage) => progress.push(stage) }
        )

        expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
        expect(supabaseMock.rpc).toHaveBeenCalledWith(
            'complete_quick_sales_order',
            expect.objectContaining({
                payload: expect.objectContaining({
                    order: expect.objectContaining({
                        workspace_id: WORKSPACE_ID,
                        status: 'completed',
                        commission_enabled: false,
                        commission_mode: null,
                        commission_mode_captured_at: null,
                        exchange_rates: []
                    }),
                    payment: expect.objectContaining({ amount: 100 })
                })
            })
        )
        expect(progress).toEqual(['creating', 'reserving', 'completing'])
        expect(completed).toMatchObject({
            orderNumber: 'SO-2026-00999',
            status: 'completed',
            commissionEnabled: false,
            commissionMode: null,
            commissionModeCapturedAt: null,
            paymentStatus: 'paid',
            paidAmount: 100,
            balanceAmount: 0
        })
        expect(await db.sales_orders.get(completed.id)).toMatchObject({ status: 'completed' })
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(1)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
    })

    it('requires Supabase acknowledgement for an order-form save and reuses its order identity on retry', async () => {
        const orderId = crypto.randomUUID()
        const initialPaymentTransactionId = crypto.randomUUID()
        const progress: string[] = []
        const remoteFailure = new Error('Supabase write failed')
        const successfulUpsert = supabaseMock.upsert.getMockImplementation()
        supabaseMock.upsert
            .mockImplementationOnce(() => ({
                select: async () => ({ data: null, error: remoteFailure }),
                then: (resolve: (value: { data: null; error: Error }) => unknown) => resolve({ data: null, error: remoteFailure })
            }) as unknown as ReturnType<typeof supabaseMock.upsert>)

        await expect(createSalesOrder(
            WORKSPACE_ID,
            unpaidQuickOrderInput('draft'),
            USER_ID,
            {
                orderId,
                initialPaymentTransactionId,
                requireRemoteConfirmation: true,
                deferSummaryRefresh: true,
                onProgress: (report) => progress.push(report.stageKey)
            }
        )).rejects.toThrow('remote_order_save_confirmation_failed')

        expect(await db.offline_mutations.count()).toBe(0)
        expect(await db.sales_orders.get(orderId)).toMatchObject({ syncStatus: 'pending' })
        expect(progress).not.toContain('orders.form.saveProgressComplete')

        if (successfulUpsert) {
            supabaseMock.upsert.mockImplementation(successfulUpsert)
        }
        const saved = await createSalesOrder(
            WORKSPACE_ID,
            unpaidQuickOrderInput('draft'),
            USER_ID,
            {
                orderId,
                initialPaymentTransactionId,
                requireRemoteConfirmation: true,
                deferSummaryRefresh: true,
                onProgress: (report) => progress.push(report.stageKey)
            }
        )

        expect(saved).toMatchObject({ id: orderId, orderNumber: 'SO-2026-00999', syncStatus: 'synced' })
        expect(await db.sales_orders.count()).toBe(1)
        expect(progress).toContain('orders.form.saveProgressComplete')
        await finishSummaryRefresh()
    })

    it(`${initialPaymentRegression.id}: rolls back a rejected initial save and retries one order and payment identity`, async () => {
        const orderId = crypto.randomUUID()
        const initialPaymentTransactionId = crypto.randomUUID()
        supabaseMock.rpc.mockResolvedValueOnce({ data: null, error: new Error('Supabase order write failed') })

        const options = {
            orderId,
            initialPaymentTransactionId,
            requireRemoteConfirmation: true
        }
        await expect(createSalesOrder(WORKSPACE_ID, quickOrderInput(), USER_ID, options))
            .rejects.toThrow('remote_order_save_confirmation_failed')
        expect(await db.sales_orders.get(orderId)).toBeUndefined()
        expect(await db.payment_transactions.where('sourceRecordId').equals(orderId).count()).toBe(0)
        expect(await db.payment_account_movements.count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)

        await createSalesOrder(WORKSPACE_ID, quickOrderInput(), USER_ID, options)

        expect(await db.sales_orders.count()).toBe(1)
        expect(await db.payment_transactions.where('sourceRecordId').equals(orderId).count()).toBe(1)
        expect(await db.payment_transactions.get(initialPaymentTransactionId)).toMatchObject({ syncStatus: 'synced' })

        expect(supabaseMock.rpc.mock.calls.filter(([name]) => name === 'create_sales_order_with_initial_payment'))
            .toHaveLength(2)
    })

    it('uses the same atomic order flow for services without inventory movement', async () => {
        await db.products.put({
            ...baseEntity(SERVICE_ID),
            sku: '',
            name: 'Fast Checkout Service',
            unit: 'service',
            currency: 'usd',
            price: 100,
            costPrice: 0,
            quantity: 0,
            minStockLevel: 0,
            storageId: null,
            isService: true
        } as never)
        installSuccessfulServiceRpcResponse()

        const completed = await createCompletedSalesOrder(
            WORKSPACE_ID,
            serviceQuickOrderInput(),
            USER_ID
        )

        expect(supabaseMock.rpc).toHaveBeenCalledWith(
            'complete_quick_sales_order',
            expect.objectContaining({
                payload: expect.objectContaining({
                    order: expect.objectContaining({
                        source_storage_id: null,
                        items: [expect.objectContaining({
                            productId: SERVICE_ID,
                            storageId: SERVICES_VIRTUAL_STORAGE_ID,
                            productName: 'Fast Checkout Service - NewService',
                            metadata: {
                                posServiceName: {
                                    baseNameSnapshot: 'Fast Checkout Service',
                                    suffix: 'NewService',
                                    displayNameSnapshot: 'Fast Checkout Service - NewService'
                                }
                            }
                        })]
                    })
                })
            })
        )
        expect(completed.items).toMatchObject([{
            productId: SERVICE_ID,
            storageId: SERVICES_VIRTUAL_STORAGE_ID,
            productName: 'Fast Checkout Service - NewService',
            metadata: {
                posServiceName: {
                    baseNameSnapshot: 'Fast Checkout Service',
                    suffix: 'NewService',
                    displayNameSnapshot: 'Fast Checkout Service - NewService'
                }
            }
        }])
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(1)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
    })

    it('does not record a service order or payment when its atomic completion fails', async () => {
        await db.products.put({
            ...baseEntity(SERVICE_ID),
            sku: '',
            name: 'Fast Checkout Service',
            unit: 'service',
            currency: 'usd',
            price: 100,
            costPrice: 0,
            quantity: 0,
            minStockLevel: 0,
            storageId: null,
            isService: true
        } as never)
        supabaseMock.rpc.mockResolvedValueOnce({
            data: null,
            error: new Error('Quick Order service completion failed')
        })

        await expect(createCompletedSalesOrder(
            WORKSPACE_ID,
            serviceQuickOrderInput(),
            USER_ID
        )).rejects.toThrow('Quick Order service completion failed')

        expect(await db.sales_orders.count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
    })

    it('does not mutate local order, payment, or stock state when the RPC fails', async () => {
        supabaseMock.rpc.mockResolvedValueOnce({
            data: null,
            error: new Error('Insufficient stock for product')
        })

        await expect(createCompletedSalesOrder(
            WORKSPACE_ID,
            quickOrderInput(),
            USER_ID
        )).rejects.toThrow('Insufficient stock')

        expect(await db.sales_orders.count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
    })

    it('keeps the atomic path at the paid-amount rounding boundary', async () => {
        installSuccessfulRpcResponse()

        await createCompletedSalesOrder(
            WORKSPACE_ID,
            quickOrderInput(99.9996),
            USER_ID
        )

        expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
    })

    it('completes a paid Cloud Quick Order in a selected UoM and sends its conversion snapshot', async () => {
        await db.product_uoms.bulkPut([
            {
                ...baseEntity('10000000-0000-4000-8000-000000000010'),
                productId: PRODUCT_ID, unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1,
                isBase: true, isActive: true, isDefaultSelling: false,
                sellingPrice: 100, costPrice: 40, minimumSellingPrice: null
            },
            {
                ...baseEntity('10000000-0000-4000-8000-000000000011'),
                productId: PRODUCT_ID, unitRef: 'builtin:carton', unitCode: 'carton', coefficient: 2,
                isBase: false, isActive: true, isDefaultSelling: true,
                sellingPrice: 200, costPrice: 80, minimumSellingPrice: 170
            }
        ] as never)
        const input = quickOrderInput(200)
        input.items[0] = {
            ...input.items[0], unit: 'carton', uomId: '10000000-0000-4000-8000-000000000011',
            uomNameSnapshot: 'Carton', unitRef: 'builtin:carton', unitNameSnapshot: 'Carton',
            baseUnitRef: 'builtin:pcs', baseUnitCode: 'pcs', baseUnitNameSnapshot: 'Piece',
            unitFactor: 2, inventoryQuantity: 2, minimumSellingPriceSnapshot: 170,
            uomCostPrice: 80, convertedUomCostPrice: 80, quantity: 1, lineTotal: 200,
            originalUnitPrice: 200, convertedUnitPrice: 200, costPrice: 40, convertedCostPrice: 40
        }
        input.subtotal = input.total = 200
        installSuccessfulRpcResponse(3)

        const completed = await createCompletedSalesOrder(WORKSPACE_ID, input, USER_ID)

        expect(supabaseMock.rpc).toHaveBeenCalledWith('complete_quick_sales_order', expect.objectContaining({
            payload: expect.objectContaining({
                order: expect.objectContaining({
                    items: [expect.objectContaining({
                        uomId: '10000000-0000-4000-8000-000000000011',
                        unitFactor: 2, inventoryQuantity: 2,
                        uomCostPrice: 80, convertedUomCostPrice: 80, minimumSellingPriceSnapshot: 170
                    })]
                })
            })
        }))
        expect(completed.items[0]).toMatchObject({
            unit: 'carton', unitFactor: 2, inventoryQuantity: 2, uomCostPrice: 80,
            convertedCostPrice: 40, convertedUomCostPrice: 80
        })
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(3)
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(1)
    })

    it('retains the existing transaction flow for Local Mode', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })

        const completed = await createCompletedSalesOrder(
            WORKSPACE_ID,
            quickOrderInput(),
            USER_ID
        )

        expect(supabaseMock.rpc).not.toHaveBeenCalled()
        expect(completed.status).toBe('completed')
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(1)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
    })

    it('completes a Quick Order with per-line source storages and updates each stock position', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        await db.storages.put({
            ...baseEntity(SECOND_STORAGE_ID), name: 'Second Quick Order storage',
            isSystem: false, isProtected: false, isPrimary: false, isMarketplace: false
        } as never)
        await db.inventory.put({
            ...baseEntity(SECOND_INVENTORY_ID), productId: PRODUCT_ID, storageId: SECOND_STORAGE_ID, quantity: 5
        })
        await db.products.update(PRODUCT_ID, { quantity: 10 })

        await db.products.put({
            ...baseEntity(SERVICE_ID),
            sku: '',
            name: 'Fast Checkout Service',
            unit: 'service',
            currency: 'usd',
            price: 50,
            costPrice: 0,
            quantity: 0,
            minStockLevel: 0,
            storageId: null,
            isService: true
        } as never)

        const input = quickOrderInput(350)
        input.sourceStorageId = null
        const serviceItem = {
            ...serviceQuickOrderInput().items[0],
            lineTotal: 50,
            originalUnitPrice: 50,
            convertedUnitPrice: 50,
            costPrice: 0,
            convertedCostPrice: 0
        }
        input.items = [
            input.items[0],
            {
                ...input.items[0],
                id: crypto.randomUUID(),
                storageId: SECOND_STORAGE_ID,
                quantity: 2,
                lineTotal: 200
            },
            serviceItem
        ]
        input.subtotal = 350
        input.total = 350

        const completed = await createCompletedSalesOrder(WORKSPACE_ID, input, USER_ID)

        expect(completed.items.filter((item) => item.productId === PRODUCT_ID)
            .map((item) => [item.storageId, item.quantity, item.fulfilledQuantity])).toEqual([
            [STORAGE_ID, 1, 1], [SECOND_STORAGE_ID, 2, 2]
        ])
        expect(completed.items.find((item) => item.productId === SERVICE_ID)).toMatchObject({
            storageId: SERVICES_VIRTUAL_STORAGE_ID, quantity: 1
        })
        expect((await db.sales_orders.get(completed.id))?.sourceStorageId).toBeNull()
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
        expect((await db.inventory.get(SECOND_INVENTORY_ID))?.quantity).toBe(3)
        expect((await db.products.get(PRODUCT_ID))?.quantity).toBe(7)
        expect(await db.inventory_transactions.where('referenceId').equals(completed.id).toArray())
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ storageId: STORAGE_ID, quantityDelta: -1, referenceType: 'sales_order' }),
                expect.objectContaining({ storageId: SECOND_STORAGE_ID, quantityDelta: -2, referenceType: 'sales_order' })
            ]))
        expect(await assertOrderFinancialEffects(completed.id, 350, 0)).toHaveLength(1)
    })

    it('completes a free-only Quick Order without a payment transaction while deducting its free stock', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })

        const completed = await createQuickSalesOrder(
            WORKSPACE_ID,
            freeOnlyQuickOrderInput(),
            USER_ID
        )

        expect(completed).toMatchObject({
            status: 'completed',
            paymentStatus: 'paid',
            paidAmount: 0,
            balanceAmount: 0,
            items: [expect.objectContaining({ quantity: 0, freeBonusQuantity: 1, fulfilledQuantity: 1 })]
        })
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
        expect((await db.products.get(PRODUCT_ID))?.quantity).toBe(4)
        expect((await db.business_partners.get(PARTNER_ID))?.receivableBalance).toBe(0)
    })

    it('completes a cloud free-only Quick Order through inventory completion without a payment transaction', async () => {
        supabaseMock.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
            if (name === 'sync_customer' || name === 'sync_business_partner') {
                return { data: null, error: null }
            }
            if (name !== 'complete_sales_order_with_inventory') {
                return { data: null, error: new Error(`Unexpected RPC: ${name}`) }
            }
            const orderId = String(args.p_order_id)
            const order = await db.sales_orders.get(orderId)
            if (!order) throw new Error(`Missing order for completion: ${orderId}`)
            return {
                data: {
                    order: toSnakeCase({
                        ...order,
                        status: 'completed',
                        version: Number(args.p_expected_order_version) + 1,
                        items: args.p_items,
                        actualDeliveryDate: args.p_actual_delivery_date
                    }),
                    inventory: [{
                        id: INVENTORY_ID,
                        workspace_id: WORKSPACE_ID,
                        product_id: PRODUCT_ID,
                        storage_id: STORAGE_ID,
                        quantity: 4,
                        created_at: '2026-08-31T08:00:00.000Z',
                        updated_at: '2026-08-31T09:00:00.000Z',
                        version: 2,
                        is_deleted: false
                    }],
                    inventory_transactions: [],
                    conflict: false
                },
                error: null
            }
        })
        supabaseMock.select
            .mockImplementationOnce(() => supabaseMock.createSelectQuery())
            .mockImplementationOnce(() => supabaseMock.createSelectQuery([{
                id: INVENTORY_ID,
                workspace_id: WORKSPACE_ID,
                product_id: PRODUCT_ID,
                storage_id: STORAGE_ID,
                quantity: 5,
                created_at: '2026-08-31T08:00:00.000Z',
                updated_at: '2026-08-31T08:00:00.000Z',
                version: 1,
                is_deleted: false
            }]))

        const completed = await createQuickSalesOrder(
            WORKSPACE_ID,
            freeOnlyQuickOrderInput(),
            USER_ID
        )

        expect(completed).toMatchObject({ status: 'completed', paidAmount: 0, balanceAmount: 0 })
        expect(supabaseMock.rpc).not.toHaveBeenCalledWith(
            'complete_quick_sales_order',
            expect.anything()
        )
        expect(supabaseMock.rpc).toHaveBeenCalledWith(
            'complete_sales_order_with_inventory',
            expect.objectContaining({ p_workspace_id: WORKSPACE_ID, p_order_id: completed.id })
        )
        expect(supabaseMock.upsert).toHaveBeenCalled()
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
    })

    it('rejects a free-only Quick Order whose free quantity exceeds stock without changing records', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })

        await expect(createQuickSalesOrder(
            WORKSPACE_ID,
            freeOnlyQuickOrderInput(6),
            USER_ID
        )).rejects.toThrow('Not enough stock')

        expect(await db.sales_orders.toArray()).toMatchObject([
            { status: 'draft', paidAmount: 0, balanceAmount: 0 }
        ])
        expect(await db.payment_transactions.count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
    })

    it('saves unpaid Quick Orders at each selected lifecycle status without recording a payment', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })

        const draft = await createQuickSalesOrder(
            WORKSPACE_ID,
            unpaidQuickOrderInput('draft'),
            USER_ID
        )

        expect(draft).toMatchObject({
            status: 'draft',
            paymentStatus: 'unpaid',
            paidAmount: 0,
            balanceAmount: 100
        })
        expect(await db.payment_transactions.where('sourceRecordId').equals(draft.id).count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)

        const pending = await createQuickSalesOrder(
            WORKSPACE_ID,
            unpaidQuickOrderInput('pending'),
            USER_ID
        )

        expect(pending).toMatchObject({
            status: 'pending',
            paymentStatus: 'unpaid',
            paidAmount: 0,
            balanceAmount: 100
        })
        expect(pending.reservedAt).toBeTruthy()
        expect(await db.payment_transactions.where('sourceRecordId').equals(pending.id).count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)

        const completed = await createQuickSalesOrder(
            WORKSPACE_ID,
            unpaidQuickOrderInput('completed'),
            USER_ID
        )

        expect(completed).toMatchObject({
            status: 'completed',
            paymentStatus: 'unpaid',
            paidAmount: 0,
            balanceAmount: 100
        })
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
    })

    it('records the full payment for a paid Quick Order even when it is saved as a draft', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        await db.payment_accounts.put({
            ...baseEntity(PAYMENT_ACCOUNT_ID),
            name: 'Main cash drawer',
            accountType: 'cash_drawer',
            linkedPaymentMethod: null,
            iconKey: 'cash_drawer',
            notes: null,
            isActive: true,
            isPrimary: true,
            isDefaultForPaymentSelector: true,
            createdBy: USER_ID
        })
        const input = {
            ...quickOrderInput(),
            initialPaymentAccountId: PAYMENT_ACCOUNT_ID,
            initialPaymentAccountNameSnapshot: 'Main cash drawer'
        }

        const paidDraft = await createQuickSalesOrder(
            WORKSPACE_ID,
            input,
            USER_ID
        )

        expect(paidDraft).toMatchObject({
            status: 'draft',
            paymentStatus: 'paid',
            paidAmount: 100,
            balanceAmount: 0
        })
        expect(await db.payment_transactions.where('sourceRecordId').equals(paidDraft.id).toArray()).toEqual([
            expect.objectContaining({
                sourceType: 'sales_order',
                direction: 'incoming',
                amount: 100,
                paymentMethod: 'cash',
                accountId: PAYMENT_ACCOUNT_ID
            })
        ])
        expect(await db.payment_account_movements.toArray()).toEqual([
            expect.objectContaining({
                paymentTransactionId: expect.any(String),
                accountId: PAYMENT_ACCOUNT_ID,
                direction: 'incoming',
                amount: 100,
                deltaAmount: 100
            })
        ])
        expect(await db.payment_account_balances
            .where('[accountId+currency]')
            .equals([PAYMENT_ACCOUNT_ID, 'usd'])
            .first()).toMatchObject({ balanceAmount: 100 })
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
    })

    it('records an installment Quick Order initial payment and creates the remaining loan schedule', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        await db.payment_accounts.put({
            ...baseEntity(PAYMENT_ACCOUNT_ID),
            name: 'Main cash drawer',
            accountType: 'cash_drawer',
            linkedPaymentMethod: null,
            iconKey: 'cash_drawer',
            notes: null,
            isActive: true,
            isPrimary: true,
            isDefaultForPaymentSelector: true,
            createdBy: USER_ID
        })
        const completed = await createQuickSalesOrder(WORKSPACE_ID, {
            ...unpaidQuickOrderInput('completed'),
            paymentMethod: 'installments',
            isInstallmentBased: true,
            installmentCount: 4,
            installmentFrequency: 'weekly',
            firstDueDate: '2026-09-01',
            nextDueDate: '2026-09-01',
            initialPaymentAmount: 25,
            initialPaymentAccountId: PAYMENT_ACCOUNT_ID,
            initialPaymentAccountNameSnapshot: 'Main cash drawer'
        }, USER_ID)

        expect(completed).toMatchObject({
            status: 'completed',
            paymentMethod: 'installments',
            paymentStatus: 'partial',
            isPaid: false,
            paidAmount: 25,
            balanceAmount: 75,
            initialPaymentAmount: 25,
            installmentCount: 4,
            installmentFrequency: 'weekly',
            firstDueDate: '2026-09-01',
            linkedLoanId: expect.any(String)
        })
        const [payment] = await assertOrderFinancialEffects(completed.id, 25, 75)
        expect(payment).toMatchObject({
            sourceType: 'sales_order',
            direction: 'incoming',
            amount: 25,
            paymentMethod: 'cash',
            accountId: PAYMENT_ACCOUNT_ID,
            accountNameSnapshot: 'Main cash drawer',
            metadata: { isDownPayment: true, isFinancingInitialPayment: true }
        })
        expect(await db.payment_account_movements.toArray()).toEqual([
            expect.objectContaining({
                paymentTransactionId: payment.id,
                accountId: PAYMENT_ACCOUNT_ID,
                direction: 'incoming',
                amount: 25,
                deltaAmount: 25
            })
        ])
        expect(await db.payment_account_balances
            .where('[accountId+currency]')
            .equals([PAYMENT_ACCOUNT_ID, 'usd'])
            .first()).toMatchObject({ balanceAmount: 25 })
        const loan = await db.loans.get(completed.linkedLoanId!)
        expect(loan).toMatchObject({
            principalAmount: 75,
            installmentCount: 4,
            installmentFrequency: 'weekly',
            firstDueDate: '2026-09-01'
        })
        const installments = await db.loan_installments.where('loanId').equals(loan!.id).toArray()
        expect(installments).toHaveLength(4)
        expect(installments.sort((left, right) => left.installmentNo - right.installmentNo)[0].dueDate).toBe('2026-09-01')
        expect(installments.reduce((sum, installment) => sum + installment.plannedAmount, 0)).toBeCloseTo(75, 3)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
    })

    it('records a partially paid Loan Quick Order through the order-linked loan repayment flow', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        await db.payment_accounts.put({
            ...baseEntity(PAYMENT_ACCOUNT_ID),
            name: 'Main cash drawer',
            accountType: 'cash_drawer',
            linkedPaymentMethod: null,
            iconKey: 'cash_drawer',
            notes: null,
            isActive: true,
            isPrimary: true,
            isDefaultForPaymentSelector: true,
            createdBy: USER_ID
        })
        const completed = await createQuickSalesOrder(WORKSPACE_ID, {
            ...unpaidQuickOrderInput('completed'),
            paymentMethod: 'loan',
            paymentStatus: 'partial',
            paidAmount: 25,
            balanceAmount: 75,
            initialPaymentAmount: 25,
            initialPaymentAccountId: PAYMENT_ACCOUNT_ID,
            initialPaymentAccountNameSnapshot: 'Main cash drawer',
            firstDueDate: null,
            nextDueDate: null
        }, USER_ID)

        expect(completed).toMatchObject({
            status: 'completed',
            paymentMethod: 'loan',
            paymentStatus: 'partial',
            isPaid: false,
            paidAmount: 25,
            balanceAmount: 75,
            initialPaymentAmount: 25,
            firstDueDate: null,
            linkedLoanId: expect.any(String)
        })
        const loan = await db.loans.get(completed.linkedLoanId!)
        expect(loan).toMatchObject({
            loanCategory: 'simple',
            principalAmount: 100,
            totalPaidAmount: 25,
            balanceAmount: 75,
            firstDueDate: null
        })
        const [payment] = await db.payment_transactions
            .where('[workspaceId+sourceType+sourceRecordId]')
            .equals([WORKSPACE_ID, 'simple_loan', loan!.id])
            .toArray()
        expect(payment).toMatchObject({
            direction: 'incoming',
            amount: 25,
            paymentMethod: 'cash',
            accountId: PAYMENT_ACCOUNT_ID,
            accountNameSnapshot: 'Main cash drawer',
            metadata: { isOrderLoanInitialRepayment: true }
        })
        expect(await db.loan_installments.where('loanId').equals(loan!.id).toArray()).toEqual([
            expect.objectContaining({
                installmentNo: 1,
                plannedAmount: 100,
                paidAmount: 25,
                balanceAmount: 75
            })
        ])
        expect(await db.payment_account_movements.toArray()).toEqual([
            expect.objectContaining({
                paymentTransactionId: payment.id,
                accountId: PAYMENT_ACCOUNT_ID,
                direction: 'incoming',
                amount: 25,
                deltaAmount: 25
            })
        ])
        expect(await db.payment_account_balances
            .where('[accountId+currency]')
            .equals([PAYMENT_ACCOUNT_ID, 'usd'])
            .first()).toMatchObject({ balanceAmount: 25 })
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
    })

    it('rejects a paid Quick Order with a financing payment method before records are created', async () => {
        const invalid = {
            ...quickOrderInput(),
            paymentMethod: 'installments' as const,
            isInstallmentBased: true,
            installmentCount: 3,
            installmentFrequency: 'monthly' as const,
            firstDueDate: '2026-09-01',
            nextDueDate: '2026-09-01'
        }

        await expect(createQuickSalesOrder(WORKSPACE_ID, invalid, USER_ID))
            .rejects.toThrow('Financed Quick Orders cannot be paid on save')

        expect(await db.sales_orders.count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(0)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(5)
    })
})
