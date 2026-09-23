import { connectionManager } from '@/lib/connectionManager'
import { processPartnerSummaryJobs } from './partnerSummaryJobs'

/** Restart recovery when the authenticated workspace is ready, online or awake. */
export function startPartnerSummaryRecovery(workspaceId: string) {
    const recover = () => {
        void processPartnerSummaryJobs(workspaceId).catch((error) => {
            console.error('[Orders] Could not resume partner summary refresh:', error)
        })
    }
    const unsubscribe = connectionManager.subscribe((event) => {
        if (event === 'online' || event === 'wake') recover()
    })
    // Covers transient storage/calculation failures and a newer revision queued
    // during an earlier pass without making order saves wait for that pass.
    const timer = setInterval(recover, 30_000)
    recover()
    return () => {
        unsubscribe()
        clearInterval(timer)
    }
}
