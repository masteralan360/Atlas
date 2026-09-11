import { describe, expect, it } from 'vitest'

import {
    DEFAULT_SIMPLE_LOAN_SUMMARY_MODE,
    getSimpleLoanSummaryMode,
    saveSimpleLoanSummaryMode
} from './simpleLoanSummaryPreference'

function createStorage() {
    const values = new Map<string, string>()
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value)
    }
}

describe('simple loan summary preference', () => {
    it('defaults new and invalid preferences to the newer principal-and-paid mode', () => {
        const storage = createStorage()

        expect(getSimpleLoanSummaryMode('workspace-a', storage)).toBe(DEFAULT_SIMPLE_LOAN_SUMMARY_MODE)
        storage.setItem('simple_loans_summary_mode_v1:workspace-a', 'unsupported')
        expect(getSimpleLoanSummaryMode('workspace-a', storage)).toBe('principal_paid')
    })

    it('restores the selected mode independently for each workspace', () => {
        const storage = createStorage()

        saveSimpleLoanSummaryMode('workspace-a', 'lent_borrowed', storage)
        saveSimpleLoanSummaryMode('workspace-b', 'principal_paid', storage)

        expect(getSimpleLoanSummaryMode('workspace-a', storage)).toBe('lent_borrowed')
        expect(getSimpleLoanSummaryMode('workspace-b', storage)).toBe('principal_paid')
    })
})
