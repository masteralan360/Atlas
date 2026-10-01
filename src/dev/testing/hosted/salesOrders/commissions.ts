import { expect } from 'vitest'
import { liveSupabase } from '../../liveSupabase'
import { liveWorkspaceId, recordLiveFixture, requireLiveData } from '../../fixtures/saleOrdersLive'
import { active, canonical, readGraph, sum } from './graph'
import { HostedScenario, requireFixture } from './harness'
import { HostedBlocked, type Row } from './types'

const denied = { denied: true, unchanged: true }
const index = (s: HostedScenario) => Number(s.family.id.slice(-2))
async function capability(s: HostedScenario) {
    const workspace = requireLiveData<Row>(await s.observer.from('workspaces').select('plan').eq('id', liveWorkspaceId).single(), 'commission workspace')
    const allowed = await s.rpc(s.observer, 'workspace_module_allowed', { p_workspace_id: liveWorkspaceId, p_plan: workspace.plan, p_module: 'sales_agent_commissions' })
    if (allowed !== true) throw new HostedBlocked('sales agent commissions are unavailable in this test workspace')
    const agents = await s.rpc(s.observer, 'workspace_module_allowed', { p_workspace_id: liveWorkspaceId, p_plan: workspace.plan, p_module: 'agents' })
    if (agents !== true) throw new HostedBlocked('Agents module is unavailable in this test workspace')
}
export async function commissionSetup(s: HostedScenario, options: { fixed?: boolean; amount?: number; product?: boolean; tracked?: boolean; manual?: boolean; tax?: boolean; delivery?: boolean } = {}) {
    await capability(s)
    const partners = await import('@/local-db/businessPartners')
    const commissions = await import('@/local-db/agentCommissions')
    const partner = await partners.createBusinessPartner(liveWorkspaceId, {
        partnerName: `${s.fixture.tag} commission agent`, phone: '', defaultCurrency: 'usd', creditLimit: 0, role: 'agent',
        agent: { agentType: 'field_agent', status: 'active', zone: 'DEV TEST' }
    }, { allowAgentRole: true })
    if (!partner.agentFacetId) throw new Error('hosted_commission_agent_missing')
    s.scope.partnerIds.add(partner.id)
    s.fixture.ids.agentId = partner.agentFacetId
    recordLiveFixture(s.fixture.ids)
    let plan: Awaited<ReturnType<typeof commissions.createAgentCommissionPlan>> | null = null
    if (!options.manual) {
        plan = await commissions.createAgentCommissionPlan(liveWorkspaceId, {
            name: `${s.fixture.tag} commission plan`, level: s.fixture.tag, commissionType: options.fixed ? 'fixed_amount' : 'percentage',
            ratePercent: options.fixed ? 0 : 10, fixedAmount: options.fixed ? options.amount ?? 10 : null,
            fixedCurrency: options.fixed ? 'usd' : null, calculationBasis: 'net_profit', includeTax: options.tax ?? false,
            includeDeliveryCharge: options.delivery ?? false, tierName: 'DEV TEST tier', effectiveFrom: new Date(Date.now() - 60000).toISOString()
        })
        await commissions.setAgentCommissionMembership(liveWorkspaceId, { agentId: partner.agentFacetId, planId: plan.id })
    }
    if (options.product) {
        const { replaceProductCommissionRule } = await import('@/local-db/productCommissions')
        await replaceProductCommissionRule(liveWorkspaceId, s.fixture.product.id, { commissionType: 'fixed_amount', fixedAmount: 5, fixedCurrency: 'usd', recipientScope: 'all_assigned', effectiveFrom: new Date(Date.now() - 60000).toISOString() })
    }
    const input = s.input({ paid: true })
    input.commissionEnabled = true
    input.commissionMode = options.tracked ? 'tracked' : 'payable'
    await s.create(input)
    const assignment = await s.step('assign commissioned sales agent', () => commissions.assignSalesOrderAgent(liveWorkspaceId, {
        orderId: s.order!.id, agentId: partner.agentFacetId!, customerCitySnapshot: 'DEV TEST city', deliveryChargeAmount: options.delivery ? 10 : 0,
        internalDeliveryCostAmount: options.delivery ? 3 : 0,
        manualCommission: options.manual ? { type: options.fixed ? 'fixed_amount' : 'percentage', amount: options.amount ?? 5, currency: 'usd' } : undefined
    }))
    if (!assignment) throw new Error('hosted_commission_assignment_missing')
    s.fixture.ids.assignmentId = assignment.id
    recordLiveFixture(s.fixture.ids)
    await s.status('pending'); await s.status('completed')
    await s.step('server commission reconciliation', () => commissions.reconcileSalesOrderCommission(liveWorkspaceId, s.order!.id))
    return { partner, agentId: partner.agentFacetId, assignment, plan }
}
export async function commissionCheckout(s: HostedScenario) {
    await capability(s)
    const f = requireFixture(s.family.id)
    const input = s.input({ paid: true }); input.commissionEnabled = true; input.salesAccountAgentId = String(f.agentId)
    await s.create(input, 'quick', 'completed')
    await s.step('Quick sales-account attribution and commission', async () => undefined, { unchanged: true, check: graph => {
        expect(graph.tables.orders[0].sales_account_agent_id).toBe(f.agentId)
        expect(active(graph.tables.assignments).some(row => row.agent_id === f.agentId && row.assignment_source === 'sales_account')).toBe(true)
    } })
}
export async function commissionSources(s: HostedScenario) {
    const i = index(s)
    if (i === 1) {
        await s.complete()
        await s.step('no commission without attribution', async () => undefined, { unchanged: true, check: graph => { expect(graph.tables.assignments).toHaveLength(0); expect(graph.tables.commissions).toHaveLength(0); expect(graph.tables.productCommissions).toHaveLength(0) } }); return
    }
    if (i === 9 || i === 10) {
        const f = requireFixture(s.family.id)
        if (i === 10) return commissionCheckout(s)
        const agent = requireLiveData<Row>(await s.observer.schema('crm').from('agents').select('*').eq('workspace_id', liveWorkspaceId).eq('id', String(f.agentId)).single(), 'creator-linked test agent')
        expect(agent.linked_user_id).toBe((await liveSupabase.auth.getUser()).data.user?.id)
        await s.create({ ...s.input({ paid: true }), commissionEnabled: true }, 'quick', 'completed')
        await s.step('creator linked product-only beneficiary', async () => undefined, { unchanged: true, check: graph => expect(graph.tables.assignments.some(row => row.assignment_source === 'order_creator_product' && row.agent_id === agent.id)).toBe(true) }); return
    }
    if (i === 13 || i === 14) requireFixture(s.family.id)
    const setup = await commissionSetup(s, { fixed: [3, 4, 6].includes(i) || s.variant?.commissionType === 'fixed_amount', amount: s.variant?.amount ?? (i === 3 ? 0 : i === 5 || i === 15 ? 5 : 10), product: [8, 11, 12].includes(i), manual: i === 5 || i === 15, tax: i === 4, delivery: i === 4 })
    const commissions = await import('@/local-db/agentCommissions')
    if (i === 6) {
        await s.step('fixed plan per-order override', () => commissions.assignSalesOrderAgent(liveWorkspaceId, { orderId: s.order!.id, agentId: setup.agentId!, manualCommission: { type: 'fixed_amount', amount: 7, currency: 'usd' } }))
        await s.step('override reconciliation', () => commissions.reconcileSalesOrderCommission(liveWorkspaceId, s.order!.id))
    }
    if (i === 7) {
        const partners = await import('@/local-db/businessPartners')
        const other = await partners.createBusinessPartner(liveWorkspaceId, { partnerName: `${s.fixture.tag} second agent`, phone: '', defaultCurrency: 'usd', creditLimit: 0, role: 'agent', agent: { agentType: 'field_agent', status: 'active', zone: 'DEV TEST' } }, { allowAgentRole: true })
        await s.step('second beneficiary', () => commissions.assignSalesOrderAgent(liveWorkspaceId, { orderId: s.order!.id, agentId: other.agentFacetId!, manualCommission: { type: 'fixed_amount', amount: 5, currency: 'usd' } }))
        await s.step('multiple beneficiary reconciliation', () => commissions.reconcileSalesOrderCommission(liveWorkspaceId, s.order!.id))
    }
    if (i === 12 && setup.plan) {
        const before = await readGraph(s.observer, s.scope)
        await commissions.updateAgentCommissionPlan(setup.plan.id, { ratePercent: 20, effectiveFrom: new Date().toISOString() })
        await s.step('historical commission terms survive plan revision', () => commissions.reconcileSalesOrderCommission(liveWorkspaceId, s.order!.id), { check: graph => {
            const oldEarned = before.tables.commissions.filter(row => row.kind === 'accrual')
            for (const row of oldEarned) expect(graph.tables.commissions.find(current => current.id === row.id)).toEqual(row)
        } })
    }
    if (i === 14) await s.step('captured commission mode is immutable', () => s.rawOrder(liveSupabase, { commission_mode: 'tracked' }), denied)
    await s.step('commission provenance and independent amount', async () => undefined, { unchanged: true, check: graph => {
        expect(active(graph.tables.assignments).length).toBeGreaterThan(0)
        if (![6, 7, 12, 13, 14].includes(i)) {
            const manual = i === 5 || i === 15
            const expected = i === 3 ? s.variant?.amount ?? 0 : i === 4 ? 10 : manual ? s.variant?.commissionType === 'fixed_amount' ? s.variant.amount : 10 : 12
            const rows = active(graph.tables.commissions).filter(row => row.assignment_id === setup.assignment.id && row.kind === 'accrual')
            if (expected > 0) expect(rows.length).toBeGreaterThan(0)
            expect(sum(rows, 'amount')).toBeCloseTo(expected, 6)
            for (const row of rows) {
                expect(row).toMatchObject({ order_id: s.order!.id, agent_id: setup.agentId, currency: 'usd', commission_mode: 'payable' })
                expect(Number(row.revenue_amount)).toBeCloseTo(i === 4 ? 210 : 200, 6)
                expect(row.calculation_basis).toBe(manual ? 'net_revenue' : 'net_profit')
                expect(Number(row.cost_amount)).toBeCloseTo(manual ? 0 : i === 4 ? 83 : 80, 6)
                expect(Number(row.basis_amount)).toBeCloseTo(manual ? 200 : i === 4 ? 127 : 120, 6)
            }
        }
        if (i === 8 || i === 11) expect(sum(active(graph.tables.productCommissions).filter(row => row.kind === 'accrual'), 'amount')).toBeCloseTo(10, 6)
    } })
}
export async function commissionSettlements(s: HostedScenario) {
    const i = index(s)
    if (i === 2 || i === 3 || i === 5 || i === 11) {
        const fixture = requireFixture(s.family.id)
        if (i === 2 || i === 3) {
            const { existingFixture } = await import('./security'); await existingFixture(s, fixture)
            const graph = await readGraph(s.observer, s.scope)
            expect(graph.tables.orders[0].commission_mode).toBe('tracked')
            expect(graph.tables.trackedCommissions.length + graph.tables.trackedProductCommissions.length).toBeGreaterThan(0)
            if (i === 3) await s.step('tracked payout rejected', () => s.rpc(liveSupabase, 'record_sales_agent_commission_payout', { p_order_id: s.order!.id, p_assignment_id: String(fixture.assignmentId), p_amount: 1, p_payment_method: 'cash', p_paid_at: new Date().toISOString(), p_note: 'DEV TEST', p_account_id: null, p_account_name_snapshot: null }), denied)
            return
        }
    }
    const setup = await commissionSetup(s)
    const commissions = await import('@/local-db/agentCommissions')
    const payoutInput = { orderId: s.order!.id, assignmentId: setup.assignment.id, agentId: setup.agentId!, amount: 6, currency: 'usd' as const, paymentMethod: 'cash' as const, paidAt: new Date().toISOString() }
    if (i === 1) return
    if (i === 7) {
        await s.step('wrong assignment settlement rejected', () => commissions.recordAgentCommissionPayout(liveWorkspaceId, { ...payoutInput, assignmentId: crypto.randomUUID() }), denied); return
    }
    if (i === 8) { await s.returned(1); await s.step('commission reverses exact returned share', () => commissions.reconcileSalesOrderCommission(liveWorkspaceId, s.order!.id), { check: graph => expect(sum(active(graph.tables.commissions).filter(row => row.kind === 'reversal'), 'amount')).toBeCloseTo(-6, 6) }); return }
    if (i === 12) {
        const before = await readGraph(s.observer, s.scope)
        await s.step('reconcile commission exact replay', () => commissions.reconcileSalesOrderCommission(liveWorkspaceId, s.order!.id), { check: graph => expect(canonical(graph.tables.commissions)).toBe(canonical(before.tables.commissions)) }); return
    }
    if (i === 13) {
        await s.step('competing commission payout requests', async () => {
            const outcomes = await Promise.allSettled([commissions.recordAgentCommissionPayout(liveWorkspaceId, { ...payoutInput, amount: 12 }), commissions.recordAgentCommissionPayout(liveWorkspaceId, { ...payoutInput, amount: 12 })])
            expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
        }, { check: graph => expect(sum(active(graph.tables.commissions).filter(row => row.kind === 'payout'), 'amount')).toBeCloseTo(-12, 6) }); return
    }
    if (i === 14) s.fault = { path: '/rpc/record_sales_agent_commission_payout', occurrence: 1, seen: 0, mode: 'after' }
    await s.step('partial commission payout posts outgoing payment', () => commissions.recordAgentCommissionPayout(liveWorkspaceId, payoutInput), i === 14 ? { denied: true } : { check: graph => {
        expect(sum(active(graph.tables.commissions).filter(row => row.kind === 'payout'), 'amount')).toBeCloseTo(-6, 6)
        expect(graph.tables.payments.some(row => row.direction === 'outgoing' && Number(row.amount) === 6)).toBe(true)
    } })
    s.fault = null
    if (i === 6) await s.step('final commission payout', () => commissions.recordAgentCommissionPayout(liveWorkspaceId, payoutInput))
    if (i === 9 || i === 10) {
        await s.returned(2)
        if (i === 10) await s.step('collect commission recovery', () => commissions.recordAgentCommissionRecovery(liveWorkspaceId, { ...payoutInput, amount: 6 }), { check: graph => expect(graph.tables.commissions.some(row => row.kind === 'recovery' && Number(row.amount) === 6)).toBe(true) })
    }
}
