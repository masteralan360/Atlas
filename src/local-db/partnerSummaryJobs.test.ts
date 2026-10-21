import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setNetworkStatus } from '@/lib/network'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { AtlasDatabase, db } from './database'
import { processPartnerSummaryJobs, type PartnerSummaryTarget } from './partnerSummaryJobs'

const refresh = vi.hoisted(() => ({ customer: vi.fn(), partner: vi.fn() }))
vi.mock('./orders', () => ({ recalculateCustomerSummary: refresh.customer }))
vi.mock('./businessPartners', () => ({ recalculateBusinessPartnerSummary: refresh.partner }))

async function seedLegacySummaryJobs(targets: PartnerSummaryTarget[]) {
    await db.partner_summary_jobs.bulkPut(targets.map(target => ({...target,
        id:JSON.stringify([target.workspaceId,target.table,target.entityId]),revision:crypto.randomUUID()})))
}

const customer: PartnerSummaryTarget = { workspaceId: 'workspace', table: 'customers', entityId: 'customer' }
const partner: PartnerSummaryTarget = { workspaceId: 'workspace', table: 'business_partners', entityId: 'partner' }

describe('retired partner summary job cleanup', () => {
    beforeAll(() => { installTestBrowser() })
    beforeEach(async () => {
        await db.delete()
        await db.open()
        writeWorkspaceModeSnapshot({ workspaceId: 'workspace', dataMode: 'cloud' })
        setNetworkStatus(true)
        refresh.customer.mockReset().mockResolvedValue(undefined)
        refresh.partner.mockReset().mockResolvedValue(undefined)
    })
    afterAll(async () => { await db.delete() })

    it('recovers both jobs after reopening the database, without replaying order creation', async () => {
        await seedLegacySummaryJobs([customer, partner])
        db.close()
        await db.open()
        expect(await db.partner_summary_jobs.count()).toBe(2)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).not.toHaveBeenCalled()
        expect(refresh.partner).not.toHaveBeenCalled()
        expect(await db.partner_summary_jobs.count()).toBe(0)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).not.toHaveBeenCalled()
    })

    it('coalesces duplicate targets while keeping workspaces separate', async () => {
        await seedLegacySummaryJobs([customer, customer, { ...customer, workspaceId: 'other' }])
        expect(await db.partner_summary_jobs.count()).toBe(2)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).not.toHaveBeenCalled()
        expect((await db.partner_summary_jobs.toArray()).map((job) => job.workspaceId)).toEqual(['other'])
    })

    it('does not alter pending business records or replay any of their operations', async () => {
        await db.offline_mutations.put({ id:'business-write', workspaceId:'workspace', entityType:'sales_orders',
            entityId:'order', operation:'update', payload:{notes:'unsent'}, status:'pending',
            createdAt:new Date().toISOString() })
        const before = await db.offline_mutations.toArray()
        await seedLegacySummaryJobs([customer,partner])
        await processPartnerSummaryJobs('workspace')
        expect(await db.offline_mutations.toArray()).toEqual(before)
        expect(refresh.customer).not.toHaveBeenCalled()
        expect(refresh.partner).not.toHaveBeenCalled()
    })

    it('keeps jobs offline and resumes on connectivity restoration; Local mode never uploads them', async () => {
        await seedLegacySummaryJobs([customer, partner])
        setNetworkStatus(false)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).not.toHaveBeenCalled()
        expect(await db.partner_summary_jobs.count()).toBe(2)
        setNetworkStatus(true)
        writeWorkspaceModeSnapshot({ workspaceId: 'workspace', dataMode: 'local' })
        await processPartnerSummaryJobs('workspace')
        expect(refresh.partner).not.toHaveBeenCalled()
        writeWorkspaceModeSnapshot({ workspaceId: 'workspace', dataMode: 'hybrid' })
        await processPartnerSummaryJobs('workspace')
        expect(await db.partner_summary_jobs.count()).toBe(0)
    })

    it('joins concurrent recovery attempts', async () => {
        await seedLegacySummaryJobs([customer, partner])
        await Promise.all([processPartnerSummaryJobs('workspace'), processPartnerSummaryJobs('workspace')])
        expect(refresh.customer).not.toHaveBeenCalled()
        expect(refresh.partner).not.toHaveBeenCalled()
        expect(await db.partner_summary_jobs.count()).toBe(0)
    })

    it('upgrades an existing version-133 cache without replacing its saved order', async () => {
        const name = 'AtlasPartnerSummaryUpgradeTest'
        const old = new Dexie(name)
        old.version(133).stores({ sales_orders: 'id, workspaceId' })
        await old.open()
        await old.table('sales_orders').put({ id: 'saved-order', workspaceId: 'workspace', total: 100 })
        old.close()
        const upgraded = new AtlasDatabase(name)
        try {
            await upgraded.open()
            expect(await upgraded.sales_orders.get('saved-order')).toMatchObject({ total: 100 })
            await upgraded.partner_summary_jobs.put({ ...customer, id: 'job', revision: 'revision' })
            upgraded.close()
            await upgraded.open()
            expect(await upgraded.partner_summary_jobs.get('job')).toMatchObject(customer)
        } finally {
            upgraded.close()
            await Dexie.delete(name)
        }
    }, 30_000)
})
