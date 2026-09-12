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
    const upsert = vi.fn(async () => ({ data: [], error: null }))
    const insert = vi.fn(async () => ({ data: [], error: null }))
    const from = vi.fn(() => ({ upsert, insert }))
    return { rpc, upsert, insert, from }
})

vi.mock('@/auth/supabase', () => ({
    supabase: {
        rpc: supabaseMock.rpc,
        from: supabaseMock.from,
        schema: () => ({ from: supabaseMock.from })
    }
}))

vi.mock('@/lib/supabaseRequest', () => ({
    isRetriableWebRequestError: () => false,
    normalizeSupabaseActionError: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    runSupabaseAction: async (_label: string, action: () => PromiseLike<unknown>) => action()
}))

import { setNetworkStatus } from '@/lib/network'
import { SERVICES_VIRTUAL_STORAGE_ID } from '@/lib/catalogItem'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import { createCompletedSalesOrder, createQuickSalesOrder } from './orders'

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001'
const USER_ID = '10000000-0000-4000-8000-000000000002'
const PARTNER_ID = '10000000-0000-4000-8000-000000000003'
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000004'
const PRODUCT_ID = '10000000-0000-4000-8000-000000000005'
const SERVICE_ID = '10000000-0000-4000-8000-000000000008'
const STORAGE_ID = '10000000-0000-4000-8000-000000000006'
const INVENTORY_ID = '10000000-0000-4000-8000-000000000007'
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
            productName: 'Fast Checkout Service',
            productSku: '',
            unit: 'service',
            costPrice: 0,
            convertedCostPrice: 0
        }]
    }
}

function installSuccessfulRpcResponse() {
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
                        reservedQuantity: 1,
                        fulfilledQuantity: 1,
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
                    quantity: 4,
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
        vi.clearAllMocks()

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
                        status: 'completed',
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
            paymentStatus: 'paid',
            paidAmount: 100,
            balanceAmount: 0
        })
        expect(await db.sales_orders.get(completed.id)).toMatchObject({ status: 'completed' })
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(1)
        expect((await db.inventory.get(INVENTORY_ID))?.quantity).toBe(4)
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
                            storageId: SERVICES_VIRTUAL_STORAGE_ID
                        })]
                    })
                })
            })
        )
        expect(completed.items).toMatchObject([{
            productId: SERVICE_ID,
            storageId: SERVICES_VIRTUAL_STORAGE_ID
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
