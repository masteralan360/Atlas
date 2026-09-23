import { describe, expect, it } from 'vitest'
import { serializePartnerSummaryRefresh } from './partnerSummaryRefresh'

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
}

describe('partner summary refresh ordering', () => {
    it('reads newer totals after an older remote summary write finishes', async () => {
        const gate = deferred()
        let orderCount = 1
        let storedTotal = 0
        const first = serializePartnerSummaryRefresh('customers', 'workspace', 'customer', async () => {
            const snapshot = orderCount
            await gate.promise
            storedTotal = snapshot
        })
        await Promise.resolve()
        orderCount = 2
        let secondStarted = false
        const second = serializePartnerSummaryRefresh('customers', 'workspace', 'customer', async () => {
            secondStarted = true
            storedTotal = orderCount
        })
        await Promise.resolve()
        expect(secondStarted).toBe(false)
        gate.resolve()
        await Promise.all([first, second])
        expect(storedTotal).toBe(2)
    })

    it('does not block unrelated customers, workspaces, or the partner summary', async () => {
        const gate = deferred()
        const blocked = serializePartnerSummaryRefresh('customers', 'one', 'same-id', () => gate.promise)
        try {
            expect(await Promise.all([
                serializePartnerSummaryRefresh('customers', 'two', 'same-id', async () => 'workspace'),
                serializePartnerSummaryRefresh('customers', 'one', 'another-id', async () => 'customer'),
                serializePartnerSummaryRefresh('business_partners', 'one', 'same-id', async () => 'partner')
            ])).toEqual(['workspace', 'customer', 'partner'])
        } finally {
            gate.resolve()
            await blocked
        }
    })

    it('propagates a failure to its caller and allows the next refresh to repair totals', async () => {
        const failed = serializePartnerSummaryRefresh('business_partners', 'workspace', 'partner', async () => {
            throw new Error('summary write failed')
        })
        const repaired = serializePartnerSummaryRefresh('business_partners', 'workspace', 'partner', async () => 2)
        await expect(failed).rejects.toThrow('summary write failed')
        await expect(repaired).resolves.toBe(2)
    })
})
