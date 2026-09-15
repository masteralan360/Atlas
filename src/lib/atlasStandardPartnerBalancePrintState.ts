import type { PartnerAccountStatementClosingBalance } from '@/lib/partnerAccountStatement'
import type { OrderPartnerBalanceAtPosting } from '@/lib/orderPartnerBalance'

export type AtlasStandardPartnerBalancePrintState = {
    status: 'loading' | 'ready' | 'error'
    balances?: PartnerAccountStatementClosingBalance[]
    orderBalanceAtPosting?: OrderPartnerBalanceAtPosting | null
}

export function createAtlasStandardPartnerBalancePrintState(
    requiresFreshBalance: boolean
): AtlasStandardPartnerBalancePrintState {
    return { status: requiresFreshBalance ? 'loading' : 'ready' }
}

export function resetAtlasStandardPartnerBalancePrintState(
    state: AtlasStandardPartnerBalancePrintState,
    requiresFreshBalance: boolean
) {
    state.status = requiresFreshBalance ? 'loading' : 'ready'
    state.balances = undefined
    state.orderBalanceAtPosting = undefined
}
