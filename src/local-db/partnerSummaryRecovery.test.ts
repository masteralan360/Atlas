import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('./partnerSummaryJobs', () => ({ processPartnerSummaryJobs: mocks.run }))
vi.mock('@/lib/connectionManager', () => ({ connectionManager: { subscribe: mocks.subscribe } }))
import { startPartnerSummaryRecovery } from './partnerSummaryRecovery'

describe('partner summary recovery lifecycle', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
    it('resumes on startup, reconnect, wake and retry, and stops after workspace cleanup', async () => {
        vi.useFakeTimers()
        mocks.run.mockReset().mockResolvedValue(undefined)
        let event!: (name: string) => void
        mocks.subscribe.mockImplementation((listener) => { event = listener; return mocks.unsubscribe })
        const stop = startPartnerSummaryRecovery('workspace')
        expect(mocks.run).toHaveBeenCalledWith('workspace')
        event('offline')
        expect(mocks.run).toHaveBeenCalledTimes(1)
        event('online')
        event('wake')
        expect(mocks.run).toHaveBeenCalledTimes(3)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(mocks.run).toHaveBeenCalledTimes(4)
        stop()
        expect(mocks.unsubscribe).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(mocks.run).toHaveBeenCalledTimes(4)
    })
})
