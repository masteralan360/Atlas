import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { setNetworkStatus } from '@/lib/network'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { AtlasDatabase, db } from './database'
import { enqueuePartnerSummaryJobs, processPartnerSummaryJobs, type PartnerSummaryTarget } from './partnerSummaryJobs'

const refresh = vi.hoisted(() => ({ customer: vi.fn(), partner: vi.fn() }))
vi.mock('./orders', () => ({ recalculateCustomerSummary: refresh.customer }))
vi.mock('./businessPartners', () => ({ recalculateBusinessPartnerSummary: refresh.partner }))

const customer: PartnerSummaryTarget = { workspaceId: 'workspace', table: 'customers', entityId: 'customer' }
const partner: PartnerSummaryTarget = { workspaceId: 'workspace', table: 'business_partners', entityId: 'partner' }

describe('durable partner summary jobs', () => {
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
        await enqueuePartnerSummaryJobs([customer, partner])
        db.close()
        await db.open()
        expect(await db.partner_summary_jobs.count()).toBe(2)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).toHaveBeenCalledWith('workspace', 'customer', { ensureSync: true })
        expect(refresh.partner).toHaveBeenCalledWith('workspace', 'partner', { ensureSync: true })
        expect(await db.partner_summary_jobs.count()).toBe(0)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).toHaveBeenCalledTimes(1)
    })

    it('coalesces duplicate targets while keeping workspaces separate', async () => {
        await enqueuePartnerSummaryJobs([customer, customer, { ...customer, workspaceId: 'other' }])
        expect(await db.partner_summary_jobs.count()).toBe(2)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).toHaveBeenCalledTimes(1)
        expect((await db.partner_summary_jobs.toArray()).map((job) => job.workspaceId)).toEqual(['other'])
    })

    it('preserves a newer save while an older refresh is finishing', async () => {
        let release!: () => void
        refresh.customer.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
        await enqueuePartnerSummaryJobs([customer])
        const first = processPartnerSummaryJobs('workspace')
        await vi.waitFor(() => expect(refresh.customer).toHaveBeenCalledTimes(1))
        await enqueuePartnerSummaryJobs([customer])
        release()
        await first
        expect(await db.partner_summary_jobs.count()).toBe(1)
        await processPartnerSummaryJobs('workspace')
        expect(refresh.customer).toHaveBeenCalledTimes(2)
        expect(await db.partner_summary_jobs.count()).toBe(0)
    })

    it('retains a failed job across restart while allowing the other summary to finish', async () => {
        refresh.customer.mockRejectedValueOnce(new Error('Local write interrupted'))
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        try {
            await enqueuePartnerSummaryJobs([customer, partner])
            await processPartnerSummaryJobs('workspace')
            expect((await db.partner_summary_jobs.toArray()).map((job) => job.table)).toEqual(['customers'])
            db.close()
            await db.open()
            await processPartnerSummaryJobs('workspace')
            expect(await db.partner_summary_jobs.count()).toBe(0)
        } finally { log.mockRestore() }
    })

    it('keeps jobs offline and resumes on connectivity restoration; Local mode never uploads them', async () => {
        await enqueuePartnerSummaryJobs([customer, partner])
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
        await enqueuePartnerSummaryJobs([customer, partner])
        await Promise.all([processPartnerSummaryJobs('workspace'), processPartnerSummaryJobs('workspace')])
        expect(refresh.customer).toHaveBeenCalledTimes(1)
        expect(refresh.partner).toHaveBeenCalledTimes(1)
    })

    it('surfaces persistence failure so a save cannot report durable success', async () => {
        const put = vi.spyOn(db.partner_summary_jobs, 'bulkPut').mockRejectedValueOnce(new Error('Disk full'))
        try { await expect(enqueuePartnerSummaryJobs([customer])).rejects.toThrow('Disk full') }
        finally { put.mockRestore() }
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
    })
})
