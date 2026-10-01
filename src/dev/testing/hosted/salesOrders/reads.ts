import { expect } from 'vitest'
import { liveWorkspaceId, requireLiveData } from '../../fixtures/saleOrdersLive'
import { active, money, readGraph, sum } from './graph'
import { HostedScenario, requireFixture } from './harness'
import { HostedBlocked, type Row } from './types'
import { CURRENCIES, historicalFactor, historicalRates } from './choices'
export async function readPaths(s: HostedScenario) {
    const i = Number(s.family.id.slice(-2))
    if (i === 5 || i === 6) {
        const count = i === 6 ? 201 : s.variant?.count ?? 201
        const createdAt = '2026-01-01T12:00:00.000Z'
        const { createSalesOrder } = await import('@/local-db/orders')
        // Actual hosted rows cross the Data API page limits. Cache rows never supply pagination evidence.
        for (let start = 0; start < count; start += 16) await s.step(`create pagination rows ${start}-${Math.min(start + 16, count)}`, async () => {
            const created = await Promise.all(Array.from({ length: Math.min(16, count - start) }, () => createSalesOrder(liveWorkspaceId, { ...s.input(), ...(i === 6 ? { createdAt } : {}) }, undefined, { requireRemoteConfirmation: true })))
            for (const row of created) s.scope.orderIds.add(row.id)
            s.order = created.at(-1)!
        }, { stockDelta: 0, paymentDelta: 0 })
        await s.step('complete independently paginated hosted order read', async () => {
            const rows: Row[] = [], seen = new Set<string>()
            for (let offset = 0; ; offset += 200) {
                const page = requireLiveData<Row[]>(await s.observer.schema('crm').from('sales_orders').select('*').eq('workspace_id', liveWorkspaceId).like('notes', `${s.fixture.tag}%`).order('created_at').order('id').range(offset, offset + 199), 'real pagination boundary')
                for (const row of page) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); rows.push(row) }
                if (page.length < 200) break
            }
            expect(rows).toHaveLength(count)
            expect([...seen].sort()).toEqual([...s.scope.orderIds].sort())
            if (i === 6) expect(new Set(rows.map(row => row.created_at)).size).toBe(1)
        }, { unchanged: true })
        return
    }
    if (i === 11 || i === 14) {
        const f = requireFixture(s.family.id)
        if (i === 11) {
            const { existingFixture } = await import('./security'); await existingFixture(s, f)
            const graph = await readGraph(s.observer, s.scope)
            expect(graph.tables.invoiceVersions.length).toBeGreaterThan(0)
            expect(new Set(graph.tables.invoiceVersions.map(row => `${row.invoice_id}/${row.version_number}`)).size).toBe(graph.tables.invoiceVersions.length)
            return
        }
        if (!f.realtimeReady) throw new HostedBlocked('Realtime publication enabled fixture')
        await s.create()
        await s.step('hosted Realtime order event and fresh reconciliation', async () => {
            const channel = s.observer.channel(`${s.family.id}-${crypto.randomUUID()}`)
            let resolveEvent!: () => void
            const changed = new Promise<void>(resolve => { resolveEvent = resolve })
            const subscribed = new Promise<void>((resolve, reject) => {
                channel.on('postgres_changes', { event: 'UPDATE', schema: 'crm', table: 'sales_orders', filter: `id=eq.${s.order!.id}` }, () => resolveEvent())
                    .subscribe(status => { if (status === 'SUBSCRIBED') resolve(); else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error('hosted_realtime_unavailable')) })
            })
            try {
                await Promise.race([subscribed, new Promise((_, reject) => setTimeout(() => reject(new Error('hosted_realtime_subscription_timeout')), 15000))])
                await s.edit({ notes: `${s.fixture.tag} realtime` })
                await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('hosted_realtime_event_timeout')), 15000))])
            } finally { await s.observer.removeChannel(channel) }
        }); return
    }
    if (i === 7 || i === 8 || i === 9) {
        if (i === 9) { const { commissionSetup } = await import('./commissions'); await commissionSetup(s) }
        else for (const currency of CURRENCIES) {
            const input = s.input({ method: i === 8 ? 'loan' : 'fib', currency })
            input.exchangeRates = historicalRates()
            await s.create(input, 'quick', 'completed')
        }
        if (i === 7) {
            const receipt = await s.pay(50)
            const { reversePaymentTransaction } = await import('@/local-db/payments')
            await s.step('ledger partial counter-entry', () => reversePaymentTransaction(liveWorkspaceId, receipt!.transaction.id, { amount: 25 }), { paymentDelta: -25 })
        } else if (i === 8) {
            const { repay } = await import('./financing')
            await repay(s, 25)
            await s.returned(1)
        }
        const partners = await import('@/local-db/businessPartners')
        await s.step('refresh hosted partner projection', () => partners.recalculateBusinessPartnerSummary(liveWorkspaceId, s.fixture.partner.id, { ensureSync: true }))
        await s.step('independent persisted partner projection and per-currency statement', async () => {
            const graph = await readGraph(s.observer, s.scope)
            if (i === 7 || i === 8) {
                // Raw partner SELECT is revoked by design. The scoped read RPC returns the stored projection.
                const partner = requireLiveData<Row>(await s.observer.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: liveWorkspaceId }).eq('id', s.fixture.partner.id).single(), 'persisted partner projection')
                const outstanding = i === 8 ? active(graph.tables.loans).reduce((total, loan) => total + Number(loan.balance_amount) * historicalFactor(loan.settlement_currency, partner.default_currency), 0) : graph.tables.orders.reduce((total, order) => total + Number(order.balance_amount) * historicalFactor(order.currency, partner.default_currency), 0)
                expect(Number(partner.receivable_balance)).toBeCloseTo(money(outstanding), 3)
                if (i === 8) expect(Number(partner.loan_outstanding_balance)).toBeCloseTo(money(outstanding), 3)
            }
            const { toCamelCase } = await import('@/lib/utils')
            const { buildPartnerAccountStatementLedger } = await import('@/lib/partnerAccountStatement')
            const loanSources = new Set(['loan_payment', 'simple_loan', 'loan_installment'])
            const settlementSources = new Set(['sales_order', 'purchase_order', 'direct_transaction'])
            const ledger = buildPartnerAccountStatementLedger({ partnerId: s.fixture.partner.id, period: { type: 'allTime' },
                salesOrders: graph.tables.orders.map(row => toCamelCase(row)) as any, purchaseOrders: [],
                loans: graph.tables.loans.map(row => toCamelCase(row)) as any, loanPayments: graph.tables.loanPayments.map(row => toCamelCase(row)) as any,
                // Match the production statement's distinct loan and ordinary settlement inputs.
                loanPaymentTransactions: graph.tables.payments.filter(row => loanSources.has(row.source_type)).map(row => toCamelCase(row)) as any,
                settlementTransactions: graph.tables.payments.filter(row => settlementSources.has(row.source_type)).map(row => toCamelCase(row)) as any,
                salesOrderReturns: graph.tables.returns.map(row => toCamelCase(row)) as any,
                salesOrderReturnItems: graph.tables.returnItems.map(row => toCamelCase(row)) as any,
                agentCommissionEntries: graph.tables.commissions.map(row => toCamelCase(row)) as any,
                agentProductCommissionEntries: graph.tables.productCommissions.map(row => toCamelCase(row)) as any })
            for (const currency of CURRENCIES) {
                const expected = i === 8 ? sum(active(graph.tables.loans).filter(row => row.settlement_currency === currency), 'balance_amount') : graph.tables.orders.filter(row => row.currency === currency).reduce((total, row) => total + Number(row.total) - Number(row.paid_amount), 0)
                const actual = ledger.find(row => row.currency === currency)
                expect(actual?.closingBalance ?? 0).toBeCloseTo(money(expected), 3)
            }
        }, { unchanged: true })
        return
    }
    await s.complete()
    if (i === 10) {
        const { saveInvoiceFromSnapshot } = await import('@/local-db/hooks')
        await s.step('persist invoice snapshot parent through production save', () => saveInvoiceFromSnapshot(liveWorkspaceId, {
            total: s.order!.total, totalAmount: s.order!.total, settlementCurrency: s.order!.currency, origin: 'sales_order',
            sourceId: s.order!.id, orderId: s.order!.id, isSnapshot: true, createdBy: s.order!.createdBy ?? undefined,
            createdByName: 'DEV TEST', cashierName: 'DEV TEST', printFormat: 'a4'
        } as any), { check: graph => {
            expect(graph.tables.invoices).toHaveLength(1); expect(graph.tables.invoices[0]).toMatchObject({ order_id: s.order!.id, source_id: s.order!.id, is_snapshot: true, settlement_currency: 'usd' })
        } }); return
    }
    if (i === 13) {
        s.fault = { path: '/rpc/sync_business_partner', occurrence: 1, seen: 0, mode: 'before' }
        const { recalculateBusinessPartnerSummary } = await import('@/local-db/businessPartners')
        await s.step('projection request fails after authoritative sale', () => recalculateBusinessPartnerSummary(liveWorkspaceId, s.fixture.partner.id, { ensureSync: true }), { denied: true })
        s.fault = null; return
    }
    if (i === 15) {
        const { runSalesOrderIntegrityAudit } = await import('@/lib/integrityAudit/salesOrderAudit')
        await s.step('application audit resolves only hosted graph', async () => {
            const audit = await runSalesOrderIntegrityAudit(liveWorkspaceId, s.order!.id, 'cloud')
            expect(audit.checks.length).toBeGreaterThan(0)
            expect(audit.checks.filter(row => row.status === 'FAIL')).toEqual([])
        }, { unchanged: true }); return
    }
    if (i === 2) {
        const { setOrderArchived } = await import('@/local-db/orderArchiving')
        await s.returned(2); await s.step('archive read fixture', () => setOrderArchived(s.order!.id, 'sales', true))
    }
    await s.step('fresh hosted filter/pagination/detail source', async () => {
        let query = s.observer.schema('crm').from('sales_orders').select('*').eq('workspace_id', liveWorkspaceId).in('id', [...s.scope.orderIds])
        if (i === 2) query = query.eq('is_archived', true).eq('is_deleted', false)
        if (i === 3) query = query.eq('status', s.variant?.status ?? 'completed').eq('payment_status', s.variant?.paymentStatus ?? 'paid').eq('return_status', s.variant?.returnStatus ?? 'none')
        if (i === 4) query = query.eq('customer_id', s.order!.customerId).gte('created_at', s.baseline.tables.products[0].created_at).like('notes', `${s.fixture.tag}%`)
        const rows: Row[] = []
        const size = i === 5 || i === 6 ? 1 : 200
        for (let offset = 0; ; offset += size) {
            const result = await query.order('created_at').order('id').range(offset, offset + size - 1)
            const page = requireLiveData<Row[]>(result, 'hosted order page')
            rows.push(...page)
            if (page.length < size) break
        }
        const all = (await readGraph(s.observer, s.scope)).tables.orders
        const expected = i === 3 ? all.filter(row => row.status === (s.variant?.status ?? 'completed') && row.payment_status === (s.variant?.paymentStatus ?? 'paid') && row.return_status === (s.variant?.returnStatus ?? 'none')) : all
        expect(rows.map(row => row.id).sort()).toEqual(expected.map(row => row.id).sort())
        expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
        for (const row of rows) expect(row.items[0].productName).toBe(s.fixture.product.name)
        if (i === 12) expect(rows[0]).toMatchObject({ order_number: s.order!.orderNumber, total: s.order!.total })
    }, { unchanged: true })
}
