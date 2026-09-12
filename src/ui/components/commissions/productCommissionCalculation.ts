import {
    activeProductCommissionRule,
    type CurrencyCode,
    type ExchangeRateSnapshot,
    type ProductCommissionRule,
    type ProductCommissionRuleAgent
} from '@/local-db'
import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'

export type ProductCommissionPreviewItem = {
    id?: string
    productId: string
    productName: string
    quantity: number
    convertedUnitPrice?: number
    lineTotal?: number
}

export type ProductCommissionPreviewRow = {
    item: ProductCommissionPreviewItem
    agentId: string
    perUnit: number
    total: number
    rule: ProductCommissionRule
    unavailableConversion: boolean
}

/** The one calculation path used by order details and order-list summaries. */
export function buildProductCommissionPreviewRows({
    items,
    agentIds,
    rules,
    recipients,
    currency,
    exchangeRates,
    at
}: {
    items: readonly ProductCommissionPreviewItem[]
    agentIds: readonly string[]
    rules: readonly ProductCommissionRule[]
    recipients: readonly ProductCommissionRuleAgent[]
    currency: CurrencyCode
    exchangeRates: readonly ExchangeRateSnapshot[]
    at: string
}): ProductCommissionPreviewRow[] {
    return items.flatMap((item) => {
        const rule = activeProductCommissionRule(rules, item.productId, at)
        if (!rule || Number(item.quantity || 0) <= 0) return []
        const allowed = rule.recipientScope === 'all_assigned'
            ? agentIds
            : agentIds.filter((agentId) => recipients.some((recipient) => recipient.ruleId === rule.id && recipient.agentId === agentId))
        if (allowed.length === 0) return []
        const basePerUnit = Math.max(0, Number(item.convertedUnitPrice || 0))
        const fixedConversion = rule.commissionType === 'fixed_amount' && rule.fixedCurrency
            ? getAppliedCurrencyConversion(Number(rule.fixedAmount || 0), rule.fixedCurrency, currency, exchangeRates)
            : null
        const unavailableConversion = rule.commissionType === 'fixed_amount' && !fixedConversion
        const perUnit = rule.commissionType === 'fixed_amount'
            ? Number(fixedConversion?.convertedAmount || 0)
            : basePerUnit * Number(rule.ratePercent || 0) / 100
        return allowed.map((agentId) => ({
            item,
            agentId,
            perUnit,
            total: perUnit * Number(item.quantity || 0),
            rule,
            unavailableConversion
        }))
    })
}
