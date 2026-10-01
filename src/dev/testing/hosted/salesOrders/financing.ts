import { expect } from 'vitest'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId } from '../../fixtures/saleOrdersLive'
import { active, money, readGraph, sum } from './graph'
import { HostedScenario, requireFixture } from './harness'
import type { Row } from './types'
import { CURRENCIES, uom } from './choices'

const denied = { denied: true, unchanged: true }
const index = (s: HostedScenario) => Number(s.family.id.slice(-2))
export async function repay(s: HostedScenario, amount: number, options: Row = {}, expected: Parameters<HostedScenario['step']>[2] = {}) {
    const { recordLoanPayment, fetchTableFromSupabase } = await import('@/local-db/hooks')
    const { db } = await import('@/local-db/database')
    // Activation's ordinary hydration may reuse a recently fetched table. This hosted-only
    // action needs current server rows as its cache prerequisites, independently of UI freshness.
    for (const table of ['loans', 'loan_installments', 'loan_payments', 'payment_transactions'] as const) {
        if (!await fetchTableFromSupabase(table, db[table] as any, liveWorkspaceId, { force: true })) throw new Error(`hosted_repayment_prerequisite_read_failed:${table}`)
    }
    const graph = await readGraph(s.observer, s.scope)
    const loan = active(graph.tables.loans).find(row => row.order_id === s.order!.id)
    if (!loan) throw new Error('hosted_linked_loan_missing')
    return s.step(`linked loan repayment ${amount}`, () => recordLoanPayment(liveWorkspaceId, { loanId: loan.id, amount, paymentMethod: 'cash', paidAt: new Date().toISOString(), ...options }), expected)
}
export async function activation(s: HostedScenario) {
    const i = index(s)
    if ([10, 11, 14].includes(i)) {
        const { existingFixture } = await import('./security')
        await existingFixture(s, requireFixture(s.family.id))
        if (i === 14) { await s.status('pending'); return }
        await s.step('invalid loan/order linkage activation', () => s.rpc(liveSupabase, 'activate_financed_order', { p_order_type: 'sales', p_order_id: s.order!.id, p_target_status: 'pending' }), denied)
        return
    }
    if (i === 5) {
        const orders = await import('@/local-db/orders')
        for (const amount of [-1, 0, 0.001, 199.999, 200, 200.001]) {
            const input = s.input({ method: 'loan', initial: amount })
            await s.step(`financing initial amount ${amount}`, async () => {
                s.order = await orders.createSalesOrder(liveWorkspaceId, input, undefined, { requireRemoteConfirmation: true }); s.scope.orderIds.add(s.order.id)
            }, amount < 0 || amount >= 200 ? denied : {})
        }
        return
    }
    const currencies = s.variant ? [s.variant.currency] : i === 7 ? CURRENCIES : ['usd'] as const
    for (const currency of currencies) {
        const method = i === 3 || i === 4 ? 'installments' : 'loan'
        const input = s.input({ method, currency, initial: i === 2 || i === 4 || i === 12 ? 25 : 0, approval: i === 9 })
        if (i === 6) input.firstDueDate = input.nextDueDate = null
        if (i === 12) {
            const f = requireFixture(s.family.id)
            input.initialPaymentAccountId = String(f.accountId)
        }
        await s.create(input)
        if (i === 9) {
            await s.status('pending', denied); await s.approve(); await s.status('pending'); continue
        }
        if (i === 12) { await s.status('pending', denied); continue }
        await s.status('pending', { check: graph => {
            const order = graph.tables.orders.find(row => row.id === s.order!.id)!
            const loan = active(graph.tables.loans).filter(row => row.order_id === order.id)
            expect(loan).toHaveLength(1)
            expect(order.linked_loan_id).toBe(loan[0].id)
            expect(loan[0].settlement_currency).toBe(currency)
            expect(Number(loan[0].balance_amount)).toBeCloseTo(200 - Number(input.initialPaymentAmount), 3)
            if (method === 'loan') expect(Number(loan[0].principal_amount)).toBe(200)
        } })
        if (i === 8) await s.step('repeat activation cannot duplicate financing', () => s.rpc(liveSupabase, 'activate_financed_order', { p_order_type: 'sales', p_order_id: s.order!.id, p_target_status: 'pending' }), { check: graph => expect(active(graph.tables.loans).filter(row => row.order_id === s.order!.id)).toHaveLength(1) })
        if (i === 13) { const { race } = await import('./resilience'); await race(s, 'complete-cancel') }
        else if (i === 7) await s.status('cancelled')
    }
}

export async function schedule(s: HostedScenario) {
    const i = index(s)
    const orders = await import('@/local-db/orders')
    if (i === 3) {
        for (const count of [0, -1, 1.5, 121]) for (const frequency of ['weekly', 'monthly', 'daily', 'bogus', null]) {
            const input = { ...s.input({ method: 'installments' }), installmentCount: count, installmentFrequency: frequency }
            await s.step(`invalid schedule ${count}/${frequency}`, () => orders.createSalesOrder(liveWorkspaceId, input as any, undefined, { requireRemoteConfirmation: true }), denied)
        }
        return
    }
    if (i === 1 || i === 2 || i === 4 || i === 5 || i === 13) {
        const frequencies = s.variant ? [s.variant.frequency] : i === 1 || i === 2 || i === 4 ? ['weekly', 'biweekly', 'monthly'] as const : ['monthly'] as const
        const counts = s.variant ? [s.variant.count] : i === 2 ? Array.from({ length: 120 }, (_, n) => n + 1) : i === 5 ? [3, 7, 9, 11] : [2]
        const dates = s.variant?.due ? [s.variant.due] : s.variant?.offset !== undefined ? [new Date(Date.now() + s.variant.offset * 86400000).toISOString()] : i === 4 ? ['2028-02-29T12:00:00.000Z', '2027-01-31T12:00:00.000Z', '2027-12-31T12:00:00.000Z'] : i === 13 ? [new Date(Date.now() - 86400000).toISOString(), new Date().toISOString(), new Date(Date.now() + 86400000).toISOString()] : [new Date(Date.now() + 30 * 86400000).toISOString()]
        for (const frequency of frequencies) for (const count of counts) for (const due of dates) {
            const input = { ...s.input({ method: 'installments', price: i === 5 ? 50.0005 : 100 }), installmentCount: count, installmentFrequency: frequency, firstDueDate: due, nextDueDate: due }
            await s.create(input); await s.status('pending', { check: graph => {
                const loan = active(graph.tables.loans).find(row => row.order_id === s.order!.id)!
                const rows = active(graph.tables.loanInstallments).filter(row => row.loan_id === loan.id).sort((a, b) => a.installment_no - b.installment_no)
                expect(rows).toHaveLength(count)
                expect(Number(loan.installment_count)).toBe(count)
                expect(money(sum(rows, 'planned_amount'))).toBeCloseTo(Number(loan.principal_amount), 3)
                expect(rows.every(row => Number(row.planned_amount) >= 0 && !Number.isNaN(Date.parse(row.due_date)))).toBe(true)
                const first = new Date(due)
                for (let j = 0; j < rows.length; j++) {
                    const expectedDate = new Date(first)
                    if (frequency === 'monthly') {
                        const month = first.getUTCMonth() + j
                        const day = Math.min(first.getUTCDate(), new Date(Date.UTC(first.getUTCFullYear(), month + 1, 0)).getUTCDate())
                        expectedDate.setUTCFullYear(first.getUTCFullYear(), month, day)
                    } else expectedDate.setUTCDate(first.getUTCDate() + j * (frequency === 'weekly' ? 7 : 14))
                    expect(rows[j].due_date.slice(0, 10)).toBe(expectedDate.toISOString().slice(0, 10))
                }
                if (frequency === 'weekly' || frequency === 'biweekly') for (let j = 1; j < rows.length; j++) expect(Date.parse(rows[j].due_date) - Date.parse(rows[j - 1].due_date)).toBe((frequency === 'weekly' ? 7 : 14) * 86400000)
            } }); await s.status('cancelled')
        }
        return
    }
    await s.create(s.input({ method: 'installments' })); await s.status('pending')
    const graph = await readGraph(s.observer, s.scope)
    const loan = active(graph.tables.loans).find(row => row.order_id === s.order!.id)!
    const installments = active(graph.tables.loanInstallments).filter(row => row.loan_id === loan.id).sort((a, b) => a.installment_no - b.installment_no)
    if (i === 9) {
        await repay(s, 201, {}, denied); await repay(s, 0, {}, denied); await repay(s, 10, { paymentMethod: 'bogus' }, denied); return
    }
    if (i === 14) { const { race } = await import('./resilience'); await race(s, 'repayment-repayment'); return }
    const amount = i === 6 ? 25 : i === 12 ? 200 : i === 7 ? 150 : 100
    const payment = await repay(s, amount, i === 8 ? { installmentId: installments.at(-1)!.id } : i === 6 ? { installmentId: installments[0].id } : {}, { paymentDelta: amount })
    if (i === 6) await repay(s, 75, { installmentId: installments[0].id }, { paymentDelta: 75 })
    if (i === 10) {
        const fresh = await readGraph(s.observer, s.scope)
        const tx = fresh.tables.payments.find(row => row.id === payment!.payment.paymentTransactionId)!
        const { toCamelCase } = await import('@/lib/utils')
        const { reverseLoanPayment } = await import('@/local-db/hooks')
        await s.step('reverse linked loan receipt atomically', () => reverseLoanPayment(liveWorkspaceId, toCamelCase(tx) as any), { paymentDelta: -amount })
    }
    await s.step('repayment schedule and source links', async () => undefined, { unchanged: true, check: graph => {
        for (const row of active(graph.tables.loanPayments)) expect(graph.tables.payments.some(tx => tx.id === row.payment_transaction_id && tx.source_record_id === row.loan_id)).toBe(true)
        if (i === 12) expect(active(graph.tables.loans).find(row => row.id === loan.id)?.status).toBe('completed')
    } })
}

export async function financedReturn(s: HostedScenario) {
    const i = index(s)
    if ([12, 13].includes(i)) {
        const { existingFixture } = await import('./security')
        await existingFixture(s, requireFixture(s.family.id)); await s.returned(1, 0, denied); return
    }
    const method = [7, 11].includes(i) ? 'installments' : 'loan'
    const input = s.input({ method, initial: i === 8 ? 25 : 0, free: i === 14 ? 1 : 0 })
    if (i === 14) {
        const unit = await uom(s)
        input.items[0] = { ...input.items[0], unitFactor: 20, inventoryQuantity: 40, freeBonusInventoryQuantity: 20, uomId: unit.id, unitRef: 'builtin:carton', unit: 'carton', uomCostPrice: 40, convertedUomCostPrice: 40 }
    }
    await s.create(input); await s.status('pending'); await s.status('completed')
    const paymentAmounts = i === 1 ? [25] : i === 2 ? [100] : i === 3 ? [150] : i === 4 ? [200] : i === 9 ? [30, 70, 75] : i === 10 ? [150] : []
    for (const amount of paymentAmounts) await repay(s, amount)
    if (i === 15) { const { race } = await import('./resilience'); await race(s, 'return-repayment'); return }
    if (i === 16) {
        s.fault = { path: '/order_returns', occurrence: 1, seen: 0, mode: 'before' }
        await s.returned(1, 0, { denied: true }); s.fault = null; return
    }
    const before = await readGraph(s.observer, s.scope)
    const debtBefore = Number(active(before.tables.loans).find(row => row.order_id === s.order!.id)?.balance_amount)
    const returnedValue = [6, 7, 8, 9].includes(i) ? 200 : 100
    await s.returned(returnedValue / 100, i === 14 ? 1 : 0, { check: graph => {
        const loan = graph.tables.loans.find(row => row.order_id === s.order!.id)!
        expect(Number(loan.balance_amount)).toBeCloseTo(Math.max(0, debtBefore - returnedValue), 3)
        const moneyDelta = money(sum(active(graph.tables.payments), 'amount') - sum(active(before.tables.payments), 'amount'))
        expect(moneyDelta).toBeCloseTo(-Math.max(0, returnedValue - debtBefore), 3)
        const principalBefore = Number(before.tables.loans.find(row => row.id === loan.id)!.principal_amount)
        const currentOrder = graph.tables.orders.find(row => row.id === s.order!.id)!
        expect(Number(loan.principal_amount)).toBe(currentOrder.return_status === 'full' ? principalBefore : Math.max(0, principalBefore - returnedValue))
    } })
    if (i === 5) await s.returned(1)
    if (i === 11) {
        await s.step('schedule redistributed without losing debt history', async () => undefined, { unchanged: true, check: graph => {
            const loan = active(graph.tables.loans).find(row => row.order_id === s.order!.id)!
            expect(money(sum(active(graph.tables.loanInstallments).filter(row => row.loan_id === loan.id), 'balance_amount'))).toBe(Number(loan.balance_amount))
        } })
    }
}
