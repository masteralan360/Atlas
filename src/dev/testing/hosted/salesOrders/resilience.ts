import { expect } from 'vitest'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId } from '../../fixtures/saleOrdersLive'
import { active, assertGraph, graphHash, readGraph, sum } from './graph'
import { freshObserver, HostedScenario, requireFixture, withScenario } from './harness'
import { HostedBlocked } from './types'
import { atomicReplay, completionPayload } from './flows'

const denied = { denied: true, unchanged: true }
export async function race(s: HostedScenario, kind: 'complete-complete' | 'complete-cancel' | 'return-return' | 'return-repayment' | 'cancel-repayment' | 'repayment-repayment' | 'edit-approve' | 'archive-return') {
    const orders = await import('@/local-db/orders')
    const complete = async () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', completionPayload(s, await readGraph(s.observer, s.scope)))
    const cancel = () => s.rpc(liveSupabase, 'cancel_order_with_financing', { p_order_type: 'sales', p_order_id: s.order!.id })
    const returned = () => orders.returnSalesOrder({ orderId: s.order!.id, items: [{ orderItemId: s.order!.items[0].id, paidQuantity: s.order!.items[0].quantity }], reason: 'customer_returned', actorRole: 'admin' })
    const payment = async () => {
        const { recordLoanPayment } = await import('@/local-db/hooks')
        const graph = await readGraph(s.observer, s.scope)
        const loan = active(graph.tables.loans).find(row => row.order_id === s.order!.id)!
        return recordLoanPayment(liveWorkspaceId, { loanId: loan.id, amount: kind === 'repayment-repayment' ? 200 : 25, paymentMethod: 'cash', paidAt: new Date().toISOString() })
    }
    const archive = async () => { const { setOrderArchived } = await import('@/local-db/orderArchiving'); return setOrderArchived(s.order!.id, 'sales', true) }
    const pairs: Record<typeof kind, [() => Promise<unknown>, () => Promise<unknown>]> = {
        'complete-complete': [complete, complete], 'complete-cancel': [complete, cancel], 'return-return': [returned, returned],
        'return-repayment': [returned, payment], 'cancel-repayment': [cancel, payment], 'repayment-repayment': [payment, payment],
        'edit-approve': [() => orders.updateSalesOrder(s.order!.id, { notes: `${s.fixture.tag} race edit` }), () => orders.approveSalesOrderRequest(s.order!.id)],
        'archive-return': [archive, returned]
    }
    await s.step(`independent conflicting requests: ${kind}`, async () => {
        const outcomes = await Promise.allSettled(pairs[kind].map(action => action()))
        expect(outcomes.some(row => row.status === 'fulfilled')).toBe(true)
    }, { check: graph => {
        const current = graph.tables.orders.find(row => row.id === s.order!.id)!
        if (kind === 'complete-complete') {
            expect(current.status).toBe('completed')
            expect(graph.tables.movements.filter(row => row.reference_id === current.id && Number(row.quantity_delta) < 0)).toHaveLength(1)
        }
        if (kind === 'complete-cancel') {
            expect(['completed', 'cancelled']).toContain(current.status)
            if (current.status === 'cancelled') expect(graph.tables.movements.filter(row => row.reference_id === current.id && Number(row.quantity_delta) < 0)).toHaveLength(0)
        }
        if (kind === 'return-return') { expect(current.return_status).toBe('full'); expect(graph.tables.returns.filter(row => row.order_id === current.id)).toHaveLength(1) }
        if (kind === 'repayment-repayment') expect(sum(active(graph.tables.loanPayments), 'amount')).toBe(200)
    } })
}
export async function concurrency(s: HostedScenario) {
    const i = Number(s.family.id.slice(-2))
    const orders = await import('@/local-db/orders')
    if (i === 1 || i === 2) {
        await s.create(s.input({ paid: true })); await s.status('pending')
        const payload = completionPayload(s, await readGraph(s.observer, s.scope))
        const other = i === 1 ? payload : { ...payload, p_operation_id: crypto.randomUUID() }
        await s.step('simultaneous completion request identity', async () => {
            const results = await Promise.allSettled([s.rpc(liveSupabase, 'complete_sales_order_with_inventory', payload), s.rpc(liveSupabase, 'complete_sales_order_with_inventory', other)])
            expect(results.filter(row => row.status === 'fulfilled').length).toBe(i === 1 ? 2 : 1)
        }, { status: 'completed', stockDelta: -2 }); return
    }
    if (i === 3 || i === 4 || i === 16) {
        await s.create(s.input({ paid: true })); await s.status('pending')
        const payload = completionPayload(s, await readGraph(s.observer, s.scope))
        s.fault = { path: '/rpc/complete_sales_order_with_inventory', occurrence: 1, seen: 0, mode: i === 3 ? 'after' : 'before' }
        await s.step('atomic completion transport fault', () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', payload), { denied: true, ...(i === 3 ? { stockDelta: -2, status: 'completed' } : { unchanged: true }) })
        s.fault = null
        await s.step('same operation retry after transport recovery', () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', payload), i === 3 ? { unchanged: true } : { status: 'completed', stockDelta: -2 }); return
    }
    if (i === 5) {
        const { chain, path, mode } = s.variant!
        if (chain === 'approve') await s.create(s.input({ paid: true, approval: true }))
        else if (chain === 'return') await s.complete()
        else if (chain === 'settle') await s.create(s.input({ method: 'fib' }), 'quick', 'completed')
        else if (chain === 'cancel') { await s.create(s.input({ method: 'loan', initial: 25 })); await s.status('pending') }
        s.fault = { path, occurrence: 1, seen: 0, mode }
        if (chain === 'approve') await s.approve({ interrupted: true })
        else if (chain === 'return') await s.returned(1, 0, { interrupted: true })
        else if (chain === 'settle') await s.pay(50, 'cash', null, { interrupted: true })
        else if (chain === 'cancel') await s.step('interrupt financed cancellation', () => s.rpc(liveSupabase, 'cancel_order_with_financing', { p_order_type: 'sales', p_order_id: s.order!.id }), { interrupted: true })
        else await s.step(`interrupt save boundary ${path}/${mode}`, () => orders.createSalesOrder(liveWorkspaceId, s.input({ paid: true }), undefined, { requireRemoteConfirmation: true }), { interrupted: true })
        s.fault = null
        return
    }
    if (i === 6) {
        await s.create(s.input({ paid: true })); await s.status('pending')
        const payload = completionPayload(s, await readGraph(s.observer, s.scope))
        const restarted = await freshObserver()
        try { await s.step('new session completes persisted pending order', () => s.rpc(restarted, 'complete_sales_order_with_inventory', payload), { status: 'completed', stockDelta: -2 }) }
        finally { restarted.auth.stopAutoRefresh() }
        return
    }
    if (i === 7 || i === 8) { await s.create(s.input({ paid: true, method: i === 8 ? 'loan' : 'cash', initial: i === 8 ? 25 : 0 })); await s.status('pending'); await race(s, i === 7 ? 'complete-complete' : 'complete-cancel'); return }
    if (i === 9 || i === 10) { await s.complete(s.input({ method: i === 10 ? 'loan' : 'cash', paid: i !== 10 })); await race(s, i === 9 ? 'return-return' : 'return-repayment'); return }
    if (i === 11) { await s.create(s.input({ method: 'loan' })); await s.status('pending'); await race(s, 'cancel-repayment'); return }
    if (i === 12) { await s.create(s.input({ paid: true, approval: true })); await race(s, 'edit-approve'); return }
    if (i === 13) {
        const { commissionSetup } = await import('./commissions')
        const setup = await commissionSetup(s)
        const { recordAgentCommissionPayout } = await import('@/local-db/agentCommissions')
        await s.step('payout races return', async () => {
            const results = await Promise.allSettled([recordAgentCommissionPayout(liveWorkspaceId, { orderId: s.order!.id, agentId: setup.agentId!, assignmentId: setup.assignment.id, amount: 12, currency: 'usd', paymentMethod: 'cash' }), orders.returnSalesOrder({ orderId: s.order!.id, items: [{ orderItemId: s.order!.items[0].id, paidQuantity: 2 }], reason: 'customer_returned', actorRole: 'admin' })])
            expect(results.some(row => row.status === 'fulfilled')).toBe(true)
        }); return
    }
    if (i === 14) { await s.complete(); await race(s, 'archive-return'); return }
    if (i === 15) {
        await s.create(s.input({ paid: true, quantity: 100 })); const first = s.order!
        await s.status('pending')
        await s.create(s.input({ paid: true, quantity: 100 })); const second = s.order!
        // Bypass the client reservation lock; both requests hit the real server with the same stock/version.
        const graph = await readGraph(s.observer, s.scope)
        s.order = first; const p1 = completionPayload(s, graph)
        s.order = second; const p2 = completionPayload(s, graph)
        await s.step('last-stock competing server transactions', async () => {
            const outcomes = await Promise.allSettled([s.rpc(liveSupabase, 'complete_sales_order_with_inventory', p1), s.rpc(liveSupabase, 'complete_sales_order_with_inventory', p2)])
            expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
        }, { stockDelta: -100 }); return
    }
    if (i === 17) return atomicReplay(s, 'regular', true)
    // Generated values are additional sequence coverage; finite choices above are never sampled away.
    let seed = Number(process.env.ATLAS_TEST_SEED ?? 20260918) >>> 0
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const samples = Number(process.env.ATLAS_TEST_SAMPLES ?? 16)
    for (let sample = 0; sample < samples; sample++) {
        await withScenario({ ...s.family, id: `${s.family.id}/seed-${seed}/sample-${sample}` }, async nested => {
            const method = random() % 2 ? 'cash' : 'loan'
            await nested.create(nested.input({ method, quantity: 4 }))
            for (let step = 0; step < 16; step++) await nested.edit({ shippingAddress: `DEV TEST generated ${random()}`, notes: `${nested.fixture.tag} model ${step}` })
            if (method === 'cash') await nested.pay(400)
            await nested.status('pending'); await nested.status('completed')
            for (let step = 0; step < 16; step++) {
                const choice = random() % 4
                if (choice === 0) await nested.edit({ notes: 'invalid terminal edit' }, denied)
                else if (choice === 1) await nested.status('cancelled', denied)
                else if (choice === 2) await nested.status('pending', denied)
                else await nested.returned(0.25)
            }
            const graph = await readGraph(nested.observer, nested.scope)
            assertGraph(graph, nested.baseline)
        })
    }
}

export async function runnerEvidence(s: HostedScenario) {
    const i = Number(s.family.id.slice(-2))
    if (i === 4 || i === 8) {
        const f = requireFixture(s.family.id)
        if (i === 4) { if (typeof f.requiredCapability !== 'string') throw new HostedBlocked('disabled-capability fixture'); expect(f.expectedOutcome).toBe('blocked') }
        else {
            const { existingFixture } = await import('./security'); await existingFixture(s, f)
            const graph = await readGraph(s.observer, s.scope)
            const current = graph.tables.orders.find(row => row.id === s.order!.id)!
            const payload = f.operationPayload
            if (!payload || typeof payload !== 'object') throw new HostedBlocked('original completion operationPayload required for receipt-safe resume')
            const input = payload as Record<string, any>
            if (input.p_order_id !== current.id || input.p_workspace_id !== liveWorkspaceId) throw new Error('hosted_resume_payload_identity_invalid')
            await s.step('resume exact persisted completion operation', () => s.rpc(liveSupabase, 'complete_sales_order_with_inventory', input), current.status === 'completed' ? { unchanged: true } : { status: 'completed' })
        }
        return
    }
    if (i === 3) {
        const profile = await liveSupabase.from('profiles').select('current_workspace,role').eq('id', (await liveSupabase.auth.getUser()).data.user!.id).single()
        expect(profile.error).toBeNull(); expect(profile.data).toMatchObject({ current_workspace: liveWorkspaceId, role: 'admin' }); return
    }
    if (i === 9) {
        await s.create()
        await s.step('observer read failure is a failure, never an empty graph', async () => {
            const failed = await s.observer.schema('crm').from('sales_orders').select('not_a_real_column').eq('id', s.order!.id)
            expect(failed.error).toBeTruthy()
            throw new Error('hosted_read_failed: expected failure witness')
        }, denied); return
    }
    if (i === 6 || i === 7) {
        if (i === 6) await Promise.all(['A', 'B'].map(key => withScenario({ ...s.family, id: `${s.family.id}/${key}` }, async child => { await child.complete() })))
        else { await s.create(s.input({ paid: true })); await s.status('pending'); await race(s, 'complete-complete') }
        return
    }
    await s.complete()
    if (i === 10 || i === 11) await s.returned(2, 0, { stockDelta: 2, paymentDelta: -200, total: 0 })
    if (i === 12) {
        await s.step('preserve failure evidence without changing records', async () => { throw new Error('DEV TEST expected diagnostic') }, denied)
        await s.save({ before: s.baseline, after: await readGraph(s.observer, s.scope) })
    }
    if (i === 5) { expect(s.family.id).toMatch(/^SO-H30-05$/); expect(Number(process.env.ATLAS_TEST_SEED)).toBeGreaterThanOrEqual(0) }
    if (i === 1 || i === 2) {
        const { default: catalog } = await import('./catalog.json')
        expect(catalog).toHaveLength(30); expect(catalog.flatMap(group => group.cases)).toHaveLength(418)
        expect(graphHash(await readGraph(s.observer, s.scope))).toMatch(/^[a-f0-9]{64}$/)
    }
}
