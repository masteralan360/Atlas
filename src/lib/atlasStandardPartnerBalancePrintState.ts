import type { PartnerAccountStatementClosingBalance } from '@/lib/partnerAccountStatement'
import type { PartnerAccountStatementLiveDataProgress } from '@/lib/partnerAccountStatementLiveData'
import type { OrderPartnerBalanceAtPosting } from '@/lib/orderPartnerBalance'

export type AtlasStandardPartnerBalancePrintState = {
    status: 'loading' | 'ready' | 'error'
    balances?: PartnerAccountStatementClosingBalance[]
    orderBalanceAtPosting?: OrderPartnerBalanceAtPosting | null
    progress?: PartnerAccountStatementLiveDataProgress | null
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
    state.progress = undefined
}

export function getAtlasStandardPartnerBalanceLoadingPercentage(
    progress?: PartnerAccountStatementLiveDataProgress | null
) {
    if (!progress || progress.totalSources <= 0) return 0

    return Math.min(
        100,
        Math.max(0, Math.round((progress.completedSources / progress.totalSources) * 100))
    )
}
