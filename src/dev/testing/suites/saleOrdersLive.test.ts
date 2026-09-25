import 'fake-indexeddb/auto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { db } from '@/local-db/database'
import { setActiveBusinessUser, setActiveBusinessWorkspace } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { installTestBrowser } from '../fixtures/browser'
import { saleOrderInput } from '../fixtures/saleOrder'
import { liveSupabase } from '../liveSupabase'

vi.mock('@/auth/supabase', async () => ({ supabase: (await import('../liveSupabase')).liveSupabase }))

const workspaceId = process.env.ATLAS_LIVE_WORKSPACE_ID || ''
const workspaceName = process.env.ATLAS_LIVE_WORKSPACE_NAME || ''
const email = process.env.ATLAS_LIVE_TEST_EMAIL || ''
const password = process.env.ATLAS_LIVE_TEST_PASSWORD || ''
const runId = process.env.ATLAS_LIVE_RUN_ID || ''
const supabaseUrl = process.env.ATLAS_LIVE_SUPABASE_URL || ''
const supabaseKey = process.env.ATLAS_LIVE_SUPABASE_KEY || ''

function requireData<T>(result: { data: T | null; error: { message: string } | null }, label: string): NonNullable<T> {
    if (result.error || !result.data) throw new Error(`${label}: ${result.error?.message || 'missing row'}`)
    return result.data as NonNullable<T>
}

function fixtureEvent(ids: Record<string, string | null>, cleanup?: string) {
    process.stdout.write(`ATLAS_TEST_EVENT ${JSON.stringify({ type: 'fixture', fixture: { runId, workspaceId, ...ids, ...(cleanup ? { cleanup } : {}) } })}\n`)
}

async function freshClient() {
    const client = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: globalThis.fetch.bind(globalThis) }
    })
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw new Error('live_auth_failed')
    return client
}

describe('Sale Orders · hosted Supabase', () => {
    beforeAll(async () => {
        installTestBrowser()
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
        if (!runId || !workspaceId || !/^DEV TEST\b/i.test(workspaceName)) throw new Error('live_config_invalid')
        const { data, error } = await liveSupabase.auth.signInWithPassword({ email, password })
        if (error || !data.user) throw new Error('live_auth_failed')
        const profile = requireData<{ current_workspace: string | null; role: string }>(await liveSupabase.from('profiles').select('current_workspace,role').eq('id', data.user.id).single(), 'profile')
        const workspace = requireData<{ id: string; name: string; data_mode: 'cloud' | 'hybrid' }>(await liveSupabase.from('workspaces').select('id,name,data_mode').eq('id', workspaceId).single(), 'workspace')
        if (profile.current_workspace !== workspaceId || profile.role !== 'admin'
            || workspace.id !== workspaceId || workspace.name !== workspaceName
            || !['cloud', 'hybrid'].includes(workspace.data_mode)) throw new Error('live_workspace_mismatch')
        writeWorkspaceModeSnapshot({ workspaceId, dataMode: workspace.data_mode })
        setActiveBusinessWorkspace(workspaceId)
        setActiveBusinessUser(data.user.id, 'admin', workspaceId)
        await db.delete()
        await db.open()
        // createStorage chooses primary/marketplace from the local cache. A live
        // workspace may already have both, including fixtures from earlier runs.
        const { fetchTableFromSupabase } = await import('@/local-db/hooks')
        const storagesHydrated = await fetchTableFromSupabase('storages', db.storages, workspaceId, { force: true })
        if (!storagesHydrated) throw new Error('live_storage_hydration_failed')
    }, 120_000)

    afterAll(async () => {
        clearWorkspaceModeSnapshot(workspaceId)
        setActiveBusinessUser(null)
        setActiveBusinessWorkspace(null)
        await liveSupabase.auth.signOut().catch(() => undefined)
        await db.delete()
    })

    for (const method of ['loan', 'installments'] as const) {
        for (const initialPayment of [0, 25]) {
            it(`${method} / down payment ${initialPayment}: cancellation persists deleted loan, schedule, and exact reversals`, async () => {
                const orders = await import('@/local-db/orders')
                const hooks = await import('@/local-db/hooks')
                const partners = await import('@/local-db/businessPartners')
                const tag = `DEV TEST ${runId.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
                const ids: Record<string, string | null> = { partnerId: null, storageId: null, productId: null, orderId: null, loanId: null }
                let scenarioPassed = false
                const dueDate = new Date(Date.now() + 30 * 86_400_000).toISOString()
                try {
                    const partner = await partners.createBusinessPartner(workspaceId, {
                        partnerName: `${tag} customer`, phone: '', defaultCurrency: 'usd',
                        creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
                    })
                    ids.partnerId = partner.id
                    fixtureEvent(ids)
                    const storage = await hooks.createStorage(workspaceId, { name: `${tag} storage` })
                    ids.storageId = storage.id
                    fixtureEvent(ids)
                    const product = await hooks.createProduct(workspaceId, {
                        sku: `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} product`, description: '',
                        categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
                        price: 100, costPrice: 40, quantity: 10, minStockLevel: 0, unit: 'pcs',
                        currency: 'usd', barcode: '', barcodes: [], imageUrl: '', canBeReturned: true,
                        returnRules: '', createdBy: null
                    })
                    ids.productId = product.id
                    fixtureEvent(ids)
                    const input = saleOrderInput(partner.id, product, storage.id, method, { initialPayment })
                    const order = await orders.createSalesOrder(workspaceId, {
                        ...input, customerName: partner.partnerName, notes: tag,
                        paidAt: initialPayment ? new Date().toISOString() : null,
                        firstDueDate: dueDate, nextDueDate: dueDate
                    }, undefined, { requireRemoteConfirmation: true })
                    ids.orderId = order.id
                    fixtureEvent(ids)
                    const active = await orders.updateSalesOrderStatus(order.id, 'pending')
                    ids.loanId = active.linkedLoanId ?? null
                    fixtureEvent(ids)
                    expect(active.linkedLoanId).toBeTruthy()

                    const before = await freshClient()
                    try {
                        const serverOrder = requireData(await before.schema('crm').from('sales_orders')
                            .select('id,status,linked_loan_id,workspace_id').eq('id', order.id).single(), 'active order')
                        const serverLoan = requireData(await before.from('loans')
                            .select('id,is_deleted,workspace_id').eq('id', active.linkedLoanId).single(), 'active loan')
                        const stock = requireData<{ quantity: number }>(await before.from('inventory')
                            .select('quantity').eq('workspace_id', workspaceId).eq('product_id', product.id).eq('storage_id', storage.id).single(), 'active inventory')
                        expect(serverOrder).toMatchObject({ status: 'pending', linked_loan_id: active.linkedLoanId, workspace_id: workspaceId })
                        expect(serverLoan).toMatchObject({ is_deleted: false, workspace_id: workspaceId })
                        expect(Number(stock.quantity)).toBe(10)
                    } finally { await before.auth.signOut() }

                    const cancelled = await orders.updateSalesOrderStatus(order.id, 'cancelled')
                    expect(cancelled).toMatchObject({ status: 'cancelled', linkedLoanId: null, paidAmount: 0 })
                    const fresh = await freshClient()
                    try {
                        const serverOrder = requireData(await fresh.schema('crm').from('sales_orders')
                            .select('status,linked_loan_id,paid_amount,workspace_id').eq('id', order.id).single(), 'cancelled order')
                        const serverLoan = requireData(await fresh.from('loans')
                            .select('id,is_deleted,workspace_id').eq('id', ids.loanId).single(), 'cancelled loan')
                        const installments = requireData(await fresh.from('loan_installments')
                            .select('id,is_deleted').eq('loan_id', ids.loanId), 'loan installments')
                        const loanPayments = requireData(await fresh.from('loan_payments')
                            .select('id,is_deleted').eq('loan_id', ids.loanId), 'loan payments')
                        const orderPayments = requireData(await fresh.from('payment_transactions')
                            .select('id,amount,reversal_of_transaction_id,is_deleted').eq('workspace_id', workspaceId).eq('source_type', 'sales_order').eq('source_record_id', order.id), 'order payments')
                        const financingPayments = requireData(await fresh.from('payment_transactions')
                            .select('id,amount,reversal_of_transaction_id,is_deleted').eq('workspace_id', workspaceId).eq('source_module', 'loans').eq('source_record_id', ids.loanId), 'loan transactions')
                        const stock = requireData<{ quantity: number }>(await fresh.from('inventory')
                            .select('quantity').eq('workspace_id', workspaceId).eq('product_id', product.id).eq('storage_id', storage.id).single(), 'cancelled inventory')
                        expect(serverOrder).toMatchObject({ status: 'cancelled', linked_loan_id: null, paid_amount: 0, workspace_id: workspaceId })
                        expect(serverLoan).toMatchObject({ is_deleted: true, workspace_id: workspaceId })
                        expect(installments.length).toBeGreaterThan(0)
                        expect(installments.every((row) => row.is_deleted)).toBe(true)
                        expect(loanPayments.every((row) => row.is_deleted)).toBe(true)
                        expect(Number(stock.quantity)).toBe(10)
                        if (initialPayment > 0) expect(orderPayments.length + financingPayments.length).toBeGreaterThan(0)
                        for (const payments of [orderPayments, financingPayments]) {
                            const visible = payments.filter((row) => !row.is_deleted)
                            expect(visible.reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(0, 3)
                            for (const original of visible.filter((row) => Number(row.amount) > 0)) {
                                const reversals = visible.filter((row) => row.reversal_of_transaction_id === original.id)
                                expect(reversals.reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(-Number(original.amount), 3)
                            }
                        }
                        scenarioPassed = true
                    } finally { await fresh.auth.signOut() }
                } finally {
                    // Historical orders and financial records remain for audit. Retire only
                    // the disposable catalog item; retain failed fixtures for inspection.
                    let cleanup = 'retained'
                    if (scenarioPassed && ids.productId) {
                        try { await hooks.deleteProduct(ids.productId); cleanup = 'product-retired' }
                        catch { cleanup = 'product-retire-failed' }
                    }
                    fixtureEvent(ids, cleanup)
                }
            }, 120_000)
        }
    }

    it('serializes financed cancellation against order completion and stock posting', async () => {
        const orders = await import('@/local-db/orders')
        const hooks = await import('@/local-db/hooks')
        const partners = await import('@/local-db/businessPartners')
        const tag = `DEV TEST ${runId.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
        const ids: Record<string, string | null> = { partnerId: null, storageId: null, productId: null, orderId: null, loanId: null }
        let scenarioPassed = false
        try {
            const partner = await partners.createBusinessPartner(workspaceId, {
                partnerName: `${tag} customer`, phone: '', defaultCurrency: 'usd',
                creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
            })
            ids.partnerId = partner.id
            fixtureEvent(ids)
            const storage = await hooks.createStorage(workspaceId, { name: `${tag} storage` })
            ids.storageId = storage.id
            fixtureEvent(ids)
            const product = await hooks.createProduct(workspaceId, {
                sku: `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} product`, description: '',
                categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
                price: 100, costPrice: 40, quantity: 10, minStockLevel: 0, unit: 'pcs',
                currency: 'usd', barcode: '', barcodes: [], imageUrl: '', canBeReturned: true,
                returnRules: '', createdBy: null
            })
            ids.productId = product.id
            fixtureEvent(ids)
            const draft = await orders.createSalesOrder(workspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'loan'),
                customerName: partner.partnerName, notes: tag,
                firstDueDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
                nextDueDate: new Date(Date.now() + 30 * 86_400_000).toISOString()
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = draft.id
            fixtureEvent(ids)
            const pending = await orders.updateSalesOrderStatus(draft.id, 'pending')
            ids.loanId = pending.linkedLoanId ?? null
            fixtureEvent(ids)
            expect(pending.linkedLoanId).toBeTruthy()

            const cancellationClient = await freshClient()
            let cancellation: { data: unknown; error: { message: string } | null } | null = null
            let completion: PromiseSettledResult<unknown> | null = null
            try {
                const completionPromise = orders.updateSalesOrderStatus(draft.id, 'completed')
                const cancellationPromise = cancellationClient.rpc('cancel_order_with_financing', {
                    p_order_type: 'sales', p_order_id: draft.id
                })
                ;[completion, cancellation] = await Promise.all([
                    completionPromise.then<PromiseSettledResult<unknown>, PromiseSettledResult<unknown>>(
                        (value) => ({ status: 'fulfilled', value }),
                        (reason) => ({ status: 'rejected', reason })
                    ),
                    cancellationPromise
                ])
            } finally { await cancellationClient.auth.signOut() }

            const fresh = await freshClient()
            try {
                const serverOrder = requireData<{ status: string; items: Array<Record<string, unknown>> }>(
                    await fresh.schema('crm').from('sales_orders')
                        .select('status,items').eq('id', draft.id).single(),
                    'raced order'
                )
                const stock = requireData<{ quantity: number }>(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', workspaceId).eq('product_id', product.id)
                    .eq('storage_id', storage.id).single(), 'raced inventory')
                const saleTransactions = requireData<Array<{
                    quantity_delta: number; previous_quantity: number; new_quantity: number
                }>>(await fresh.from('inventory_transactions')
                    .select('quantity_delta,previous_quantity,new_quantity')
                    .eq('workspace_id', workspaceId).eq('reference_type', 'sales_order')
                    .eq('reference_id', draft.id).eq('transaction_type', 'sale'), 'raced inventory ledger')

                if (serverOrder.status === 'cancelled') {
                    expect(Number(stock.quantity)).toBe(10)
                    expect(saleTransactions).toHaveLength(0)
                    expect(cancellation?.error).toBeNull()
                    expect(completion?.status).toBe('rejected')
                } else {
                    expect(serverOrder.status).toBe('completed')
                    expect(Number(stock.quantity)).toBe(9)
                    expect(saleTransactions).toHaveLength(1)
                    expect(saleTransactions[0]).toMatchObject({
                        quantity_delta: -1, previous_quantity: 10, new_quantity: 9
                    })
                    expect(cancellation?.error).toBeTruthy()
                    expect(completion?.status).toBe('fulfilled')
                    expect(serverOrder.items[0]).toMatchObject({ reservedQuantity: 1, fulfilledQuantity: 1 })
                }
                scenarioPassed = true
            } finally { await fresh.auth.signOut() }
        } finally {
            let cleanup = 'retained'
            if (scenarioPassed && ids.productId) {
                try { await hooks.deleteProduct(ids.productId); cleanup = 'product-retired' }
                catch { cleanup = 'product-retire-failed' }
            }
            fixtureEvent(ids, cleanup)
        }
    }, 120_000)

    it('completes a pending Sale Order with one atomic stock and sale-ledger post', async () => {
        const orders = await import('@/local-db/orders')
        const hooks = await import('@/local-db/hooks')
        const partners = await import('@/local-db/businessPartners')
        const tag = `DEV TEST ${runId.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
        const ids: Record<string, string | null> = { partnerId: null, storageId: null, productId: null, orderId: null }
        let scenarioPassed = false
        try {
            const partner = await partners.createBusinessPartner(workspaceId, {
                partnerName: `${tag} customer`, phone: '', defaultCurrency: 'usd',
                creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
            })
            ids.partnerId = partner.id
            fixtureEvent(ids)
            const storage = await hooks.createStorage(workspaceId, { name: `${tag} storage` })
            ids.storageId = storage.id
            fixtureEvent(ids)
            const product = await hooks.createProduct(workspaceId, {
                sku: `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} product`, description: '',
                categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
                price: 100, costPrice: 40, quantity: 10, minStockLevel: 0, unit: 'pcs',
                currency: 'usd', barcode: '', barcodes: [], imageUrl: '', canBeReturned: true,
                returnRules: '', createdBy: null
            })
            ids.productId = product.id
            fixtureEvent(ids)
            const order = await orders.createSalesOrder(workspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true }),
                customerName: partner.partnerName, notes: tag,
                paidAt: new Date().toISOString()
            }, undefined, { requireRemoteConfirmation: true })
            ids.orderId = order.id
            fixtureEvent(ids)
            await orders.updateSalesOrderStatus(order.id, 'pending')
            const completed = await orders.updateSalesOrderStatus(order.id, 'completed')
            expect(completed.status).toBe('completed')

            const fresh = await freshClient()
            try {
                const serverOrder = requireData<{ status: string; items: Array<Record<string, unknown>> }>(
                    await fresh.schema('crm').from('sales_orders')
                        .select('status,items').eq('id', order.id).single(),
                    'completed order'
                )
                const stock = requireData<{ quantity: number }>(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', workspaceId).eq('product_id', product.id)
                    .eq('storage_id', storage.id).single(), 'completed order inventory')
                const saleTransactions = requireData<Array<{
                    quantity_delta: number; previous_quantity: number; new_quantity: number
                }>>(await fresh.from('inventory_transactions')
                    .select('quantity_delta,previous_quantity,new_quantity')
                    .eq('workspace_id', workspaceId).eq('reference_type', 'sales_order')
                    .eq('reference_id', order.id).eq('transaction_type', 'sale'), 'completed sale ledger')
                expect(serverOrder.status).toBe('completed')
                expect(serverOrder.items[0]).toMatchObject({ reservedQuantity: 1, fulfilledQuantity: 1 })
                expect(Number(stock.quantity)).toBe(9)
                expect(saleTransactions).toHaveLength(1)
                expect(saleTransactions[0]).toMatchObject({
                    quantity_delta: -1, previous_quantity: 10, new_quantity: 9
                })
                scenarioPassed = true
            } finally { await fresh.auth.signOut() }
        } finally {
            let cleanup = 'retained'
            if (scenarioPassed && ids.productId) {
                try { await hooks.deleteProduct(ids.productId); cleanup = 'product-retired' }
                catch { cleanup = 'product-retire-failed' }
            }
            fixtureEvent(ids, cleanup)
        }
    }, 120_000)

    it('paid cash Quick Order and full return persist stock and exact payment reversal', async () => {
        const orders = await import('@/local-db/orders')
        const hooks = await import('@/local-db/hooks')
        const partners = await import('@/local-db/businessPartners')
        const tag = `DEV TEST ${runId.slice(0, 8)} ${crypto.randomUUID().slice(0, 8)}`
        const ids: Record<string, string | null> = { partnerId: null, storageId: null, productId: null, orderId: null, returnId: null }
        let scenarioPassed = false
        try {
            const partner = await partners.createBusinessPartner(workspaceId, {
                partnerName: `${tag} customer`, phone: '', defaultCurrency: 'usd',
                creditLimit: 0, receivableCreditLimit: null, payableCreditLimit: null, role: 'customer'
            })
            ids.partnerId = partner.id
            fixtureEvent(ids)
            const storage = await hooks.createStorage(workspaceId, { name: `${tag} storage` })
            ids.storageId = storage.id
            fixtureEvent(ids)
            const product = await hooks.createProduct(workspaceId, {
                sku: `DT-${crypto.randomUUID().slice(0, 12)}`, name: `${tag} product`, description: '',
                categoryId: null, category: null, storageId: storage.id, storageName: storage.name,
                price: 100, costPrice: 40, quantity: 10, minStockLevel: 0, unit: 'pcs',
                currency: 'usd', barcode: '', barcodes: [], imageUrl: '', canBeReturned: true,
                returnRules: '', createdBy: null
            })
            ids.productId = product.id
            fixtureEvent(ids)
            const order = await orders.createCompletedSalesOrder(workspaceId, {
                ...saleOrderInput(partner.id, product, storage.id, 'cash', { paid: true }),
                customerName: partner.partnerName, notes: tag
            })
            ids.orderId = order.id
            fixtureEvent(ids)
            const before = await freshClient()
            try {
                const saved = requireData<{ status: string; paid_amount: number; workspace_id: string }>(await before.schema('crm').from('sales_orders')
                    .select('status,paid_amount,workspace_id').eq('id', order.id).single(), 'paid order')
                const stock = requireData<{ quantity: number }>(await before.from('inventory')
                    .select('quantity').eq('workspace_id', workspaceId).eq('product_id', product.id).eq('storage_id', storage.id).single(), 'completed inventory')
                expect(saved).toMatchObject({ status: 'completed', workspace_id: workspaceId })
                expect(Number(saved.paid_amount)).toBeCloseTo(100, 3)
                expect(Number(stock.quantity)).toBe(9)
            } finally { await before.auth.signOut() }
            const returned = await orders.returnSalesOrder({
                orderId: order.id, items: [{ orderItemId: order.items[0].id, quantity: 1 }],
                reason: 'customer_returned', actorRole: 'admin'
            })
            ids.returnId = returned.return.id
            fixtureEvent(ids)
            const fresh = await freshClient()
            try {
                const saved = requireData<{ return_status: string; paid_amount: number }>(await fresh.schema('crm').from('sales_orders')
                    .select('return_status,paid_amount').eq('id', order.id).single(), 'returned order')
                const stock = requireData<{ quantity: number }>(await fresh.from('inventory')
                    .select('quantity').eq('workspace_id', workspaceId).eq('product_id', product.id).eq('storage_id', storage.id).single(), 'returned inventory')
                const paymentRows = requireData<Array<{ id: string; amount: number; reversal_of_transaction_id: string | null }>>(await fresh.from('payment_transactions')
                    .select('id,amount,reversal_of_transaction_id').eq('workspace_id', workspaceId).eq('source_type', 'sales_order').eq('source_record_id', order.id), 'return payments')
                const returnRow = requireData<{ id: string; workspace_id: string }>(await fresh.from('order_returns')
                    .select('id,workspace_id').eq('id', ids.returnId).maybeSingle(), 'return record')
                const returnItems = requireData<Array<{ return_id: string; order_id: string; quantity: number }>>(await fresh.from('order_return_items')
                    .select('return_id,order_id,quantity').eq('return_id', ids.returnId), 'return items')
                expect(saved.return_status).toBe('full')
                expect(Number(saved.paid_amount)).toBe(0)
                expect(Number(stock.quantity)).toBe(10)
                expect(returnRow.workspace_id).toBe(workspaceId)
                expect(returnItems).toEqual([expect.objectContaining({ return_id: ids.returnId, order_id: order.id, quantity: 1 })])
                expect(paymentRows.some((row) => Number(row.amount) > 0)).toBe(true)
                expect(paymentRows.reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(0, 3)
                for (const original of paymentRows.filter((row) => Number(row.amount) > 0)) {
                    expect(paymentRows.filter((row) => row.reversal_of_transaction_id === original.id)
                        .reduce((sum, row) => sum + Number(row.amount), 0)).toBeCloseTo(-Number(original.amount), 3)
                }
                scenarioPassed = true
            } finally { await fresh.auth.signOut() }
        } finally {
            let cleanup = 'retained'
            if (scenarioPassed && ids.productId) {
                try { await hooks.deleteProduct(ids.productId); cleanup = 'product-retired' }
                catch { cleanup = 'product-retire-failed' }
            }
            fixtureEvent(ids, cleanup)
        }
    }, 120_000)
})
