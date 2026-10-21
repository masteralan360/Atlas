import { connectionManager } from '@/lib/connectionManager'
import { processPartnerSummaryJobs } from './partnerSummaryJobs'

/** Retire pre-migration summary intents when the workspace is ready, online or awake. */
export function startPartnerSummaryRecovery(workspaceId: string) {
    const recover = () => {
        void processPartnerSummaryJobs(workspaceId).catch((error) => {
            console.error('[Orders] Could not resume partner summary refresh:', error)
        })
    }
    const unsubscribe = connectionManager.subscribe((event) => {
        if (event === 'online' || event === 'wake') recover()
    })
    recover()
    return () => {
        unsubscribe()
    }
}
