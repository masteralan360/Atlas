/** The three independently optional partner-balance values on an order print. */
export type OrderPartnerBalancePrintDemand = {
    before: boolean
    after: boolean
    current: boolean
}

export type OrderPartnerBalancePrintFieldKeys = {
    before: string
    after: string
    current: string
}

export type OrderPartnerBalanceAtPostingDemand = Pick<
    OrderPartnerBalancePrintDemand,
    'before' | 'after'
>

export const ALL_ORDER_PARTNER_BALANCE_PRINT_DEMAND: OrderPartnerBalancePrintDemand = {
    before: true,
    after: true,
    current: true
}

/**
 * Resolves exactly which account-statement values an editable print currently
 * exposes. A preview without these field keys keeps the legacy all-values
 * behavior so unrelated templates remain unchanged.
 */
export function resolveOrderPartnerBalancePrintDemand(
    fieldKeys: OrderPartnerBalancePrintFieldKeys | undefined,
    hiddenFields: Record<string, boolean> | undefined
): OrderPartnerBalancePrintDemand {
    if (!fieldKeys) return ALL_ORDER_PARTNER_BALANCE_PRINT_DEMAND

    return {
        before: !hiddenFields?.[fieldKeys.before],
        after: !hiddenFields?.[fieldKeys.after],
        current: !hiddenFields?.[fieldKeys.current]
    }
}

export function hasOrderPartnerBalancePrintDemand(
    demand: OrderPartnerBalancePrintDemand
) {
    return demand.before || demand.after || demand.current
}
