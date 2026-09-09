import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import type { PurchaseOrder, SalesOrder } from './models'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000201'
const PRODUCT_ID = '00000000-0000-4000-8000-000000000202'

type PurchaseOrderCreateInput = Omit<
    PurchaseOrder,
    'id'
    | 'workspaceId'
    | 'createdAt'
    | 'updatedAt'
    | 'syncStatus'
    | 'lastSyncedAt'
    | 'version'
    | 'isDeleted'
    | 'orderNumber'
>

type SalesOrderCreateInput = Omit<
    SalesOrder,
    'id'
    | 'workspaceId'
    | 'createdAt'
    | 'updatedAt'
    | 'syncStatus'
    | 'lastSyncedAt'
    | 'version'
    | 'isDeleted'
    | 'orderNumber'
>

let createBusinessPartner: typeof import('./businessPartners').createBusinessPartner
let createSalesOrder: typeof import('./orders').createSalesOrder
let createCompletedSalesOrder: typeof import('./orders').createCompletedSalesOrder
let createPurchaseOrder: typeof import('./orders').createPurchaseOrder
let updateSalesOrderStatus: typeof import('./orders').updateSalesOrderStatus
let updatePurchaseOrderStatus: typeof import('./orders').updatePurchaseOrderStatus
let recordOrderPayment: typeof import('./orders').recordOrderPayment
let returnSalesOrder: typeof import('./orders').returnSalesOrder
let createPostReturnSalesOrderAdjustment: typeof import('./orders').createPostReturnSalesOrderAdjustment
let createProduct: typeof import('./hooks').createProduct
let createStorage: typeof import('./hooks').createStorage
let recordLoanPayment: typeof import('./hooks').recordLoanPayment
let buildPaymentObligations: typeof import('./payments').buildPaymentObligations
let getRemainingPaymentTransactions: typeof import('./payments').getRemainingPaymentTransactions
let reversePaymentTransaction: typeof import('./payments').reversePaymentTransaction
let synchronizeOrderPaymentReferences: typeof import('./payments').synchronizeOrderPaymentReferences

function installBrowserStorage() {
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
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: storage,
            sessionStorage: storage,
            location: { origin: 'http://localhost', hash: '', pathname: '/' },
            URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => undefined },
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            dir: 'ltr',
            documentElement: { lang: 'en', dir: 'ltr' },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({ appendChild: () => undefined }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
    Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, value: class DOMMatrix {} })
    Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: class ImageData {} })
    Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: class Path2D {} })
}

async function createSupplier(payableCreditLimit: number | null) {
    return createBusinessPartner(WORKSPACE_ID, {
        partnerName: `Supplier ${payableCreditLimit ?? 'unlimited'}`,
        phone: '07500000201',
        defaultCurrency: 'usd',
        creditLimit: 0,
        receivableCreditLimit: null,
        payableCreditLimit,
        role: 'supplier'
    })
}

async function createCustomer() {
    return createBusinessPartner(WORKSPACE_ID, {
        partnerName: 'Order Customer',
        phone: '07500000202',
        defaultCurrency: 'iqd',
        creditLimit: 0,
        receivableCreditLimit: null,
        payableCreditLimit: null,
        role: 'customer'
    })
}

async function createStockedSalesProduct(total = 15000) {
    const storage = await createStorage(WORKSPACE_ID, { name: 'Order Loan Storage' })
    const product = await createProduct(WORKSPACE_ID, {
        sku: 'SO-LOAN-001',
        name: 'Order Loan Product',
        description: 'Product for order loan tests',
        categoryId: null,
        category: null,
        storageId: storage.id,
        storageName: storage.name,
        price: total,
        costPrice: Math.max(1, total / 2),
        quantity: 5,
        minStockLevel: 0,
        unit: 'pcs',
        currency: 'iqd',
        barcode: '',
        barcodes: [],
        imageUrl: '',
        canBeReturned: true,
        returnRules: '',
        createdBy: null
    })

    return { storage, product }
}

function salesOrderWithStaleRoundedBalance(customerId: string): SalesOrder {
    const now = '2026-06-28T12:00:00.000Z'
    return {
        id: crypto.randomUUID(),
        workspaceId: WORKSPACE_ID,
        orderNumber: 'SO-ROUNDING-001',
        businessPartnerId: customerId,
        customerId,
        customerName: 'Order Customer',
        sourceStorageId: null,
        items: [{
            id: crypto.randomUUID(),
            productId: PRODUCT_ID,
            productName: 'Fractional IQD Product',
            productSku: 'IQD-001',
            quantity: 25.5,
            lineTotal: 688.5,
            originalCurrency: 'iqd',
            originalUnitPrice: 27,
            convertedUnitPrice: 27,
            settlementCurrency: 'iqd',
            costPrice: 10,
            convertedCostPrice: 10
        }],
        subtotal: 688.5,
        discount: 0,
        tax: 0,
        total: 688.5,
        currency: 'iqd',
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        exchangeRates: null,
        status: 'completed',
        expectedDeliveryDate: null,
        actualDeliveryDate: now,
        isPaid: false,
        paymentStatus: 'unpaid',
        paidAmount: 0,
        balanceAmount: 689,
        paidAt: null,
        paymentMethod: 'cash',
        initialPaymentAmount: 0,
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
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        syncStatus: 'synced',
        lastSyncedAt: now,
        version: 1,
        isDeleted: false
    }
}

function salesOrderInput(
    customerId: string,
    product: { id: string; name: string; sku: string; costPrice: number | null },
    storageId: string,
    options: {
        method: SalesOrder['paymentMethod']
        total?: number
        initialPayment?: number
        firstDueDate?: string | null
    }
): SalesOrderCreateInput {
    const total = options.total ?? 15000
    const initialPayment = options.initialPayment ?? 0
    const financed = options.method === 'loan' || options.method === 'installments'

    return {
        businessPartnerId: customerId,
        customerId,
        customerName: 'Order Customer',
        sourceStorageId: storageId,
        items: [{
            id: crypto.randomUUID(),
            productId: product.id,
            storageId,
            productName: product.name,
            productSku: product.sku,
            quantity: 1,
            lineTotal: total,
            originalCurrency: 'iqd',
            originalUnitPrice: total,
            convertedUnitPrice: total,
            settlementCurrency: 'iqd',
            costPrice: product.costPrice ?? 0,
            convertedCostPrice: product.costPrice ?? 0,
            reservedQuantity: 0,
            fulfilledQuantity: 0,
            batchAllocations: null
        }],
        subtotal: total,
        discount: 0,
        tax: 0,
        total,
        currency: 'iqd',
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
        isPaid: false,
        paymentStatus: initialPayment > 0 ? 'partial' : 'unpaid',
        paidAmount: initialPayment,
        balanceAmount: total - initialPayment,
        paidAt: null,
        paymentMethod: options.method,
        initialPaymentAmount: financed ? initialPayment : 0,
        linkedLoanId: null,
        isInstallmentBased: options.method === 'installments',
        installmentCount: options.method === 'installments' ? 2 : 0,
        installmentFrequency: financed ? 'monthly' : null,
        firstDueDate: financed ? options.firstDueDate ?? null : null,
        nextDueDate: financed ? options.firstDueDate ?? null : null,
        reservedAt: null,
        shippingAddress: '',
        notes: 'Order loan payment projection test',
        isLocked: false,
        sourceChannel: 'manual',
        marketplaceOrderId: null,
        createdBy: null
    }
}

function purchaseOrderInput(
    supplierId: string,
    options: {
        method: PurchaseOrder['paymentMethod']
        total?: number
        initialPayment?: number
        firstDueDate?: string | null
        installmentCount?: number
    }
): PurchaseOrderCreateInput {
    const total = options.total ?? 100
    const initialPayment = options.initialPayment ?? 0
    const financed = options.method === 'loan' || options.method === 'installments'

    return {
        businessPartnerId: supplierId,
        supplierId,
        supplierName: 'Order Supplier',
        destinationStorageId: null,
        items: [{
            id: crypto.randomUUID(),
            productId: PRODUCT_ID,
            productName: 'Test Product',
            productSku: 'TEST-001',
            quantity: 1,
            lineTotal: total,
            originalCurrency: 'usd',
            originalUnitPrice: total,
            convertedUnitPrice: total,
            settlementCurrency: 'usd',
            receivedQuantity: 0,
            batchNumber: null,
            batchSalePrice: null,
            batchExpiryDate: null,
            batchManufacturingDate: null
        }],
        subtotal: total,
        discount: 0,
        total,
        currency: 'usd',
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        exchangeRates: null,
        status: 'draft',
        expectedDeliveryDate: null,
        actualDeliveryDate: null,
        isPaid: false,
        paymentStatus: initialPayment > 0 ? 'partial' : 'unpaid',
        paidAmount: initialPayment,
        balanceAmount: total - initialPayment,
        paidAt: null,
        paymentMethod: options.method,
        initialPaymentAmount: financed ? initialPayment : 0,
        linkedLoanId: null,
        isInstallmentBased: options.method === 'installments',
        installmentCount: options.method === 'installments' ? options.installmentCount ?? 2 : 0,
        installmentFrequency: financed ? 'monthly' : null,
        firstDueDate: financed ? options.firstDueDate ?? null : null,
        nextDueDate: financed ? options.firstDueDate ?? null : null,
        notes: 'Financing integration test',
        isLocked: false,
        createdBy: null
    }
}

describe('order-linked financing', () => {
    beforeAll(async () => {
        installBrowserStorage()
        const partners = await import('./businessPartners')
        const orders = await import('./orders')
        const loans = await import('./hooks')
        const payments = await import('./payments')
        createBusinessPartner = partners.createBusinessPartner
        createSalesOrder = orders.createSalesOrder
        createCompletedSalesOrder = orders.createCompletedSalesOrder
        createPurchaseOrder = orders.createPurchaseOrder
        updateSalesOrderStatus = orders.updateSalesOrderStatus
        updatePurchaseOrderStatus = orders.updatePurchaseOrderStatus
        recordOrderPayment = orders.recordOrderPayment
        returnSalesOrder = orders.returnSalesOrder
        createPostReturnSalesOrderAdjustment = orders.createPostReturnSalesOrderAdjustment
        createProduct = loans.createProduct
        createStorage = loans.createStorage
        recordLoanPayment = loans.recordLoanPayment
        buildPaymentObligations = payments.buildPaymentObligations
        getRemainingPaymentTransactions = payments.getRemainingPaymentTransactions
        reversePaymentTransaction = payments.reversePaymentTransaction
        synchronizeOrderPaymentReferences = payments.synchronizeOrderPaymentReferences
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })

    afterEach(() => {
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
    })

    afterAll(async () => {
        await db.delete()
    })

    it('persists a note on each saved sales and purchase order line', async () => {
        const supplier = await createSupplier(null)
        const purchaseInput = purchaseOrderInput(supplier.id, { method: 'cash' })
        purchaseInput.items[0].note = 'Keep the supplier packing slip with this line.'
        const purchaseOrder = await createPurchaseOrder(WORKSPACE_ID, purchaseInput)

        expect(purchaseOrder.items[0].note).toBe('Keep the supplier packing slip with this line.')
        expect((await db.purchase_orders.get(purchaseOrder.id))?.items[0].note)
            .toBe('Keep the supplier packing slip with this line.')

        const customer = await createCustomer()
        const salesInput = salesOrderInput(customer.id, {
            id: PRODUCT_ID,
            name: 'Test Product',
            sku: 'TEST-001',
            costPrice: 50
        }, '', { method: 'cash' })
        salesInput.items[0].note = 'Deliver this line before noon.'
        const salesOrder = await createSalesOrder(WORKSPACE_ID, salesInput)

        expect(salesOrder.items[0].note).toBe('Deliver this line before noon.')
        expect((await db.sales_orders.get(salesOrder.id))?.items[0].note).toBe('Deliver this line before noon.')
    })

    it('completes quick-order style cash sales through the existing paid order lifecycle', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)
        const input = salesOrderInput(customer.id, product, storage.id, { method: 'cash', total: 100 })
        input.isPaid = true
        input.paymentStatus = 'paid'
        input.paidAmount = 100
        input.balanceAmount = 0
        input.paidAt = '2026-08-01T10:00:00.000Z'

        const completed = await createCompletedSalesOrder(WORKSPACE_ID, input)

        expect(completed).toMatchObject({
            status: 'completed',
            isPaid: true,
            paidAmount: 100,
            balanceAmount: 0,
            paymentStatus: 'paid'
        })
        expect((await db.inventory.where('[productId+storageId]').equals([product.id, storage.id]).first())?.quantity).toBe(4)
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).toArray()).toEqual([
            expect.objectContaining({
                sourceType: 'sales_order',
                paymentMethod: 'cash',
                amount: 100
            })
        ])
    })

    it('replaces a provisional quick-order payment reference with the final sales-order number', async () => {
        const orderId = crypto.randomUUID()
        await db.payment_transactions.put({
            id: crypto.randomUUID(),
            workspaceId: WORKSPACE_ID,
            sourceModule: 'orders',
            sourceType: 'sales_order',
            sourceRecordId: orderId,
            sourceSubrecordId: null,
            direction: 'incoming',
            amount: 100,
            currency: 'iqd',
            paymentMethod: 'cash',
            paidAt: '2026-08-29T10:00:00.000Z',
            counterpartyName: 'Quick-order customer',
            referenceLabel: 'SO-PENDING-CAADDE41-8CB5-44AF-AC40-7F5A0B7E8670',
            note: null,
            createdBy: null,
            reversalOfTransactionId: null,
            metadata: { orderType: 'sales' },
            createdAt: '2026-08-29T10:00:00.000Z',
            updatedAt: '2026-08-29T10:00:00.000Z',
            syncStatus: 'synced',
            lastSyncedAt: '2026-08-29T10:00:00.000Z',
            version: 1,
            isDeleted: false
        })

        await synchronizeOrderPaymentReferences(WORKSPACE_ID, 'sales', orderId, 'SO-2026-00100')

        const [payment] = await db.payment_transactions.where('sourceRecordId').equals(orderId).toArray()
        expect(payment).toMatchObject({
            referenceLabel: 'SO-2026-00100',
            version: 2
        })
    })

    it('rewrites a queued quick-order payment payload before offline sync can replay it', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'hybrid' })
        const orderId = crypto.randomUUID()
        const paymentId = crypto.randomUUID()
        const provisionalReference = 'SO-PENDING-CAADDE41-8CB5-44AF-AC40-7F5A0B7E8670'
        await db.payment_transactions.put({
            id: paymentId,
            workspaceId: WORKSPACE_ID,
            sourceModule: 'orders',
            sourceType: 'sales_order',
            sourceRecordId: orderId,
            sourceSubrecordId: null,
            direction: 'incoming',
            amount: 100,
            currency: 'iqd',
            paymentMethod: 'cash',
            paidAt: '2026-08-29T10:00:00.000Z',
            counterpartyName: 'Quick-order customer',
            referenceLabel: provisionalReference,
            note: null,
            createdBy: null,
            reversalOfTransactionId: null,
            metadata: { orderType: 'sales' },
            createdAt: '2026-08-29T10:00:00.000Z',
            updatedAt: '2026-08-29T10:00:00.000Z',
            syncStatus: 'pending',
            lastSyncedAt: null,
            version: 1,
            isDeleted: false
        })
        await db.offline_mutations.add({
            id: crypto.randomUUID(),
            workspaceId: WORKSPACE_ID,
            entityType: 'payment_transactions',
            entityId: paymentId,
            operation: 'create',
            payload: {
                id: paymentId,
                sourceRecordId: orderId,
                sourceType: 'sales_order',
                referenceLabel: provisionalReference,
                version: 1
            },
            createdAt: '2026-08-29T10:00:00.000Z',
            status: 'pending'
        })

        await synchronizeOrderPaymentReferences(
            WORKSPACE_ID,
            'sales',
            orderId,
            'SO-2026-00101',
            { deferRemoteSync: true }
        )

        const [mutation] = await db.offline_mutations.where('entityId').equals(paymentId).toArray()
        expect(mutation?.payload).toMatchObject({
            referenceLabel: 'SO-2026-00101',
            version: 2
        })
    })

    it('completes quick-order style financed sales without falsely settling them', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)

        const completed = await createCompletedSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, {
                method: 'installments',
                total: 100,
                firstDueDate: '2026-09-01'
            })
        )

        expect(completed).toMatchObject({
            status: 'completed',
            isPaid: false,
            paidAmount: 0,
            balanceAmount: 100,
            paymentStatus: 'unpaid'
        })
        expect(completed.linkedLoanId).toBeTruthy()
        expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).count()).toBe(0)
        expect((await db.inventory.where('[productId+storageId]').equals([product.id, storage.id]).first())?.quantity).toBe(4)
    })

    it('creates one standard borrowed loan and mirrors payments and reversals to the order', async () => {
        const supplier = await createSupplier(200)
        const draft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(supplier.id, {
                method: 'installments',
                initialPayment: 20,
                firstDueDate: '2026-07-15',
                installmentCount: 2
            })
        )

        expect(await db.payment_transactions.count()).toBe(1)

        const activated = await updatePurchaseOrderStatus(draft.id, 'ordered')
        expect(activated.linkedLoanId).toBeTruthy()
        expect(activated).toMatchObject({
            paidAmount: 20,
            balanceAmount: 80,
            paymentStatus: 'partial',
            isPaid: false
        })

        const loan = await db.loans.get(activated.linkedLoanId!)
        expect(loan).toMatchObject({
            source: 'order',
            orderId: draft.id,
            orderType: 'purchase',
            direction: 'borrowed',
            loanCategory: 'standard',
            principalAmount: 80,
            balanceAmount: 80,
            installmentCount: 2
        })
        const installments = await db.loan_installments.where('loanId').equals(loan!.id).sortBy('installmentNo')
        expect(installments.map((item) => item.plannedAmount)).toEqual([40, 40])
        expect(await db.order_installments.where('orderId').equals(draft.id).count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(1)

        await recordLoanPayment(WORKSPACE_ID, {
            loanId: loan!.id,
            amount: 30,
            paymentMethod: 'cash',
            paidAt: '2026-07-15T12:00:00.000Z'
        })
        expect(await db.purchase_orders.get(draft.id)).toMatchObject({
            paidAmount: 50,
            balanceAmount: 50,
            paymentStatus: 'partial',
            isPaid: false
        })

        const paymentTransaction = (await db.payment_transactions
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .and((item) => item.sourceRecordId === loan!.id && !item.reversalOfTransactionId)
            .toArray())[0]
        expect(paymentTransaction?.sourceType).toBe('loan_installment')

        await reversePaymentTransaction(WORKSPACE_ID, paymentTransaction.id)
        expect(await db.purchase_orders.get(draft.id)).toMatchObject({
            paidAmount: 20,
            balanceAmount: 80,
            paymentStatus: 'partial',
            isPaid: false
        })
    })

    it('posts simple order-loan initial payments as loan repayments for sales and purchases', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)
        const salesDraft = await createSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, {
                method: 'loan',
                total: 100,
                initialPayment: 20
            })
        )

        expect((await db.payment_transactions.where('sourceRecordId').equals(salesDraft.id).toArray())).toHaveLength(0)

        const reservedSalesOrder = await updateSalesOrderStatus(salesDraft.id, 'pending')
        const salesLoan = await db.loans.get(reservedSalesOrder.linkedLoanId!)
        const salesLoanPayments = await db.loan_payments.where('loanId').equals(salesLoan!.id).toArray()
        const salesTransactions = await db.payment_transactions
            .where('[workspaceId+sourceType+sourceRecordId]')
            .equals([WORKSPACE_ID, 'simple_loan', salesLoan!.id])
            .toArray()

        expect(salesLoan).toMatchObject({
            direction: 'lent',
            loanCategory: 'simple',
            principalAmount: 100,
            totalPaidAmount: 20,
            balanceAmount: 80
        })
        expect(salesLoanPayments).toHaveLength(1)
        expect(salesLoanPayments[0]).toMatchObject({ amount: 20, paymentMethod: 'cash' })
        expect(salesTransactions).toHaveLength(1)
        expect(salesTransactions[0]).toMatchObject({
            direction: 'incoming',
            amount: 20,
            sourceSubrecordId: salesLoanPayments[0].id,
            metadata: expect.objectContaining({
                loanPaymentId: salesLoanPayments[0].id,
                isOrderLoanInitialRepayment: true
            })
        })
        expect(await db.sales_orders.get(reservedSalesOrder.id)).toMatchObject({
            paidAmount: 20,
            balanceAmount: 80,
            paymentStatus: 'partial'
        })

        const supplier = await createSupplier(null)
        const purchaseDraft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(supplier.id, {
                method: 'loan',
                total: 100,
                initialPayment: 20
            })
        )
        const orderedPurchaseOrder = await updatePurchaseOrderStatus(purchaseDraft.id, 'ordered')
        const purchaseLoan = await db.loans.get(orderedPurchaseOrder.linkedLoanId!)
        const purchaseLoanPayments = await db.loan_payments.where('loanId').equals(purchaseLoan!.id).toArray()
        const purchaseTransactions = await db.payment_transactions
            .where('[workspaceId+sourceType+sourceRecordId]')
            .equals([WORKSPACE_ID, 'simple_loan', purchaseLoan!.id])
            .toArray()

        expect(purchaseLoan).toMatchObject({
            direction: 'borrowed',
            principalAmount: 100,
            totalPaidAmount: 20,
            balanceAmount: 80
        })
        expect(purchaseLoanPayments).toHaveLength(1)
        expect(purchaseTransactions).toHaveLength(1)
        expect(purchaseTransactions[0]).toMatchObject({
            direction: 'outgoing',
            amount: 20,
            sourceSubrecordId: purchaseLoanPayments[0].id
        })
        expect(await db.purchase_orders.get(orderedPurchaseOrder.id)).toMatchObject({
            paidAmount: 20,
            balanceAmount: 80,
            paymentStatus: 'partial'
        })
    })

    it('reverses a standard order payment when cancelling the order', async () => {
        const supplier = await createSupplier(200)
        const draft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(supplier.id, { method: 'cash', total: 100 })
        )

        await recordOrderPayment(WORKSPACE_ID, {
            orderType: 'purchase',
            orderId: draft.id,
            amount: 100,
            paymentMethod: 'cash',
            paidAt: '2026-07-12T10:00:00.000Z'
        })

        await updatePurchaseOrderStatus(draft.id, 'ordered')
        const cancelled = await updatePurchaseOrderStatus(draft.id, 'cancelled')
        const payments = await db.payment_transactions.where('sourceRecordId').equals(draft.id).toArray()

        expect(cancelled).toMatchObject({
            status: 'cancelled',
            isPaid: false,
            paidAmount: 0,
            balanceAmount: 100,
            paymentStatus: 'unpaid'
        })
        expect(payments.map((payment) => payment.amount).sort((left, right) => left - right)).toEqual([-100, 100])
        expect(payments.find((payment) => !!payment.reversalOfTransactionId)?.note).toBe(`Order ${draft.orderNumber} cancelled`)
    })

    it('reverses down payments and installment payments before cancelling a financed order', async () => {
        const supplier = await createSupplier(200)
        const draft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(supplier.id, {
                method: 'installments',
                total: 100,
                initialPayment: 20,
                firstDueDate: '2026-07-15',
                installmentCount: 2
            })
        )
        const ordered = await updatePurchaseOrderStatus(draft.id, 'ordered')
        const loanId = ordered.linkedLoanId!

        await recordLoanPayment(WORKSPACE_ID, {
            loanId,
            amount: 30,
            paymentMethod: 'cash',
            paidAt: '2026-07-15T12:00:00.000Z'
        })

        const cancelled = await updatePurchaseOrderStatus(draft.id, 'cancelled')
        const payments = await db.payment_transactions.where('workspaceId').equals(WORKSPACE_ID).toArray()

        expect(cancelled).toMatchObject({
            status: 'cancelled',
            linkedLoanId: null,
            isPaid: false,
            initialPaymentAmount: 0,
            paidAmount: 0,
            balanceAmount: 100,
            paymentStatus: 'unpaid'
        })
        expect(await db.loans.get(loanId)).toMatchObject({ isDeleted: true })
        expect(await db.loan_payments.where('loanId').equals(loanId).and((payment) => !payment.isDeleted).count()).toBe(0)
        expect(payments.filter((payment) => !payment.isDeleted && payment.reversalOfTransactionId).map((payment) => payment.amount).sort((left, right) => left - right)).toEqual([-30, -20])
    })

    it('creates and accepts payments for a simple loan with a blank due-date entry', async () => {
        const supplier = await createSupplier(null)
        const draft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(supplier.id, { method: 'loan', total: 75 })
        )
        const activated = await updatePurchaseOrderStatus(draft.id, 'ordered')
        const loan = await db.loans.get(activated.linkedLoanId!)

        expect(loan).toMatchObject({
            loanCategory: 'simple',
            firstDueDate: null,
            nextDueDate: null,
            installmentCount: 1,
            principalAmount: 75
        })
        const undatedSchedule = await db.loan_installments.where('loanId').equals(loan!.id).toArray()
        expect(undatedSchedule).toHaveLength(1)
        expect(undatedSchedule[0]).toMatchObject({
            installmentNo: 1,
            dueDate: null,
            plannedAmount: 75,
            paidAmount: 0,
            balanceAmount: 75,
            status: 'unpaid'
        })

        await recordLoanPayment(WORKSPACE_ID, {
            loanId: loan!.id,
            amount: 25,
            paymentMethod: 'cash'
        })
        expect(await db.loans.get(loan!.id)).toMatchObject({ totalPaidAmount: 25, balanceAmount: 50 })
        expect(await db.loan_installments.get(undatedSchedule[0].id)).toMatchObject({
            paidAmount: 25,
            balanceAmount: 50,
            status: 'partial'
        })
        expect(await db.purchase_orders.get(draft.id)).toMatchObject({ paidAmount: 25, balanceAmount: 50 })

        const datedDraft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(supplier.id, {
                method: 'loan',
                total: 60,
                firstDueDate: '2026-08-20'
            })
        )
        const datedOrder = await updatePurchaseOrderStatus(datedDraft.id, 'ordered')
        const datedLoan = await db.loans.get(datedOrder.linkedLoanId!)
        const datedSchedule = await db.loan_installments.where('loanId').equals(datedLoan!.id).toArray()
        expect(datedLoan).toMatchObject({
            loanCategory: 'simple',
            firstDueDate: '2026-08-20',
            nextDueDate: '2026-08-20',
            installmentCount: 1
        })
        expect(datedSchedule).toHaveLength(1)
        expect(datedSchedule[0]).toMatchObject({ dueDate: '2026-08-20', plannedAmount: 60 })
    })

    it('shows a sales order loan as one order loan open item', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct()
        const draft = await createSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, { method: 'loan' })
        )

        const pendingOrder = await updateSalesOrderStatus(draft.id, 'pending')
        expect(pendingOrder.linkedLoanId).toBeTruthy()

        const obligations = await buildPaymentObligations(WORKSPACE_ID, {})
        const orderLoanObligation = obligations.find((item) =>
            item.sourceType === 'simple_loan'
            && item.metadata?.orderId === pendingOrder.id
            && item.metadata?.orderType === 'sales'
        )

        expect(orderLoanObligation).toMatchObject({
            sourceModule: 'loans',
            sourceType: 'simple_loan',
            amount: 15000,
            subtitle: 'Order loan balance',
            metadata: expect.objectContaining({
                displaySourceLabel: 'order_loan',
                orderId: pendingOrder.id,
                orderType: 'sales'
            })
        })
        expect(obligations.filter((item) =>
            item.sourceType === 'sales_order' && item.sourceRecordId === pendingOrder.id
        )).toHaveLength(0)
        expect(obligations.filter((item) =>
            item.sourceRecordId === pendingOrder.id || item.metadata?.orderId === pendingOrder.id
        )).toHaveLength(1)
    })

    it('records fractional IQD order payments against old rounded balances', async () => {
        const customer = await createCustomer()
        const order = salesOrderWithStaleRoundedBalance(customer.id)
        await db.sales_orders.put(order)

        await recordOrderPayment(WORKSPACE_ID, {
            orderType: 'sales',
            orderId: order.id,
            amount: 688.5,
            paymentMethod: 'cash',
            paidAt: '2026-06-28T16:08:00.000Z'
        })

        expect(await db.sales_orders.get(order.id)).toMatchObject({
            paidAmount: 688.5,
            balanceAmount: 0,
            paymentStatus: 'paid',
            isPaid: true
        })
        expect(await db.payment_transactions.where('sourceRecordId').equals(order.id).count()).toBe(1)
    })

    it('repairs an order if a stale rounded payment exists from a failed attempt', async () => {
        const customer = await createCustomer()
        const order = salesOrderWithStaleRoundedBalance(customer.id)
        await db.sales_orders.put(order)
        await db.payment_transactions.put({
            id: crypto.randomUUID(),
            workspaceId: WORKSPACE_ID,
            sourceModule: 'orders',
            sourceType: 'sales_order',
            sourceRecordId: order.id,
            sourceSubrecordId: null,
            direction: 'incoming',
            amount: 689,
            currency: 'iqd',
            paymentMethod: 'cash',
            paidAt: '2026-06-28T16:08:00.000Z',
            counterpartyName: order.customerName,
            referenceLabel: order.orderNumber,
            note: null,
            createdBy: null,
            reversalOfTransactionId: null,
            metadata: { orderType: 'sales' },
            createdAt: '2026-06-28T16:08:00.000Z',
            updatedAt: '2026-06-28T16:08:00.000Z',
            syncStatus: 'synced',
            lastSyncedAt: '2026-06-28T16:08:00.000Z',
            version: 1,
            isDeleted: false
        })

        await recordOrderPayment(WORKSPACE_ID, {
            orderType: 'sales',
            orderId: order.id,
            amount: 688.5,
            paymentMethod: 'cash',
            paidAt: '2026-06-28T16:09:00.000Z'
        })

        expect(await db.sales_orders.get(order.id)).toMatchObject({
            paidAmount: 688.5,
            balanceAmount: 0,
            paymentStatus: 'paid',
            isPaid: true
        })
        const transactions = await db.payment_transactions.where('sourceRecordId').equals(order.id).toArray()
        expect(transactions).toHaveLength(1)
        expect(transactions[0].amount).toBe(688.5)
    })

    it('collapses duplicate failed full-payment attempts before rebuilding the order', async () => {
        const customer = await createCustomer()
        const order = salesOrderWithStaleRoundedBalance(customer.id)
        await db.sales_orders.put(order)
        const basePayment = {
            workspaceId: WORKSPACE_ID,
            sourceModule: 'orders' as const,
            sourceType: 'sales_order' as const,
            sourceRecordId: order.id,
            sourceSubrecordId: null,
            direction: 'incoming' as const,
            currency: 'iqd' as const,
            paymentMethod: 'cash' as const,
            paidAt: '2026-06-28T16:08:00.000Z',
            counterpartyName: order.customerName,
            referenceLabel: order.orderNumber,
            note: null,
            createdBy: null,
            reversalOfTransactionId: null,
            metadata: { orderType: 'sales' },
            createdAt: '2026-06-28T16:08:00.000Z',
            updatedAt: '2026-06-28T16:08:00.000Z',
            syncStatus: 'synced' as const,
            lastSyncedAt: '2026-06-28T16:08:00.000Z',
            version: 1,
            isDeleted: false
        }
        await db.payment_transactions.bulkPut([
            { ...basePayment, id: crypto.randomUUID(), amount: 689 },
            { ...basePayment, id: crypto.randomUUID(), amount: 688.5, paidAt: '2026-06-28T16:09:00.000Z' }
        ])

        await recordOrderPayment(WORKSPACE_ID, {
            orderType: 'sales',
            orderId: order.id,
            amount: 688.5,
            paymentMethod: 'cash',
            paidAt: '2026-06-28T16:10:00.000Z'
        })

        expect(await db.sales_orders.get(order.id)).toMatchObject({
            paidAmount: 688.5,
            balanceAmount: 0,
            paymentStatus: 'paid',
            isPaid: true
        })
        const transactions = await db.payment_transactions.where('sourceRecordId').equals(order.id).toArray()
        expect(transactions.filter((transaction) => !transaction.isDeleted)).toHaveLength(1)
        expect(transactions.find((transaction) => !transaction.isDeleted)?.amount).toBe(688.5)
        expect(transactions.filter((transaction) => transaction.isDeleted)).toHaveLength(1)
    })

    it('posts a partial return for a completed paid sales order and reverses only the returned payment value', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)
        const draft = await createSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, { method: 'cash', total: 100 })
        )
        await recordOrderPayment(WORKSPACE_ID, {
            orderType: 'sales',
            orderId: draft.id,
            amount: 100,
            paymentMethod: 'cash',
            paidAt: '2026-07-12T10:00:00.000Z'
        })
        await updateSalesOrderStatus(draft.id, 'pending')
        const completed = await updateSalesOrderStatus(draft.id, 'completed')

        const result = await returnSalesOrder({
            orderId: completed.id,
            items: [{ orderItemId: completed.items[0].id, quantity: 0.5 }],
            reason: 'customer_returned',
            actorRole: 'admin'
        })

        expect(result.order).toMatchObject({
            status: 'completed',
            total: 50,
            returnedAmount: 50,
            returnStatus: 'partial',
            paidAmount: 50,
            balanceAmount: 0,
            isPaid: true
        })
        expect(await db.order_returns.where('orderId').equals(completed.id).count()).toBe(1)
        expect(await db.order_return_items.where('orderId').equals(completed.id).first()).toMatchObject({
            quantity: 0.5,
            refundAmount: 50,
            restoredStorageId: storage.id
        })
        const payments = await db.payment_transactions.where('sourceRecordId').equals(completed.id).toArray()
        expect(payments.map((payment) => payment.amount).sort((left, right) => left - right)).toEqual([-50, 100])
        expect(getRemainingPaymentTransactions(payments)).toEqual([
            expect.objectContaining({ amount: 50 })
        ])
        expect((await db.inventory.where('[productId+storageId]').equals([product.id, storage.id]).first())?.quantity).toBe(4.5)
    })

    it('rejects a return before changing any data when the caller is not an admin', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)
        const draft = await createSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, { method: 'cash', total: 100 })
        )
        await recordOrderPayment(WORKSPACE_ID, {
            orderType: 'sales',
            orderId: draft.id,
            amount: 100,
            paymentMethod: 'cash',
            paidAt: '2026-07-12T10:00:00.000Z'
        })
        await updateSalesOrderStatus(draft.id, 'pending')
        const completed = await updateSalesOrderStatus(draft.id, 'completed')

        await expect(returnSalesOrder({
            orderId: completed.id,
            items: [{ orderItemId: completed.items[0].id, quantity: 1 }],
            reason: 'customer_returned',
            actorRole: 'staff'
        })).rejects.toThrow('Only admins')

        expect(await db.order_returns.where('orderId').equals(completed.id).count()).toBe(0)
        expect((await db.sales_orders.get(completed.id))?.total).toBe(100)
    })

    it('adds an immutable adjustment linked to a posted return without rewriting the return record', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)
        const draft = await createSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, { method: 'cash', total: 100 })
        )
        await recordOrderPayment(WORKSPACE_ID, {
            orderType: 'sales', orderId: draft.id, amount: 100, paymentMethod: 'cash', paidAt: '2026-08-20T10:00:00.000Z'
        })
        await updateSalesOrderStatus(draft.id, 'pending')
        const completed = await updateSalesOrderStatus(draft.id, 'completed')
        const returned = await returnSalesOrder({
            orderId: completed.id,
            items: [{ orderItemId: completed.items[0].id, quantity: 0.5 }],
            reason: 'customer_returned',
            actorRole: 'admin'
        })

        await expect(createPostReturnSalesOrderAdjustment({
            orderId: returned.order.id,
            returnId: returned.return.id,
            adjustment: { id: 'staff-attempt', type: 'addition', name: 'Restocking', currency: returned.order.currency, amount: '5' },
            actorRole: 'staff'
        })).rejects.toThrow('Only admins')

        const result = await createPostReturnSalesOrderAdjustment({
            orderId: returned.order.id,
            returnId: returned.return.id,
            adjustment: { id: 'restocking', type: 'addition', name: 'Restocking', currency: returned.order.currency, amount: '5' },
            notes: 'Opened packaging',
            createdBy: 'admin-1',
            actorRole: 'admin'
        })

        expect(result.adjustment).toMatchObject({
            id: 'restocking', scope: 'post_return', returnId: returned.return.id, notes: 'Opened packaging', createdBy: 'admin-1'
        })
        expect(result.order.total).toBe(50)
        expect((await db.order_returns.get(returned.return.id))?.refundAmount).toBe(50)
        expect((await db.sales_orders.get(returned.order.id))?.orderAdjustments).toEqual([
            expect.objectContaining({ id: 'restocking', scope: 'post_return', returnId: returned.return.id })
        ])
    })

    it('reduces an outstanding order loan before refunding paid money', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)
        const draft = await createSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, {
                method: 'installments',
                total: 100,
                initialPayment: 20,
                firstDueDate: '2026-08-01'
            })
        )
        const pending = await updateSalesOrderStatus(draft.id, 'pending')
        const completed = await updateSalesOrderStatus(pending.id, 'completed')

        await returnSalesOrder({
            orderId: completed.id,
            items: [{ orderItemId: completed.items[0].id, quantity: 0.25 }],
            reason: 'customer_returned',
            actorRole: 'admin'
        })

        const loan = await db.loans.get(completed.linkedLoanId!)
        expect(loan).toMatchObject({ principalAmount: 55, totalPaidAmount: 0, balanceAmount: 55 })
        expect(await db.sales_orders.get(completed.id)).toMatchObject({
            total: 75,
            initialPaymentAmount: 20,
            paidAmount: 20,
            balanceAmount: 55,
            paymentStatus: 'partial'
        })
    })

    it('records an unmapped sales-order loan refund as a positive outgoing cash transaction', async () => {
        const customer = await createCustomer()
        const { storage, product } = await createStockedSalesProduct(100)
        const draft = await createSalesOrder(
            WORKSPACE_ID,
            salesOrderInput(customer.id, product, storage.id, {
                method: 'installments',
                total: 100,
                initialPayment: 0,
                firstDueDate: '2026-08-01'
            })
        )
        const pending = await updateSalesOrderStatus(draft.id, 'pending')
        const completed = await updateSalesOrderStatus(pending.id, 'completed')

        await recordLoanPayment(WORKSPACE_ID, {
            loanId: completed.linkedLoanId!,
            amount: 30,
            paymentMethod: 'cash',
            paidAt: '2026-08-02T10:00:00.000Z'
        })

        const recordedLoanPayment = await db.payment_transactions
            .where('sourceRecordId')
            .equals(completed.linkedLoanId!)
            .first()
        expect(recordedLoanPayment).toMatchObject({
            metadata: expect.objectContaining({
                displaySourceLabel: 'order_loan',
                orderId: completed.id,
                orderType: 'sales'
            })
        })
        await db.payment_transactions.delete(recordedLoanPayment!.id)

        await returnSalesOrder({
            orderId: completed.id,
            items: [{ orderItemId: completed.items[0].id, quantity: 0.75 }],
            reason: 'customer_returned',
            actorRole: 'admin'
        })

        const fallbackRefund = await db.payment_transactions
            .where('workspaceId')
            .equals(WORKSPACE_ID)
            .and((transaction) => transaction.sourceType === 'order_return' && transaction.metadata?.loanRepaymentRefund === true)
            .first()
        expect(fallbackRefund).toMatchObject({
            direction: 'outgoing',
            amount: 5,
            metadata: expect.objectContaining({
                orderId: completed.id,
                loanRepaymentRefund: true
            })
        })
    })

    it('enforces the payable credit limit and requires regular tenders to be fully paid', async () => {
        const limitedSupplier = await createSupplier(50)
        const financedDraft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(limitedSupplier.id, { method: 'loan', total: 80 })
        )

        await expect(updatePurchaseOrderStatus(financedDraft.id, 'ordered')).rejects.toThrow('credit_limit_exceeded')
        expect((await db.purchase_orders.get(financedDraft.id))?.status).toBe('draft')
        expect(await db.loans.where('orderId').equals(financedDraft.id).count()).toBe(0)

        const unlimitedSupplier = await createSupplier(null)
        const unpaidCashDraft = await createPurchaseOrder(
            WORKSPACE_ID,
            purchaseOrderInput(unlimitedSupplier.id, { method: 'cash', total: 80 })
        )
        await expect(updatePurchaseOrderStatus(unpaidCashDraft.id, 'ordered')).rejects.toThrow('non_financed_order_must_be_paid')
    })
})
