import type { PartnerAccountStatementClosingBalance } from '@/lib/partnerAccountStatement'
import type { OrderPartnerBalanceAtPosting } from '@/lib/orderPartnerBalance'
import type { IQDDisplayPreference } from '@/local-db'
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

/** Formats one reconstructed pre/post order balance without mixing currencies. */
export function formatAtlasStandardPartnerBalanceAtPosting(
    balanceAtPosting: OrderPartnerBalanceAtPosting | null | undefined,
    position: 'before' | 'after',
    iqdPreference: IQDDisplayPreference | undefined
) {
    if (!balanceAtPosting?.balances.length) return '-'

    return balanceAtPosting.balances
        .flatMap(({ currency, [position]: balance }) => (
            typeof balance === 'number'
                ? [formatCurrency(balance, currency, iqdPreference)]
                : []
        ))
        .join(' • ')
        || '-'
}
