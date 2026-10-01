import { expect } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId, requireLiveData } from '../../fixtures/saleOrdersLive'
import { active, canonical, money, quantity, readGraph, sum } from './graph'
import { HostedScenario, personaClient, requireFixture } from './harness'
import { HostedBlocked, type Graph, type Row } from './types'
import { CURRENCIES, historicalFactor, historicalRates, uom } from './choices'

const denied = { denied: true, unchanged: true }
const index = (s: HostedScenario) => Number(s.family.id.slice(-2))
export function completionPayload(s: HostedScenario, graph: Graph, operationId = uuidv5(s.order!.id, '29a34eb1-80c0-5cf9-8bc1-0bbb71fd718b')) {
    const order = graph.tables.orders.find(row => row.id === s.order!.id)!
    const services = new Set(graph.tables.products.filter(row => row.is_service).map(row => row.id))
    const demand = (line: Row) => quantity(Number(line.inventoryQuantity ?? Number(line.quantity) * Number(line.unitFactor ?? 1)) + Number(line.freeBonusInventoryQuantity ?? Number(line.freeBonusQuantity ?? 0) * Number(line.unitFactor ?? 1)))
    return {
        p_order_id: order.id, p_workspace_id: liveWorkspaceId, p_expected_order_version: Number(order.version), p_operation_id: operationId,
        p_actual_delivery_date: new Date().toISOString(),
        p_items: order.items.map((line: Row) => ({ ...line, fulfilledQuantity: services.has(line.productId) ? 0 : demand(line), reservedQuantity: services.has(line.productId) ? 0 : demand(line) })),
        p_changes: graph.tables.inventory.filter(row => order.items.some((line: Row) => line.productId === row.product_id && line.storageId === row.storage_id && !services.has(line.productId))).map(row => ({
            id: row.id, product_id: row.product_id, storage_id: row.storage_id, expected_version: Number(row.version),
            quantity: quantity(Number(row.quantity) - order.items.filter((line: Row) => line.productId === row.product_id && line.storageId === row.storage_id).reduce((sum: number, line: Row) => sum + demand(line), 0)),
            audit_transaction_type: null, audit_reference_id: null, audit_reference_type: null, audit_notes: null, audit_created_by: null
        }))
    }
}
export async function atomicReplay(s: HostedScenario, entry: 'quick' | 'regular', altered: boolean) {
    let name: string
    let payload: Row
    if (entry === 'quick') {
        await s.create(s.input({ paid: true }), 'quick', 'completed')
        name = 'complete_quick_sales_order'
        payload = s.payloads.get(`/rest/v1/rpc/${name}`)!
        if (!payload) throw new Error('hosted_atomic_request_evidence_missing')
    } else {
        await s.create(s.input({ paid: true })); await s.status('pending')
        name = 'complete_sales_order_with_inventory'
        payload = completionPayload(s, await readGraph(s.observer, s.scope))
        s.scope.operationIds.add(payload.p_operation_id)
        await s.step('atomic server completion', () => s.rpc(liveSupabase, name, payload), { status: 'completed', stockDelta: -2 })
    }
    const retry = structuredClone(payload)
    if (altered) {
        if (entry === 'quick') retry.payload.order.items[0].quantity += 1
        else retry.p_items[0].fulfilledQuantity += 1
    }
    await s.step(altered ? 'same operation with different payload rejected' : 'exact same operation replay', () => s.rpc(liveSupabase, name, retry), altered ? denied : { unchanged: true })
}
export async function approval(s: HostedScenario) {
    const i = index(s)
    if (i === 7) { const client = await personaClient('staff'); try { await s.create(s.input({ approval: true })); await s.step('staff approval bypass', () => s.rawOrder(client, { approval_status: 'approved', approval_reviewed_at: new Date().toISOString() }), denied) } finally { await client.auth.signOut({ scope: 'local' }) }; return }
    if (i === 12) {
        const f = requireFixture(s.family.id)
        const rows = requireLiveData<Row[]>(await s.observer.schema('crm').from('sales_orders').select('*').eq('workspace_id', liveWorkspaceId).eq('id', String(f.orderId)), 'rejected approval fixture')
        expect(rows).toHaveLength(1); expect(rows[0].approval_status).toBe('rejected'); expect(rows[0].status).toBe('draft'); return
    }
    const input = s.input({ approval: true, paid: [2, 5, 6, 10].includes(i), method: i === 3 ? 'installments' : 'cash', initial: i === 3 ? 25 : 0 })
    await s.create(input)
    await s.step('request defers real payments and stock', async () => undefined, { unchanged: true, check: graph => { expect(active(graph.tables.payments)).toHaveLength(0); expect(graph.tables.orders[0].approval_status).toBe('requested') } })
    if (i === 8) { await s.status('pending', denied); await s.status('completed', denied); return }
    if (i === 9) { await s.edit({ notes: `${s.fixture.tag} request edit` }); return }
    if (i === 11) { await s.step('forged review actor/time bypass', () => s.rawOrder(liveSupabase, { approval_status: 'approved', approval_reviewed_by: crypto.randomUUID(), approval_reviewed_at: 'not-a-date' }), denied); return }
    if (i === 10) {
        const orders = await import('@/local-db/orders')
        await s.step('simultaneous approvals', async () => {
            const results = await Promise.allSettled([orders.approveSalesOrderRequest(s.order!.id), orders.approveSalesOrderRequest(s.order!.id)])
            expect(results.some(result => result.status === 'fulfilled')).toBe(true)
        }, { paid: input.total, check: graph => expect(active(graph.tables.payments)).toHaveLength(1) }); return
    }
    if (i >= 4) { await s.approve({ paid: input.paidAmount }); if (i === 6) await s.approve(denied) }
}
export async function reservation(s: HostedScenario) {
    const i = index(s)
    if (i === 3) { await s.create(s.input({ method: 'fib' }), 'quick', 'pending'); return }
    if (i === 4) { for (const method of ['loan', 'installments'] as const) { await s.create(s.input({ method })); await s.status('pending', { stockDelta: 0 }) }; return }
    if (i === 5) {
        for (const count of s.variant ? [s.variant.count] : [99, 100, 101]) {
            await s.create(s.input({ quantity: count, paid: true }))
            await s.status('pending', count > 100 ? denied : { stockDelta: 0 })
            if (count <= 100) await s.status('cancelled')
        }
        return
    }
    let input = s.input({ paid: i !== 2, free: i === 6 ? 2 : 0 })
    if (i === 9) { input.items.push({ ...input.items[0], id: crypto.randomUUID() }); s.recalc(input) }
    if (i === 12) { input.items = [s.line(await s.extraProduct(true))]; s.recalc(input) }
    if (i === 10) {
        const product = await s.extraProduct(); input.items.push(s.line(product, 101)); s.recalc(input)
    }
    if (i === 11) {
        const batches = await import('@/local-db/stockBatches')
        const batch = await batches.createStockBatch(liveWorkspaceId, { productId: s.fixture.product.id, storageId: s.fixture.storage.id, batchNumber: `${s.fixture.tag} B`, quantity: 1, price: 100, costPrice: 40, currency: 'usd' })
        input.items[0].batchAllocations = [{ batchId: batch.id, batchNumber: batch.batchNumber, quantity: 2 } as any]
    }
    await s.create(input)
    if (i === 7 || i === 13) {
        const first = s.order!
        await s.status('pending')
        await s.create(s.input({ paid: true, quantity: 100 }))
        if (i === 13) {
            const orders = await import('@/local-db/orders')
            await s.step('competing reservations', async () => {
                const results = await Promise.allSettled([orders.updateSalesOrderStatus(first.id, 'pending'), orders.updateSalesOrderStatus(s.order!.id, 'pending')])
                expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(0)
            }, { unchanged: true })
        } else await s.status('pending', denied)
        return
    }
    await s.status('pending', [2, 10, 11].includes(i) ? denied : { stockDelta: 0 })
    if (i === 8) await s.status('completed')
    if (i === 14) await s.status('pending', denied)
}
export async function completion(s: HostedScenario) {
    const i = index(s)
    if (i === 12 || i === 13) {
        await atomicReplay(s, 'regular', i === 13)
        const { privateReceiptWitness } = await import('./security')
        await privateReceiptWitness(s)
        return
    }
    let input = s.input({ paid: true })
    if (i === 2) input.items.push(s.line(await s.extraProduct()))
    if (i === 3) input.items.push({ ...input.items[0], id: crypto.randomUUID() })
    if (i === 7 || i === 8) {
        const line = s.line(await s.extraProduct(true)); input.items = i === 7 ? [line] : [...input.items, line]
    }
    if ([4, 5, 6].includes(i)) {
        const batches = await import('@/local-db/stockBatches')
        for (const [offset, amount] of [[1, 1], [2, 4]]) {
            const batch = await batches.createStockBatch(liveWorkspaceId, { productId: s.fixture.product.id, storageId: s.fixture.storage.id, batchNumber: `${s.fixture.tag} B${offset}`, quantity: amount, expiryDate: new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10), price: 100, costPrice: offset === 1 ? 30 : 45, currency: i === 6 && offset === 2 ? 'eur' : 'usd' })
            if (i === 5 && offset === 2) input.items[0].batchAllocations = [{ batchId: batch.id, batchNumber: batch.batchNumber, quantity: 2 } as any]
        }
        s.baseline = await readGraph(s.observer, s.scope)
    }
    s.recalc(input)
    await s.create(input)
    if (i === 15) { await s.status('completed', denied); await s.status('pending'); await s.status('completed'); await s.status('completed', denied); return }
    await s.status('pending')
    if (i === 9) {
        const hooks = await import('@/local-db/hooks'); await hooks.updateProduct(s.fixture.product.id, { quantity: 0 })
        s.baseline = await readGraph(s.observer, s.scope)
        await s.status('completed', denied); return
    }
    if (i === 10 || i === 11) {
        const payload = completionPayload(s, await readGraph(s.observer, s.scope))
        if (i === 10) { payload.p_expected_order_version--; payload.p_changes.forEach(row => row.expected_version--) }
        else { payload.p_items[0].quantity += 1; payload.p_changes[0].quantity += 1 }
        await s.step('invalid atomic completion request', () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', payload), denied); return
    }
    await s.status('completed')
    if (i === 14) {
        const fresh = await readGraph(s.observer, s.scope)
        const order = fresh.tables.orders[0]
        expect(order.status).toBe('completed'); expect(order.items).toHaveLength(input.items.length)
        expect(fresh.tables.movements.filter(row => row.reference_id === order.id)).toHaveLength(new Set(input.items.filter(line => line.storageId).map(line => `${line.productId}/${line.storageId}`)).size)
    }
}

export async function collections(s: HostedScenario) {
    const i = index(s)
    const orders = await import('@/local-db/orders')
    const payments = await import('@/local-db/payments')
    if (i === 13) { await s.create(s.input({ method: 'loan' })); await s.status('pending'); await s.pay(25, 'cash', null, denied); return }
    if (i === 14 || i === 15) {
        const f = requireFixture(s.family.id)
        await s.create(s.input(), 'quick', 'completed')
        if (i === 15) s.fault = { path: '/payment_transactions', occurrence: 2, seen: 0, mode: 'after' }
        await s.step('partner-wide production settlement', () => payments.settlePartnerBalance(liveWorkspaceId, {
            partnerId: s.fixture.partner.id, direction: 'incoming', currency: 'usd', amount: 100, paymentMethod: 'cash', paidAt: new Date().toISOString(), accountId: f.accountId ?? null
        } as any), i === 15 ? { denied: true } : { paymentDelta: 100 })
        s.fault = null; return
    }
    await s.create(s.input(), 'quick', i === 7 ? 'draft' : 'completed')
    if (i === 5) { for (const amount of [0, -1, 201, Number.NaN, Number.POSITIVE_INFINITY]) await s.pay(amount, 'cash', null, denied); return }
    if (i === 6) { for (const amount of [0.0004, 0.0005, 0.001, 0.0015]) await s.pay(amount, 'cash', null, amount < 0.0005 ? denied : {}); return }
    if (i === 1) { await s.pay(60, 'cash', null, { paid: 60, paymentDelta: 60 }); return }
    if (i === 2) { await s.pay(60); await s.pay(140, 'cash', null, { paid: 200 }); return }
    if (i === 3) { await s.pay(200, 'cash', null, { paid: 200 }); return }
    if (i === 4) { for (const method of STANDARD_PAYMENT_METHODS) await s.pay(10, method); return }
    const first = await s.pay(i === 7 ? 200 : 100)
    const id = first!.transaction.id
    if (i === 10) { await s.pay(20); await s.step('only latest receipt may be reversed', () => payments.reversePaymentTransaction(liveWorkspaceId, id), denied); return }
    if (i === 11) {
        const f = requireFixture(s.family.id)
        await s.step('voided fixture reversal rejected', () => payments.reversePaymentTransaction(liveWorkspaceId, String(f.paymentId)), denied); return
    }
    if (i === 12) {
        await s.pay(100); await s.step('lock paid order', () => orders.lockSalesOrder(s.order!.id))
        await s.pay(1, 'cash', null, denied); await s.step('locked receipt reversal', () => payments.reversePaymentTransaction(liveWorkspaceId, id), denied); return
    }
    await s.step(i === 8 ? 'reverse exact partial receipt portion' : 'reverse full latest receipt', () => payments.reversePaymentTransaction(liveWorkspaceId, id, { amount: i === 8 ? 25 : undefined }), { paymentDelta: i === 8 ? -25 : i === 7 ? -200 : -100 })
    if (i === 9) await s.step('same fully reversed receipt again', () => payments.reversePaymentTransaction(liveWorkspaceId, id), denied)
}

export async function accounts(s: HostedScenario) {
    const i = index(s)
    if (i === 4) {
        for (const currency of s.variant ? [s.variant.currency] : CURRENCIES) for (const method of s.variant ? [s.variant.method] : STANDARD_PAYMENT_METHODS) {
            const type = method === 'cash' ? 'cash_drawer' : method === 'bank_transfer' ? 'bank_account' : 'digital_wallet'
            const account = await s.account({ type, method: type === 'digital_wallet' ? method as 'fib' | 'qicard' | 'zaincash' | 'fastpay' : undefined })
            await s.create(s.input({ currency, method }), 'quick', 'completed')
            await s.pay(100, method, account.id, { paymentDelta: 100 })
        }
        return
    }
    if ([5, 6, 7, 10].includes(i)) {
        const f = requireFixture(s.family.id)
        const accountId = String(f.accountId)
        if (!accountId || accountId === 'undefined') throw new HostedBlocked(`${s.family.id} payment account/shift fixture`)
        await s.create(s.input(), 'quick', 'completed')
        // Capture a valid real collection request first, then vary only the account/persona under test.
        const ownAccount = await s.account()
        await s.pay(1, 'cash', ownAccount.id)
        const captured = s.payloads.get('/rest/v1/payment_transactions')
        const row = Array.isArray(captured) ? captured[0] : captured
        if (!row?.source_record_id) throw new Error('hosted_payment_request_evidence_missing')
        const client = i === 7 ? await personaClient('restricted-staff') : liveSupabase
        try { await s.step('restricted account/shift posting', async () => {
            const result = await client.from('payment_transactions').insert({ ...row, id: crypto.randomUUID(), amount: 10, account_id: accountId }).select('id').single()
            if (result.error || !result.data) throw new Error(`hosted_payment_denied:${result.error?.code}:${result.error?.message ?? 'zero rows'}`)
        }, denied) }
        finally { if (client !== liveSupabase) await client.auth.signOut({ scope: 'local' }) }
        return
    }
    if (i === 14) {
        const account = await s.account()
        await s.step('direct balance bypass denied', async () => {
            const result = await liveSupabase.schema('payment_accounts').from('account_balances').insert({ id: crypto.randomUUID(), workspace_id: liveWorkspaceId, account_id: account.id, currency: 'usd', balance_amount: 999 }).select('id').single()
            if (result.error || !result.data) throw new Error(result.error?.message ?? 'zero affected rows')
        }, denied); return
    }
    const account = i === 1 ? null : await s.account()
    await s.create(s.input(), 'quick', 'completed')
    const method = i === 4 ? 'bank_transfer' : 'cash'
    if (i === 11) {
        await s.step('concurrent account money', async () => { await Promise.all([s.pay(50, method, account?.id), s.pay(50, method, account?.id)]) })
        return
    }
    const receipt = await s.pay(100, method, account?.id, { paymentDelta: 100 })
    if (i === 8 && account) {
        const { savePaymentAccount } = await import('@/local-db/paymentAccounts')
        await savePaymentAccount(liveWorkspaceId, { id: account.id, name: `${s.fixture.tag} renamed`, accountType: 'cash_drawer', iconKey: 'cash_drawer', openingBalances: [] } as any)
        await s.step('original account name snapshot', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.payments.find(row => row.id === receipt!.transaction.id)?.account_name_snapshot).toBe(`${s.fixture.tag} account`) })
    }
    if (i === 9) {
        const f = requireFixture(s.family.id)
        await s.returned(1, 0, denied, { accountId: String(f.emptyRefundAccountId) }); return
    }
    if (i === 12) {
        const raw = (await readGraph(s.observer, s.scope)).tables.payments.find(row => row.id === receipt!.transaction.id)!
        await s.step('idempotent receipt account effect', async () => {
            const result = await liveSupabase.from('payment_transactions').upsert(raw)
            if (result.error) throw result.error
        }, { unchanged: true }); return
    }
    if (i === 13) {
        const refundAccount = await s.account()
        await s.returned(0.5, 0, { paymentDelta: -50 }, { accountId: refundAccount.id, accountNameSnapshot: refundAccount.name })
    }
}

export async function cancellation(s: HostedScenario) {
    const i = index(s)
    if ([8, 9].includes(i)) {
        const { existingFixture } = await import('./security'); await existingFixture(s, requireFixture(s.family.id))
        await s.status('cancelled', denied); return
    }
    if ([4, 5, 6, 11, 12].includes(i)) {
        await s.create(s.input({ method: i === 6 ? 'installments' : 'loan', initial: 25 }))
        if (i !== 4) await s.status('pending')
    } else await s.create(s.input({ paid: [2, 3, 14, 15].includes(i) }))
    if (i === 3) await s.status('pending')
    if (i === 7) { await s.pay(50); await s.pay(75); const { reversePaymentTransaction } = await import('@/local-db/payments'); const g = await readGraph(s.observer, s.scope); await s.step('reverse latest receipt before cancel', () => reversePaymentTransaction(liveWorkspaceId, g.tables.payments.at(-1)!.id)) }
    if (i === 13) { await s.pay(50); await s.step('status-only cancellation bypass rejected', () => s.rawOrder(liveSupabase, { status: 'cancelled' }), denied); return }
    if (i === 14) { await s.status('pending'); await s.status('completed'); await s.status('cancelled', denied); return }
    if (i === 11 || i === 12) {
        const { race } = await import('./resilience'); await race(s, i === 11 ? 'complete-cancel' : 'cancel-repayment'); return
    }
    await s.status('cancelled', { stockDelta: 0, paid: 0, check: graph => {
        expect(money(sum(active(graph.tables.payments), 'amount'))).toBe(0)
        expect(graph.tables.loans.every(row => row.is_deleted)).toBe(true)
        expect(graph.tables.loanInstallments.every(row => row.is_deleted)).toBe(true)
    } })
    if (i === 10) await s.status('cancelled', { unchanged: true })
    if (i === 15) { const { setOrderArchived } = await import('@/local-db/orderArchiving'); await s.step('archive cancelled order', () => setOrderArchived(s.order!.id, 'sales', true)); await s.step('unarchive cancelled order', () => setOrderArchived(s.order!.id, 'sales', false)) }
}
export async function standardReturns(s: HostedScenario) {
    const i = index(s)
    const input = s.input({ paid: i !== 9 && i !== 10, free: [5, 6, 7].includes(i) ? 1 : 0 })
    if (i === 3) { input.items.push(s.line(await s.extraProduct())); s.recalc(input) }
    if (i === 7) {
        const unit = await uom(s)
        input.items[0] = { ...input.items[0], unitFactor: 20, inventoryQuantity: 40, freeBonusInventoryQuantity: 20, uomId: unit.id, unit: 'carton', unitRef: 'builtin:carton', uomCostPrice: 40, convertedUomCostPrice: 40 }
    }
    if (i === 8) { const batches = await import('@/local-db/stockBatches'); await batches.createStockBatch(liveWorkspaceId, { productId: s.fixture.product.id, storageId: s.fixture.storage.id, batchNumber: `${s.fixture.tag} return batch`, quantity: 1, price: 100, costPrice: 40, currency: 'usd' }); s.baseline = await readGraph(s.observer, s.scope) }
    if (i === 15) { input.discount = 20; input.tax = 10; s.recalc(input) }
    await s.create(input, 'quick', 'completed')
    if (i === 9) { for (const amount of [50, 50, 100]) await s.pay(amount) }
    if (i === 10) { await s.pay(50); await s.returned(1, 0, denied); return }
    if (i === 12) {
        const orders = await import('@/local-db/orders')
        for (const items of [[], [{ orderItemId: crypto.randomUUID(), quantity: 1 }], [{ orderItemId: s.order!.items[0].id, quantity: 1 }, { orderItemId: s.order!.items[0].id, quantity: 1 }]]) await s.step('invalid return line set', () => orders.returnSalesOrder({ orderId: s.order!.id, items, reason: 'customer_returned', actorRole: 'admin' }), denied)
        return
    }
    if (i === 13) { for (const count of [0, -1, 2.000001, Number.NaN, Number.POSITIVE_INFINITY]) await s.returned(count, 0, denied); return }
    if (i === 14) {
        await s.returned(1, 0, denied, { reason: '' }); await s.returned(1, 0, denied, { actorRole: 'viewer' }); return
    }
    if (i === 16) { const { lockSalesOrder } = await import('@/local-db/orders'); await s.step('lock completed order', () => lockSalesOrder(s.order!.id)); await s.returned(1, 0, denied); return }
    if (i === 17) { const { race } = await import('./resilience'); await race(s, 'return-return'); return }
    if (i === 3) {
        const orders = await import('@/local-db/orders')
        await s.step('return every order line', async () => { const result = await orders.returnSalesOrder({ orderId: s.order!.id, items: s.order!.items.map(line => ({ orderItemId: line.id, paidQuantity: line.quantity })), reason: 'customer_returned', actorRole: 'admin' }); s.order = result.order }, { returns: 1, total: 0, paid: 0 })
    } else if (i === 4) { for (const count of [0.5, 0.5, 1]) await s.returned(count) }
    else await s.returned(i === 1 || i === 15 ? 1 : i === 5 ? 0 : input.items[0].quantity, [5, 6, 7].includes(i) ? 1 : 0)
    if (i === 11) await s.returned(1, 0, denied)
    await s.step('refund portions remain linked to original positive receipts', async () => undefined, { unchanged: true, check: graph => {
        for (const row of graph.tables.payments.filter(row => Number(row.amount) < 0)) expect(graph.tables.payments.some(original => original.id === row.reversal_of_transaction_id && Number(original.amount) > 0)).toBe(true)
    } })
}
export async function correction(s: HostedScenario) {
    const i = index(s)
    const orders = await import('@/local-db/orders')
    if (i === 4) {
        for (const orderCurrency of s.variant ? [s.variant.orderCurrency] : CURRENCIES) {
            const input = s.input({ paid: true, currency: orderCurrency })
            input.exchangeRates = historicalRates()
            await s.complete(input); await s.returned(1)
            let count = 0
            for (const adjustmentCurrency of s.variant ? [s.variant.adjustmentCurrency] : CURRENCIES) for (const type of s.variant ? [s.variant.type] : ['addition', 'deduction'] as const) {
                count++
                await s.step(`post-return ${type} ${adjustmentCurrency}/${orderCurrency}`, () => orders.createPostReturnSalesOrderAdjustment({
                    orderId: s.order!.id, returnId: s.fixture.ids.returnId!, actorRole: 'admin',
                    adjustment: { id: crypto.randomUUID(), name: 'DEV TEST currency correction', type, currency: adjustmentCurrency, amount: '10' }
                }), { paymentDelta: 0, stockDelta: 0, check: (graph, before) => {
                    const current = graph.tables.orders.find(row => row.id === s.order!.id)!
                    const previous = before.tables.orders.find(row => row.id === current.id)!
                    expect([current.total, current.paid_amount, current.balance_amount]).toEqual([previous.total, previous.paid_amount, previous.balance_amount])
                    const corrections = current.order_adjustments.filter((row: Row) => row.scope === 'post_return')
                    expect(corrections).toHaveLength(count)
                    expect(Number(corrections.at(-1).convertedAmount)).toBeCloseTo(10 * historicalFactor(adjustmentCurrency, orderCurrency), 3)
                } })
            }
        }
        return
    }
    await s.complete()
    if (i !== 8) await s.returned(i === 3 ? 2 : 1)
    if (i === 9) await s.step('lock returned order', () => orders.lockSalesOrder(s.order!.id))
    const returnedId = s.fixture.ids.returnId
    if (i === 6) {
        const graph = await readGraph(s.observer, s.scope)
        const order = graph.tables.orders.find(row => row.id === s.order!.id)!
        for (const persona of ['staff', 'viewer']) {
            const client = await personaClient(persona)
            try { await s.step(`${persona} hosted correction write`, () => s.rawOrder(client, { order_adjustments: [
                ...(order.order_adjustments ?? []), { id: crypto.randomUUID(), name: 'DEV TEST forbidden correction', scope: 'post_return', returnId: returnedId,
                    createdAt: new Date().toISOString(), type: 'addition', currency: 'usd', amount: 10, convertedAmount: 10, orderCurrency: 'usd', exchangeRate: 1, exchangeRates: [] }
            ] }), denied) } finally { await client.auth.signOut({ scope: 'local' }) }
        }
        return
    }
    if (i === 10) {
        for (const amount of ['', ' ', '0', '-0.001', 'NaN', 'Infinity', '1,abc']) {
            await s.step(`invalid correction amount ${amount}`, () => orders.createPostReturnSalesOrderAdjustment({ orderId: s.order!.id, returnId: returnedId!, actorRole: 'admin', adjustment: { id: crypto.randomUUID(), name: 'DEV TEST correction', type: 'addition', currency: 'usd', amount } }), denied)
        }
        for (const name of ['', ' ']) await s.step('blank correction label', () => orders.createPostReturnSalesOrderAdjustment({ orderId: s.order!.id, returnId: returnedId!, actorRole: 'admin', adjustment: { id: crypto.randomUUID(), name, type: 'addition', currency: 'usd', amount: '10' } }), denied)
        return
    }
    const currencies = ['usd'] as const
    for (const currency of currencies) {
        const count = i === 5 ? 3 : 1
        for (let n = 0; n < count; n++) {
            const input = { orderId: s.order!.id, returnId: i === 7 ? crypto.randomUUID() : returnedId!, actorRole: i === 6 ? 'staff' : 'admin', adjustment: { id: crypto.randomUUID(), name: i === 10 ? '' : 'Return correction', type: i === 2 ? 'deduction' as const : 'addition' as const, currency, amount: i === 10 ? '0' : '10' } }
            await s.step('immutable post-return correction', () => orders.createPostReturnSalesOrderAdjustment(input), [6, 7, 8, 9, 10].includes(i) ? denied : { paymentDelta: 0, stockDelta: 0, check: graph => expect((graph.tables.orders[0].order_adjustments ?? []).filter((row: Row) => row.scope === 'post_return').length).toBe(n + 1) })
        }
    }
    if (i === 12) {
        const { reconcileSalesOrderCommission } = await import('@/local-db/agentCommissions')
        await s.step('commission reconcile after immutable correction', () => reconcileSalesOrderCommission(liveWorkspaceId, s.order!.id))
    }
}
export async function terminalStates(s: HostedScenario) {
    const i = index(s)
    const orders = await import('@/local-db/orders')
    const { setOrderArchived } = await import('@/local-db/orderArchiving')
    await s.create(s.input({ paid: [1, 4, 6, 7, 10, 11, 15].includes(i) }))
    if (i === 2) { await s.step('unpaid lock', () => orders.lockSalesOrder(s.order!.id), denied); return }
    if (i === 3) { await s.pay(50); await s.step('partial paid lock must follow visible product action', () => orders.lockSalesOrder(s.order!.id)); return }
    if (i === 1 || i === 4) {
        await s.step('lock paid order', () => orders.lockSalesOrder(s.order!.id))
        if (i === 4) { await s.pay(1, 'cash', null, denied); await s.edit({ notes: 'locked edit' }, denied) }
        return
    }
    if (i === 5 || i === 6) { await s.step('soft deletion gate', () => orders.deleteSalesOrder(s.order!.id), i === 6 ? denied : { check: graph => expect(graph.tables.orders[0].is_deleted).toBe(true) }); return }
    if (i === 7) { await s.status('pending'); await s.step('pending deletion denied', () => orders.deleteSalesOrder(s.order!.id), denied); await s.status('completed'); await s.step('completed deletion denied', () => orders.deleteSalesOrder(s.order!.id), denied); return }
    if (i === 10 || i === 11 || i === 15) { await s.status('pending'); await s.status('completed'); await s.returned(i === 11 ? 1 : 2) }
    else await s.status('cancelled')
    if (i === 8) { await s.step('delete cancelled unpaid order', () => orders.deleteSalesOrder(s.order!.id)); return }
    const before = await readGraph(s.observer, s.scope)
    await s.step('archive eligibility and flag-only write', () => setOrderArchived(s.order!.id, 'sales', true), i === 11 ? denied : { check: graph => {
        const current = { ...graph.tables.orders[0], is_archived: false }
        expect(canonical(current)).toBe(canonical(before.tables.orders[0]))
    } })
    if (i === 11) return
    if (i === 13) { await s.pay(1, 'cash', null, denied); await s.returned(1, 0, denied) }
    const loops = i === 12 ? 10 : 1
    for (let loop = 0; loop < loops; loop++) {
        await s.step('unarchive', () => setOrderArchived(s.order!.id, 'sales', false))
        if (i === 12) await s.step('rearchive', () => setOrderArchived(s.order!.id, 'sales', true))
    }
    if (i === 14) {
        await s.step('concurrent archive flags preserve financial graph', async () => { await Promise.all([setOrderArchived(s.order!.id, 'sales', true), setOrderArchived(s.order!.id, 'sales', false)]) }, { paymentDelta: 0, stockDelta: 0 })
    }
}
