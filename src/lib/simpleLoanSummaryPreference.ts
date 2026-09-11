import type { SimpleLoanSummaryMode } from './loanListMetrics'

export const DEFAULT_SIMPLE_LOAN_SUMMARY_MODE: SimpleLoanSummaryMode = 'principal_paid'

const SIMPLE_LOAN_SUMMARY_MODE_STORAGE_PREFIX = 'simple_loans_summary_mode_v1'

type SummaryModeStorage = Pick<Storage, 'getItem' | 'setItem'>

function getBrowserStorage(): SummaryModeStorage | undefined {
    return typeof localStorage === 'undefined' ? undefined : localStorage
}

function getStorageKey(workspaceId: string) {
    return `${SIMPLE_LOAN_SUMMARY_MODE_STORAGE_PREFIX}:${workspaceId}`
}

export function getSimpleLoanSummaryMode(
    workspaceId: string,
    storage: SummaryModeStorage | undefined = getBrowserStorage()
): SimpleLoanSummaryMode {
    const savedMode = storage?.getItem(getStorageKey(workspaceId))
    return savedMode === 'lent_borrowed' || savedMode === 'principal_paid'
        ? savedMode
        : DEFAULT_SIMPLE_LOAN_SUMMARY_MODE
}

export function saveSimpleLoanSummaryMode(
    workspaceId: string,
    mode: SimpleLoanSummaryMode,
    storage: SummaryModeStorage | undefined = getBrowserStorage()
) {
    storage?.setItem(getStorageKey(workspaceId), mode)
}
