import type { AgentCommissionPlan, CurrencyCode, ExchangeRateSnapshot, ManualSalesAgentCommissionType } from '@/local-db'
import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'

export type SalesOrderCommissionAssignmentSummaryStatus =
    | 'ready'
    | 'calculated_on_completion'
    | 'needs_amount'
    | 'exchange_rate_unavailable'
    | 'not_configured'

export interface SalesOrderCommissionAssignmentSummary {
    agentId: string
    agentName: string
    planName: string | null
    /** Known pre-completion amount, expressed in the order currency. */
    amount: number | null
    ratePercent: number | null
    status: SalesOrderCommissionAssignmentSummaryStatus
}

/**
 * Returns whether the current beneficiary drafts would actually create a
 * manual or plan-based commission. Empty, incomplete, and unconfigured
 * beneficiaries must not put an order into a commission mode.
 */
export function hasConfiguredSalesOrderCommission(
    summaries: readonly SalesOrderCommissionAssignmentSummary[]
) {
    return summaries.some((summary) => (
        summary.status === 'ready' || summary.status === 'calculated_on_completion'
    ))
}

export type CommissionSummaryAgent = {
    id: string
    name: string
    plan: Pick<AgentCommissionPlan, 'name' | 'commissionType' | 'ratePercent' | 'fixedCurrency'> | null
}

export type CommissionSummaryDraft = {
    agentId: string
    manualCommissionAmount: string
    manualCommissionCurrency: CurrencyCode
    manualCommissionType: ManualSalesAgentCommissionType
}

export function summarizeSalesOrderAgentCommissions({
    drafts,
    resolveAgent,
    orderCurrency,
    orderTotal,
    exchangeRates
}: {
    drafts: readonly CommissionSummaryDraft[]
    resolveAgent: (agentId: string) => CommissionSummaryAgent | undefined
    orderCurrency: CurrencyCode
    orderTotal: number
    exchangeRates: ExchangeRateSnapshot[]
}): SalesOrderCommissionAssignmentSummary[] {
    return drafts.flatMap<SalesOrderCommissionAssignmentSummary>((draft) => {
        const selectedAgent = draft.agentId ? resolveAgent(draft.agentId) : undefined
        if (!selectedAgent) return []

        const plan = selectedAgent.plan
        const rawAmount = Number(draft.manualCommissionAmount)
        const hasAmount = draft.manualCommissionAmount.trim().length > 0 && Number.isFinite(rawAmount)
        const convertFixedAmount = (amount: number, currency: CurrencyCode) => (
            getAppliedCurrencyConversion(amount, currency, orderCurrency, exchangeRates)?.convertedAmount ?? null
        )

        if (plan?.commissionType === 'fixed_amount') {
            if (!hasAmount || rawAmount < 0) {
                return [{
                    agentId: selectedAgent.id,
                    agentName: selectedAgent.name,
                    planName: plan.name,
                    amount: null,
                    ratePercent: null,
                    status: 'needs_amount'
                }]
            }
            const amount = convertFixedAmount(rawAmount, plan.fixedCurrency || orderCurrency)
            return [{
                agentId: selectedAgent.id,
                agentName: selectedAgent.name,
                planName: plan.name,
                amount,
                ratePercent: null,
                status: amount === null ? 'exchange_rate_unavailable' : 'ready'
            }]
        }

        if (plan) {
            return [{
                agentId: selectedAgent.id,
                agentName: selectedAgent.name,
                planName: plan.name,
                amount: null,
                ratePercent: Number(plan.ratePercent || 0),
                status: 'calculated_on_completion'
            }]
        }

        if (!hasAmount || rawAmount <= 0) {
            return [{
                agentId: selectedAgent.id,
                agentName: selectedAgent.name,
                planName: null,
                amount: null,
                ratePercent: null,
                status: 'not_configured'
            }]
        }

        if (draft.manualCommissionType === 'percentage') {
            const amount = rawAmount <= 100 ? Math.max(0, orderTotal) * rawAmount / 100 : null
            return [{
                agentId: selectedAgent.id,
                agentName: selectedAgent.name,
                planName: null,
                amount,
                ratePercent: rawAmount,
                status: amount === null ? 'needs_amount' : 'ready'
            }]
        }

        const amount = convertFixedAmount(rawAmount, draft.manualCommissionCurrency)
        return [{
            agentId: selectedAgent.id,
            agentName: selectedAgent.name,
            planName: null,
            amount,
            ratePercent: null,
            status: amount === null ? 'exchange_rate_unavailable' : 'ready'
        }]
    })
}
