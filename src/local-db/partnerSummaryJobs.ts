import { db } from './database'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { invalidatePartnerSummaries } from './partnerSummaryState'

export type PartnerSummaryTarget = {
    workspaceId: string
    table: 'customers' | 'business_partners'
    entityId: string
}

export type PartnerSummaryJob = PartnerSummaryTarget & { id: string; revision: string }

const running = new Map<string, Promise<void>>()

export function processPartnerSummaryJobs(workspaceId: string): Promise<void> {
    const existing = running.get(workspaceId)
    if (existing) return existing
    const pending = drainPartnerSummaryJobs(workspaceId)
    running.set(workspaceId, pending)
    const clear = () => { if (running.get(workspaceId) === pending) running.delete(workspaceId) }
    void pending.then(clear, clear)
    return pending
}

async function drainPartnerSummaryJobs(workspaceId: string) {
    if (isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return
    const jobs = await db.partner_summary_jobs.where('workspaceId').equals(workspaceId).toArray()
    if (!jobs.length) return
    // Upgrade cleanup only. The underlying order/payment is already durable;
    // replaying these old cache-derived projections could overwrite server data.
    await db.partner_summary_jobs.where('workspaceId').equals(workspaceId).delete()
    invalidatePartnerSummaries(workspaceId)
}
