import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { STANDARD_PAYMENT_METHODS, ORDER_FINANCING_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { SERVICES_VIRTUAL_STORAGE_ID } from '@/lib/catalogItem'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { saleOrderInput, seededCases, TEST_TIME, TEST_WORKSPACE_ID } from '../fixtures/saleOrder'
import { assertOrderFinancialEffects, assertStock } from '../assertions/saleOrders'

// No scenario in this file is allowed to contact an actual backend, even when
// run with ordinary npm test rather than the dev controller's network guard.
vi.mock('@/auth/supabase', () => {
    const remote = () => { throw new Error('Unexpected remote request in a Local business scenario') }
    return { supabase: { schema: () => ({ from: remote }), from: remote, rpc: remote } }
})

let orders: typeof import('@/local-db/orders')
let hooks: typeof import('@/local-db/hooks')
let partners: typeof import('@/local-db/businessPartners')
let accounts: typeof import('@/local-db/paymentAccounts')
let payments: typeof import('@/local-db/payments')

async function arrange(currency: 'usd' | 'iqd' = 'usd') {
    const customer = await partners.createBusinessPartner(TEST_WORKSPACE_ID, {
        partnerName: 'Scenario Customer', phone: '07500000000', defaultCurrency: currency,
        creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
    })
    const storage = await hooks.createStorage(TEST_WORKSPACE_ID, { name: 'Disposable Stock' })
    const product = await hooks.createProduct(TEST_WORKSPACE_ID, {
        sku: 'DEV-SALE', name: 'Scenario Product', description: '',
        categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
        price: 100, costPrice: 40, quantity: 10, minStockLevel: 0, unit: 'pcs', currency,
        barcode: '', barcodes: [], imageUrl: '', canBeReturned: true, returnRules: '', createdBy: null
    })
    return { customer, storage, product }
}

describe('Sale Orders developer scenarios', () => {
    beforeAll(async () => {
        installTestBrowser()
        orders = await import('@/local-db/orders')
        hooks = await import('@/local-db/hooks')
        partners = await import('@/local-db/businessPartners')
        accounts = await import('@/local-db/paymentAccounts')
        payments = await import('@/local-db/payments')
    }, 30_000)
    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: TEST_WORKSPACE_ID, dataMode: 'local' })
    })
    afterEach(() => clearWorkspaceModeSnapshot(TEST_WORKSPACE_ID))
    afterAll(async () => { await db.delete() })

    for (const method of STANDARD_PAYMENT_METHODS) {
        for (const currency of ['usd', 'iqd'] as const) {
            for (const withAccount of [false, true]) {
                it(`${method} / ${currency} / ${withAccount ? 'selected account' : 'no account'}: draft → payment → pending → completed → reload`, async () => {
                    const { customer, storage, product } = await arrange(currency)
                    const account = withAccount ? await accounts.savePaymentAccount(TEST_WORKSPACE_ID, {
                        name: 'Scenario Account', accountType: 'cash_drawer', openingBalances: []
                    }) : null
                    const draft = await orders.createSalesOrder(TEST_WORKSPACE_ID,
                        saleOrderInput(customer.id, product, storage.id, method, { currency }))
                    expect(await db.payment_transactions.count(), 'unpaid draft creates no payment').toBe(0)
                    await assertStock(product.id, storage.id, 10)
                    await orders.recordOrderPayment(TEST_WORKSPACE_ID, {
                        orderType: 'sales', orderId: draft.id, amount: 100, paymentMethod: method, paidAt: TEST_TIME,
                        accountId: account?.id ?? null, accountNameSnapshot: account?.name ?? null
                    })
                    await orders.updateSalesOrderStatus(draft.id, 'pending')
                    await assertStock(product.id, storage.id, 10)
                    const completed = await orders.updateSalesOrderStatus(draft.id, 'completed')
                    expect(completed.status).toBe('completed')
                    await db.close()
                    await db.open()
                    const transactions = await assertOrderFinancialEffects(draft.id, 100, 0)
                    expect(transactions).toHaveLength(1)
                    expect(transactions[0].paymentMethod).toBe(method)
                    await assertStock(product.id, storage.id, 9)
                    const movements = await db.payment_account_movements.toArray()
                    expect(movements).toHaveLength(withAccount ? 1 : 0)
                    if (account) {
                        expect(movements[0]).toMatchObject({ accountId: account.id, paymentTransactionId: transactions[0].id })
                        const balance = await db.payment_account_balances.where('accountId').equals(account.id).first()
                        expect(balance?.balanceAmount).toBe(100)
                    }
                })
            }
        }

        it(`${method}: paid Quick Order completes with exactly one payment and one stock deduction`, async () => {
            const { customer, storage, product } = await arrange()
            const order = await orders.createCompletedSalesOrder(TEST_WORKSPACE_ID,
                saleOrderInput(customer.id, product, storage.id, method, { paid: true }))
            expect(order.status).toBe('completed')
            expect(await assertOrderFinancialEffects(order.id, 100, 0)).toHaveLength(1)
            await assertStock(product.id, storage.id, 9)
        })

        it(`${method}: partial return keeps original payment and exact linked counter-entry`, async () => {
            const { customer, storage, product } = await arrange()
            const order = await orders.createCompletedSalesOrder(TEST_WORKSPACE_ID,
                saleOrderInput(customer.id, product, storage.id, method, { paid: true }))
            await orders.returnSalesOrder({ orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 0.5 }], reason: 'customer_returned', actorRole: 'admin' })
            const transactions = await assertOrderFinancialEffects(order.id, 50, 0)
            expect(transactions.map((row) => row.amount).sort((a, b) => a - b)).toEqual([-50, 100])
            expect(await db.order_returns.where('orderId').equals(order.id).count()).toBe(1)
            await assertStock(product.id, storage.id, 9.5)
            await orders.returnSalesOrder({ orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 0.5 }], reason: 'customer_returned', actorRole: 'admin' })
            await assertOrderFinancialEffects(order.id, 0, 0)
            await assertStock(product.id, storage.id, 10)
        })

        it(`${method}: cancelling a paid draft retains a zero-net ledger audit trail`, async () => {
            const { customer, storage, product } = await arrange()
            const order = await orders.createSalesOrder(TEST_WORKSPACE_ID,
                saleOrderInput(customer.id, product, storage.id, method, { paid: true }))
            await orders.updateSalesOrderStatus(order.id, 'cancelled')
            const transactions = await db.payment_transactions.where('sourceRecordId').equals(order.id).toArray()
            expect(transactions.map((row) => row.amount).sort((a, b) => a - b)).toEqual([-100, 100])
            expect(transactions.find((row) => row.amount < 0)?.reversalOfTransactionId).toBe(transactions.find((row) => row.amount > 0)?.id)
            await assertStock(product.id, storage.id, 10)
        })

        it(`${method}: rejects overpayment without changing order, ledger, or inventory`, async () => {
            const { customer, storage, product } = await arrange()
            const order = await orders.createSalesOrder(TEST_WORKSPACE_ID, saleOrderInput(customer.id, product, storage.id, method))
            await expect(orders.recordOrderPayment(TEST_WORKSPACE_ID, { orderType: 'sales', orderId: order.id, amount: 101, paymentMethod: method, paidAt: TEST_TIME })).rejects.toThrow()
            expect(await db.payment_transactions.count()).toBe(0)
            await assertOrderFinancialEffects(order.id, 0, 100)
            await assertStock(product.id, storage.id, 10)
        })

        it(`${method}: partial payments reconcile and an unpaid regular order cannot reserve stock`, async () => {
            const { customer, storage, product } = await arrange()
            const order = await orders.createSalesOrder(TEST_WORKSPACE_ID, saleOrderInput(customer.id, product, storage.id, method))
            await expect(orders.updateSalesOrderStatus(order.id, 'pending')).rejects.toThrow()
            await orders.recordOrderPayment(TEST_WORKSPACE_ID, { orderType: 'sales', orderId: order.id, amount: 25, paymentMethod: method, paidAt: TEST_TIME })
            await assertOrderFinancialEffects(order.id, 25, 75)
            await expect(orders.updateSalesOrderStatus(order.id, 'pending')).rejects.toThrow()
            await orders.recordOrderPayment(TEST_WORKSPACE_ID, { orderType: 'sales', orderId: order.id, amount: 75, paymentMethod: method, paidAt: TEST_TIME })
            await orders.updateSalesOrderStatus(order.id, 'pending')
            await orders.updateSalesOrderStatus(order.id, 'completed')
            expect(await assertOrderFinancialEffects(order.id, 100, 0)).toHaveLength(2)
            await assertStock(product.id, storage.id, 9)
        })

        it(`${method}: approving a paid order request posts one payment, while the request itself posts none`, async () => {
            const { customer, storage, product } = await arrange()
            const request = await orders.createSalesOrder(TEST_WORKSPACE_ID, {
                ...saleOrderInput(customer.id, product, storage.id, method, { paid: true }),
                approvalStatus: 'requested', approvalRequestedAt: TEST_TIME
            })
            expect(await db.payment_transactions.count()).toBe(0)
            await assertStock(product.id, storage.id, 10)
            await orders.approveSalesOrderRequest(request.id)
            expect(await assertOrderFinancialEffects(request.id, 100, 0)).toHaveLength(1)
            await expect(orders.approveSalesOrderRequest(request.id)).rejects.toThrow()
            expect(await db.payment_transactions.count()).toBe(1)
        })
    }

    for (const method of ORDER_FINANCING_PAYMENT_METHODS) {
        for (const initialPayment of [0, 25]) {
            it(`${method} / down payment ${initialPayment}: activation creates one linked loan without pretending it is paid`, async () => {
                const { customer, storage, product } = await arrange()
                const order = await orders.createCompletedSalesOrder(TEST_WORKSPACE_ID,
                    saleOrderInput(customer.id, product, storage.id, method, { initialPayment }))
                expect(order).toMatchObject({ status: 'completed', isPaid: false, paidAmount: initialPayment, balanceAmount: 100 - initialPayment })
                const loans = await db.loans.where('orderId').equals(order.id).toArray()
                expect(loans).toHaveLength(1)
                expect(order.linkedLoanId).toBe(loans[0].id)
                await assertStock(product.id, storage.id, 9)
                expect((await db.payment_transactions.toArray()).reduce((sum, row) => sum + row.amount, 0)).toBe(initialPayment)
                const installments = await db.loan_installments.where('loanId').equals(loans[0].id).toArray()
                if (method === 'installments') expect(installments.reduce((sum, row) => sum + row.plannedAmount, 0)).toBe(100 - initialPayment)
            })
        }
        it(`${method}: rejects a Quick Order marked fully paid before any mutation`, async () => {
            const { customer, storage, product } = await arrange()
            await expect(orders.createCompletedSalesOrder(TEST_WORKSPACE_ID,
                saleOrderInput(customer.id, product, storage.id, method, { paid: true }))).rejects.toThrow()
            expect(await db.sales_orders.count()).toBe(0)
            expect(await db.payment_transactions.count()).toBe(0)
            await assertStock(product.id, storage.id, 10)
        })
    }

    for (const status of ['draft', 'pending', 'completed'] as const) {
        it(`unpaid Quick Order / ${status}: records an obligation without a payment`, async () => {
            const { customer, storage, product } = await arrange()
            const order = await orders.createQuickSalesOrder(TEST_WORKSPACE_ID, {
                ...saleOrderInput(customer.id, product, storage.id, 'cash'), status
            })
            expect(order.status).toBe(status)
            expect(await db.payment_transactions.count()).toBe(0)
            await assertOrderFinancialEffects(order.id, 0, 100)
            await assertStock(product.id, storage.id, status === 'completed' ? 9 : 10)
        })
    }

    it('stable operation IDs prevent duplicate order and initial payment on a repeated save', async () => {
        const { customer, storage, product } = await arrange()
        const input = saleOrderInput(customer.id, product, storage.id, 'cash', { paid: true })
        const options = { orderId: crypto.randomUUID(), paymentTransactionId: crypto.randomUUID() }
        const first = await orders.createSalesOrder(TEST_WORKSPACE_ID, input, null, options)
        const retry = await orders.createSalesOrder(TEST_WORKSPACE_ID, input, null, options)
        expect(retry.id).toBe(first.id)
        expect(await db.sales_orders.count()).toBe(1)
        expect(await assertOrderFinancialEffects(first.id, 100, 0)).toHaveLength(1)
        await assertStock(product.id, storage.id, 10)
    })

    it('rejects a duplicate partial reversal above the remaining amount', async () => {
        const { customer, storage, product } = await arrange()
        const order = await orders.createSalesOrder(TEST_WORKSPACE_ID, saleOrderInput(customer.id, product, storage.id, 'cash', { paid: true }))
        const [transaction] = await db.payment_transactions.where('sourceRecordId').equals(order.id).toArray()
        await payments.reversePaymentTransaction(TEST_WORKSPACE_ID, transaction.id, { amount: 75 })
        await expect(payments.reversePaymentTransaction(TEST_WORKSPACE_ID, transaction.id, { amount: 50 })).rejects.toThrow()
        await assertOrderFinancialEffects(order.id, 25, 75)
    })

    it('service checkout records its payment without reserving or deducting physical stock', async () => {
        const { customer, storage, product } = await arrange()
        const service = { ...product, isService: true, costPrice: 0, storageId: null, quantity: 0 }
        await db.products.put(service)
        const input = saleOrderInput(customer.id, service, SERVICES_VIRTUAL_STORAGE_ID, 'cash', { paid: true })
        input.sourceStorageId = null
        input.items[0].costPrice = 0
        input.items[0].convertedCostPrice = 0
        const order = await orders.createCompletedSalesOrder(TEST_WORKSPACE_ID, input)
        expect(order.status).toBe('completed')
        expect(await assertOrderFinancialEffects(order.id, 100, 0)).toHaveLength(1)
        await assertStock(product.id, storage.id, 10)
    })

    it('an unpaid draft can be edited and soft-deleted without creating payments or stock movements', async () => {
        const { customer, storage, product } = await arrange()
        const order = await orders.createSalesOrder(TEST_WORKSPACE_ID, saleOrderInput(customer.id, product, storage.id, 'cash'))
        const edited = await orders.updateSalesOrder(order.id, { notes: 'Edited scenario', ...saleOrderInput(customer.id, product, storage.id, 'cash', { quantity: 2 }) })
        expect(edited.total).toBe(200)
        await assertOrderFinancialEffects(order.id, 0, 200)
        await orders.deleteSalesOrder(order.id)
        expect((await db.sales_orders.get(order.id))?.isDeleted).toBe(true)
        expect(await db.payment_transactions.count()).toBe(0)
        await assertStock(product.id, storage.id, 10)
    })

    it('locked orders and mismatched workspaces reject payment without posting a transaction', async () => {
        const { customer, storage, product } = await arrange()
        const order = await orders.createSalesOrder(TEST_WORKSPACE_ID, saleOrderInput(customer.id, product, storage.id, 'cash'))
        const payment = { orderType: 'sales' as const, orderId: order.id, amount: 100, paymentMethod: 'cash' as const, paidAt: TEST_TIME }
        await expect(orders.recordOrderPayment('other-workspace', payment)).rejects.toThrow()
        await db.sales_orders.update(order.id, { isLocked: true })
        await expect(orders.recordOrderPayment(TEST_WORKSPACE_ID, payment)).rejects.toThrow()
        expect(await db.payment_transactions.count()).toBe(0)
        await assertOrderFinancialEffects(order.id, 0, 100)
    })

    const seed = Number(process.env.ATLAS_TEST_SEED ?? 20260918)
    const count = Number(process.env.ATLAS_TEST_SAMPLES ?? 16)
    for (const sample of seededCases(seed, count)) {
        it(`seed ${seed} / case ${sample.index}: fractional quantity ${sample.quantity} × ${sample.unitPrice} ${sample.currency} reconciles through checkout and full return`, async () => {
            const { customer, storage, product } = await arrange(sample.currency)
            const method = STANDARD_PAYMENT_METHODS[sample.methodIndex]
            const expectedTotal = Math.round(sample.quantity * sample.unitPrice * 1000) / 1000
            const order = await orders.createCompletedSalesOrder(TEST_WORKSPACE_ID,
                saleOrderInput(customer.id, product, storage.id, method, { ...sample, paid: true }))
            expect(order.total).toBe(expectedTotal)
            await assertOrderFinancialEffects(order.id, expectedTotal, 0)
            await assertStock(product.id, storage.id, 10 - sample.quantity)
            await orders.returnSalesOrder({ orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: sample.quantity }], reason: 'customer_returned', actorRole: 'admin' })
            await assertOrderFinancialEffects(order.id, 0, 0)
            await assertStock(product.id, storage.id, 10)
        })
    }
})
