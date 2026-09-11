import type { PartnerAccountStatementClosingBalance } from '@/lib/partnerAccountStatement'
import type { IQDDisplayPreference, OrderPartnerBalanceSnapshot } from '@/local-db'
import { formatCurrency } from '@/lib/utils'

/** Formats the Partner Account Statement's per-currency balances for Atlas Standard invoices. */
export function formatAtlasStandardPartnerCurrentBalance(
    balances: PartnerAccountStatementClosingBalance[] | undefined,
    iqdPreference: IQDDisplayPreference | undefined
) {
    if (!balances || balances.length === 0) return '-'

    return balances
        .map(({ currency, closingBalance }) => formatCurrency(closingBalance, currency, iqdPreference))
        .join(' • ')
}

/** Formats one immutable pre/post order-balance snapshot without mixing currencies. */
export function formatAtlasStandardPartnerBalanceSnapshot(
    snapshot: OrderPartnerBalanceSnapshot | null | undefined,
    position: 'before' | 'after',
    iqdPreference: IQDDisplayPreference | undefined
) {
    if (!snapshot?.balances.length) return '-'

    return snapshot.balances
        .map(({ currency, [position]: balance }) => formatCurrency(balance, currency, iqdPreference))
        .join(' • ')
}
