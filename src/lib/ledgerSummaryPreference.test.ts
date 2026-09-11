import { describe, expect, it } from 'vitest'

import {
    DEFAULT_LEDGER_SUMMARY_MODE,
    getLedgerSummaryMode,
    saveLedgerSummaryMode,
} from './ledgerSummaryPreference'

function createStorage() {
    const values = new Map<string, string>()
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    }
}

describe('ledger summary preference', () => {
    it('defaults missing and invalid preferences to the newer cash-activity mode', () => {
        const storage = createStorage()

        expect(getLedgerSummaryMode('workspace-a', storage)).toBe(DEFAULT_LEDGER_SUMMARY_MODE)
        storage.setItem('ledger_summary_mode_v1:workspace-a', 'unsupported')
        expect(getLedgerSummaryMode('workspace-a', storage)).toBe('cash_activity')
        expect(getLedgerSummaryMode(undefined, storage)).toBe('cash_activity')
    })

    it('restores the selected mode independently for each workspace', () => {
        const storage = createStorage()

        saveLedgerSummaryMode('workspace-a', 'legacy_flow', storage)
        saveLedgerSummaryMode('workspace-b', 'cash_activity', storage)

        expect(getLedgerSummaryMode('workspace-a', storage)).toBe('legacy_flow')
        expect(getLedgerSummaryMode('workspace-b', storage)).toBe('cash_activity')
    })

    it('does not persist a preference without a workspace', () => {
        const storage = createStorage()

        saveLedgerSummaryMode(undefined, 'legacy_flow', storage)

        expect(getLedgerSummaryMode(undefined, storage)).toBe('cash_activity')
    })
})
