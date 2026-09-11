import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentCommissionEntry, ProductCommissionRule, ProductCommissionRuleAgent } from '@/local-db'

import type { ProductCommissionPreviewItem } from './ProductCommissionPreview'
import {
    findLinkedProductCommissionAgent,
    findOwnedOrderCreatorProductCommissionAgent
} from './productCommissionAgent'

vi.mock('@/local-db', () => ({
    activeProductCommissionRule: (rules: ProductCommissionRule[], productId: string, at: string) => rules.find((candidate) => (
        candidate.productId === productId
        && candidate.isActive
        && !candidate.isDeleted
        && candidate.effectiveFrom <= at
        && (!candidate.effectiveTo || candidate.effectiveTo > at)
    )) || null,
    useProductCommissionRuleAgents: () => [],
    useProductCommissionRules: () => [],
    useAgentCommissionEntries: () => []
}))

vi.mock('./useCommissionAgentDirectory', () => ({
    useCommissionAgentDirectory: () => ({ agentById: new Map() })
}))

vi.mock('@/ui/components/button', () => ({
    Button: () => null
}))

vi.mock('@/lib/orderCurrency', () => ({
    getAppliedCurrencyConversion: () => null
}))

vi.mock('@/lib/utils', () => ({
    formatCurrency: () => ''
}))

const AT = '2026-08-29T12:00:00.000Z'
let hasEligibleProductCommission: typeof import('./ProductCommissionPreview').hasEligibleProductCommission
let getProductCommissionPreviewTotal: typeof import('./ProductCommissionPreview').getProductCommissionPreviewTotal
let buildProductCommissionPaymentSummaries: typeof import('./ProductCommissionPreview').buildProductCommissionPaymentSummaries
let buildProductCommissionSettlementActions: typeof import('./ProductCommissionPreview').buildProductCommissionSettlementActions

beforeAll(async () => {
    const values = new Map<string, string>()
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear()
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            visibilityState: 'visible',
            documentElement: { lang: 'en', dir: 'ltr' },
            head: { appendChild: () => undefined },
            getElementsByTagName: () => [{ appendChild: () => undefined }],
            createElement: () => ({
                setAttribute: () => undefined,
                appendChild: () => undefined
            }),
            createTextNode: () => ({}),
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: false }
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
        value: () => 'blob:vitest'
    })
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            localStorage: storage,
            sessionStorage: storage,
            URL: globalThis.URL,
            location: { hash: '', origin: 'http://localhost', pathname: '/' },
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        }
    })
    ;({
        hasEligibleProductCommission,
        getProductCommissionPreviewTotal,
        buildProductCommissionPaymentSummaries,
        buildProductCommissionSettlementActions
    } = await import('./ProductCommissionPreview'))
})

function rule(scope: ProductCommissionRule['recipientScope']): ProductCommissionRule {
    return {
        id: 'rule-1',
        workspaceId: 'workspace-1',
        productId: 'product-1',
        commissionType: 'fixed_amount',
        ratePercent: 0,
        fixedAmount: 5000,
        fixedCurrency: 'iqd',
        recipientScope: scope,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        effectiveTo: null,
        isActive: true,
        notes: null,
        createdBy: null,
        createdAt: AT,
        updatedAt: AT,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: AT
    }
}

const items: ProductCommissionPreviewItem[] = [{
    id: 'line-1', productId: 'product-1', productName: 'Commissioned product', quantity: 2, convertedUnitPrice: 15000
}]

describe('hasEligibleProductCommission', () => {
    it('resolves only the active field agent linked to the order creator', () => {
        const eligible = {
            id: 'agent-eligible', linkedUserId: 'user-1', agentType: 'field_agent', status: 'active', isDeleted: false
        }
        const agents = [
            { id: 'agent-driver', linkedUserId: 'user-1', agentType: 'driver', status: 'active', isDeleted: false },
            { id: 'agent-inactive', linkedUserId: 'user-1', agentType: 'field_agent', status: 'inactive', isDeleted: false },
            eligible
        ]

        expect(findLinkedProductCommissionAgent(agents, 'user-1')).toBe(eligible)
        expect(findLinkedProductCommissionAgent(agents, 'missing-user')).toBeNull()
        expect(findLinkedProductCommissionAgent(agents, null)).toBeNull()
    })

    it('allows a linked agent to preview only an order they created', () => {
        const agent = {
            id: 'agent-1',
            linkedUserId: 'user-1',
            agentType: 'field_agent',
            status: 'active',
            isDeleted: false
        }

        expect(findOwnedOrderCreatorProductCommissionAgent([agent], 'user-1', 'user-1')).toBe(agent)
        expect(findOwnedOrderCreatorProductCommissionAgent([agent], 'user-1', 'user-2')).toBeNull()
        expect(findOwnedOrderCreatorProductCommissionAgent([agent], null, 'user-1')).toBeNull()
    })

    it('automatically qualifies an assigned agent for all-assigned product rules', () => {
        expect(hasEligibleProductCommission({
            items,
            agentIds: ['agent-1'],
            rules: [rule('all_assigned')],
            recipients: [],
            at: AT
        })).toBe(true)
    })

    it('only qualifies an explicitly selected recipient for selected-agent rules', () => {
        const recipients: ProductCommissionRuleAgent[] = [{
            id: 'recipient-1',
            workspaceId: 'workspace-1',
            ruleId: 'rule-1',
            agentId: 'agent-allowed',
            createdAt: AT,
            updatedAt: AT,
            version: 1,
            isDeleted: false,
            syncStatus: 'synced',
            lastSyncedAt: AT
        }]
        expect(hasEligibleProductCommission({
            items,
            agentIds: ['agent-other'],
            rules: [rule('selected_assigned')],
            recipients,
            at: AT
        })).toBe(false)
        expect(hasEligibleProductCommission({
            items,
            agentIds: ['agent-allowed'],
            rules: [rule('selected_assigned')],
            recipients,
            at: AT
        })).toBe(true)
    })
})

describe('getProductCommissionPreviewTotal', () => {
    it('adds every eligible recipient and line amount without rounding early', () => {
        expect(getProductCommissionPreviewTotal([
            { total: 12.345, unavailableConversion: false },
            { total: 7.655, unavailableConversion: false },
            { total: 4, unavailableConversion: false }
        ])).toBe(24)
    })

    it('does not show a partial total when a fixed commission cannot be converted', () => {
        expect(getProductCommissionPreviewTotal([
            { total: 12, unavailableConversion: false },
            { total: 0, unavailableConversion: true }
        ])).toBeNull()
    })
})

describe('buildProductCommissionSettlementActions', () => {
    const agent = {
        id: 'agent-1',
        name: 'Ava Agent',
        businessPartnerId: 'partner-1',
        businessPartnerName: 'Ava Partner'
    }
    const commissionEntry = (overrides: Partial<AgentCommissionEntry> = {}): AgentCommissionEntry => ({
        id: 'entry-1',
        workspaceId: 'workspace-1',
        orderId: 'order-1',
        assignmentId: 'assignment-1',
        agentId: agent.id,
        membershipId: null,
        planId: null,
        orderReturnId: null,
        relatedEntryId: null,
        kind: 'accrual',
        status: 'earned',
        currency: 'usd',
        calculationBasis: 'net_revenue',
        includeTax: false,
        includeDeliveryCharge: false,
        basisAmount: 0,
        revenueAmount: 0,
        costAmount: 0,
        taxAmount: 0,
        deliveryChargeAmount: 0,
        ratePercent: 0,
        amount: 50,
        occurredAt: AT,
        payoutReference: null,
        settlementSource: 'manual',
        notes: null,
        createdBy: null,
        createdAt: AT,
        updatedAt: AT,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: AT,
        ...overrides
    })

    it('creates one payment action for an outstanding product-commission recipient', () => {
        const actions = buildProductCommissionSettlementActions({
            workspaceId: 'workspace-1',
            orderId: 'order-1',
            orderReference: 'SO-1001',
            agentIds: [agent.id],
            agents: [agent],
            entries: [commissionEntry(), commissionEntry({ id: 'payout-1', kind: 'payout', amount: -20 })]
        })

        expect(actions).toHaveLength(1)
        expect(actions[0]).toMatchObject({
            agentId: agent.id,
            obligation: expect.objectContaining({
                sourceType: 'agent_commission_payout',
                direction: 'outgoing',
                amount: 30,
                referenceLabel: 'SO-1001',
                metadata: expect.objectContaining({
                    businessPartnerId: agent.businessPartnerId,
                    commissionAssignmentId: 'assignment-1'
                })
            })
        })
    })

    it('reports the final commission amount and partial payment state without exposing ledger events', () => {
        const summaries = buildProductCommissionPaymentSummaries({
            orderId: 'order-1',
            agentIds: [agent.id],
            agents: [agent],
            entries: [
                commissionEntry({ amount: 50 }),
                commissionEntry({ id: 'payout-1', kind: 'payout', amount: -20 })
            ]
        })

        expect(summaries).toEqual([expect.objectContaining({
            agentId: agent.id,
            commissionAmount: 50,
            paidAmount: 20,
            outstandingAmount: 30,
            status: 'partial'
        })])
    })

    it('reports a fully paid commission once payouts clear its balance', () => {
        const summaries = buildProductCommissionPaymentSummaries({
            orderId: 'order-1',
            agentIds: [agent.id],
            agents: [agent],
            entries: [
                commissionEntry({ amount: 50 }),
                commissionEntry({ id: 'payout-1', kind: 'payout', amount: -50 })
            ]
        })

        expect(summaries[0]).toMatchObject({
            commissionAmount: 50,
            paidAmount: 50,
            outstandingAmount: 0,
            status: 'paid'
        })
    })

    it('makes only the actual payout recoverable after a full commission reversal', () => {
        const entries = [
            commissionEntry({ amount: 50_000 }),
            commissionEntry({ id: 'return-reversal', kind: 'reversal', status: 'reversed', amount: -50_000 }),
            commissionEntry({ id: 'payout-1', kind: 'payout', status: 'paid', amount: -25_000 })
        ]
        const summaries = buildProductCommissionPaymentSummaries({
            orderId: 'order-1',
            agentIds: [agent.id],
            agents: [agent],
            entries
        })

        expect(summaries).toEqual([expect.objectContaining({
            commissionAmount: 0,
            paidAmount: 25_000,
            outstandingAmount: -25_000,
            status: 'recovery_due'
        })])
        expect(buildProductCommissionSettlementActions({
            workspaceId: 'workspace-1',
            orderId: 'order-1',
            orderReference: 'SO-1001',
            agentIds: [agent.id],
            agents: [agent],
            entries
        })[0]).toMatchObject({
            obligation: expect.objectContaining({
                sourceType: 'agent_commission_recovery',
                direction: 'incoming',
                amount: 25_000
            })
        })
    })

    it('rounds a sub-cent outstanding balance away before assigning the payment status', () => {
        const summaries = buildProductCommissionPaymentSummaries({
            orderId: 'order-1',
            agentIds: [agent.id],
            agents: [agent],
            entries: [
                commissionEntry({ amount: 50 }),
                commissionEntry({ id: 'payout-1', kind: 'payout', amount: -49.9999996 })
            ]
        })

        expect(summaries[0]).toMatchObject({
            paidAmount: 50,
            outstandingAmount: 0,
            status: 'paid'
        })
    })

    it('does not offer a second payment after the commission balance is fully settled', () => {
        expect(buildProductCommissionSettlementActions({
            workspaceId: 'workspace-1',
            orderId: 'order-1',
            orderReference: 'SO-1001',
            agentIds: [agent.id],
            agents: [agent],
            entries: [commissionEntry(), commissionEntry({ id: 'payout-1', kind: 'payout', amount: -50 })]
        })).toEqual([])
    })
})
