export type LedgerSummaryMode = 'cash_activity' | 'legacy_flow'

export const DEFAULT_LEDGER_SUMMARY_MODE: LedgerSummaryMode = 'cash_activity'

const LEDGER_SUMMARY_MODE_STORAGE_PREFIX = 'ledger_summary_mode_v1'

type SummaryModeStorage = Pick<Storage, 'getItem' | 'setItem'>

function getBrowserStorage(): SummaryModeStorage | undefined {
    return typeof localStorage === 'undefined' ? undefined : localStorage
}

function getStorageKey(workspaceId: string) {
    return `${LEDGER_SUMMARY_MODE_STORAGE_PREFIX}:${workspaceId}`
}

export function getLedgerSummaryMode(
    workspaceId: string | null | undefined,
    storage: SummaryModeStorage | undefined = getBrowserStorage(),
): LedgerSummaryMode {
    if (!workspaceId) return DEFAULT_LEDGER_SUMMARY_MODE

    const savedMode = storage?.getItem(getStorageKey(workspaceId))
    return savedMode === 'cash_activity' || savedMode === 'legacy_flow'
        ? savedMode
        : DEFAULT_LEDGER_SUMMARY_MODE
}

export function saveLedgerSummaryMode(
    workspaceId: string | null | undefined,
    mode: LedgerSummaryMode,
    storage: SummaryModeStorage | undefined = getBrowserStorage(),
) {
    if (!workspaceId) return
    storage?.setItem(getStorageKey(workspaceId), mode)
}
