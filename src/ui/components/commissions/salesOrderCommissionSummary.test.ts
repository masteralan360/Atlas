import { describe, expect, it } from 'vitest'

import type { CommissionSummaryAgent } from './salesOrderCommissionSummary'
import {
    hasConfiguredSalesOrderCommission,
    summarizeSalesOrderAgentCommissions
} from './salesOrderCommissionSummary'

const fixedPlanAgent: CommissionSummaryAgent = {
    id: 'agent-fixed',
    name: 'Fixed Agent',
    plan: {
        name: 'Level 2',
        commissionType: 'fixed_amount',
        ratePercent: 0,
        fixedCurrency: 'usd'
    }
}

const percentagePlanAgent: CommissionSummaryAgent = {
    id: 'agent-percentage-plan',
    name: 'Percentage Plan Agent',
    plan: {
        name: 'Level 1',
        commissionType: 'percentage',
        ratePercent: 5,
        fixedCurrency: null
    }
}

const manualAgent: CommissionSummaryAgent = {
    id: 'agent-manual',
    name: 'Manual Agent',
    plan: null
}

const agentById = new Map([
    [fixedPlanAgent.id, fixedPlanAgent],
    [percentagePlanAgent.id, percentagePlanAgent],
    [manualAgent.id, manualAgent]
])

function summarize(drafts: Parameters<typeof summarizeSalesOrderAgentCommissions>[0]['drafts']) {
    return summarizeSalesOrderAgentCommissions({
        drafts,
        resolveAgent: (agentId) => agentById.get(agentId),
        orderCurrency: 'usd',
        orderTotal: 1_250,
        exchangeRates: []
    })
}

describe('summarizeSalesOrderAgentCommissions', () => {
    it('lists fixed-plan and manual percentage beneficiaries in the order currency', () => {
        expect(summarize([
            {
                agentId: fixedPlanAgent.id,
                manualCommissionAmount: '75',
                manualCommissionCurrency: 'usd',
                manualCommissionType: 'fixed_amount'
            },
            {
                agentId: manualAgent.id,
                manualCommissionAmount: '2.5',
                manualCommissionCurrency: 'usd',
                manualCommissionType: 'percentage'
            }
        ])).toEqual([
            expect.objectContaining({ agentId: fixedPlanAgent.id, amount: 75, status: 'ready' }),
            expect.objectContaining({ agentId: manualAgent.id, amount: 31.25, ratePercent: 2.5, status: 'ready' })
        ])
    })

    it('keeps percentage-plan commissions out of the configured total until completion', () => {
        expect(summarize([{
            agentId: percentagePlanAgent.id,
            manualCommissionAmount: '',
            manualCommissionCurrency: 'usd',
            manualCommissionType: 'fixed_amount'
        }])).toEqual([
            expect.objectContaining({
                agentId: percentagePlanAgent.id,
                amount: null,
                ratePercent: 5,
                status: 'calculated_on_completion'
            })
        ])
    })

    it('flags incomplete fixed-plan and invalid percentage amounts instead of treating them as zero', () => {
        expect(summarize([
            {
                agentId: fixedPlanAgent.id,
                manualCommissionAmount: '',
                manualCommissionCurrency: 'usd',
                manualCommissionType: 'fixed_amount'
            },
            {
                agentId: manualAgent.id,
                manualCommissionAmount: '100.001',
                manualCommissionCurrency: 'usd',
                manualCommissionType: 'percentage'
            }
        ])).toEqual([
            expect.objectContaining({ agentId: fixedPlanAgent.id, amount: null, status: 'needs_amount' }),
            expect.objectContaining({ agentId: manualAgent.id, amount: null, status: 'needs_amount' })
        ])
    })

    it('marks only configured manual or plan commissions as commissionable', () => {
        expect(hasConfiguredSalesOrderCommission([
            { agentId: 'empty', agentName: 'Empty', planName: null, amount: null, ratePercent: null, status: 'not_configured' },
            { agentId: 'incomplete', agentName: 'Incomplete', planName: 'Fixed', amount: null, ratePercent: null, status: 'needs_amount' }
        ])).toBe(false)

        expect(hasConfiguredSalesOrderCommission([
            { agentId: 'plan', agentName: 'Plan', planName: 'Percentage', amount: null, ratePercent: 5, status: 'calculated_on_completion' },
            { agentId: 'manual', agentName: 'Manual', planName: null, amount: 20, ratePercent: null, status: 'ready' }
        ])).toBe(true)
    })
})
