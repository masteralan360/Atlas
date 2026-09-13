import type { PartnerAccountStatementClosingBalance } from '@/lib/partnerAccountStatement'

export type AtlasStandardPartnerBalancePrintState = {
    status: 'loading' | 'ready' | 'error'
    balances?: PartnerAccountStatementClosingBalance[]
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
}
