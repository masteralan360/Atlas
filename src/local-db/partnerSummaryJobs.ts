import { db } from './database'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

export type PartnerSummaryTarget = {
    workspaceId: string
    table: 'customers' | 'business_partners'
    entityId: string
}

export type PartnerSummaryJob = PartnerSummaryTarget & { id: string; revision: string }

/** Commit the intent before reporting save success. No business records are replayed. */
export async function enqueuePartnerSummaryJobs(targets: PartnerSummaryTarget[]) {
    const jobs = new Map<string, PartnerSummaryJob>()
    for (const target of targets) {
        const id = JSON.stringify([target.workspaceId, target.table, target.entityId])
        jobs.set(id, { ...target, id, revision: crypto.randomUUID() })
    }
    await db.partner_summary_jobs.bulkPut([...jobs.values()])
}

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
    const [{ recalculateCustomerSummary }, { recalculateBusinessPartnerSummary }] = await Promise.all([
        import('./orders'), import('./businessPartners')
    ])
    await Promise.all(jobs.map(async (job) => {
        try {
            // Force the write even when the cached totals already match: an
            // earlier process may have stopped between the local put and upload.
            if (job.table === 'customers') {
                await recalculateCustomerSummary(workspaceId, job.entityId, { ensureSync: true })
            } else {
                await recalculateBusinessPartnerSummary(workspaceId, job.entityId, { ensureSync: true })
            }
            // A resolved refresh has either been acknowledged remotely or handed
            // off to the persistent offline mutation queue. Keep any newer intent.
            await db.transaction('rw', db.partner_summary_jobs, async () => {
                const current = await db.partner_summary_jobs.get(job.id)
                if (current?.revision === job.revision) await db.partner_summary_jobs.delete(job.id)
            })
        } catch (error) {
            // Retain the durable job on calculation, storage or queue-write failure.
            console.error('[Orders] Pending partner summary refresh will be retried:', error)
        }
    }))
}
