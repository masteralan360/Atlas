import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './database'
import type { BusinessPartner } from './models'

const remote = vi.hoisted(() => ({
    result: { data: { name: true, phone: false } as unknown, error: null as unknown },
    rpc: vi.fn(),
    abortSignal: vi.fn(),
}))
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/workspace/WorkspaceContext', () => ({ useWorkspace: () => ({ hasCapability: () => false }) }))
vi.mock('@/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => true }))
vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: () => ({
        rpc: (...args: unknown[]) => {
            remote.rpc(...args)
            return { abortSignal: (signal: AbortSignal) => {
                remote.abortSignal(signal)
                return Promise.resolve(remote.result)
            } }
        },
    }),
}))

import { fetchRemoteBusinessPartnerDuplicates, readLocalBusinessPartnerDuplicates } from './businessPartnerDuplicates'

const workspaceId = 'duplicates-workspace'
const viewer = { userId: 'staff', role: 'staff' as const, featureEnabled: false }
const row = (id: string, changes: Partial<BusinessPartner> = {}): BusinessPartner => ({
    id, workspaceId, partnerName: 'Acme', phone: '٠٧٧٠-١٢٣-٤٥٦٧', role: 'customer',
    syncStatus: 'synced', isDeleted: false, ...changes,
} as BusinessPartner)

describe('focused business partner duplicate reads', () => {
    beforeEach(async () => {
        await db.delete()
        await db.open()
        remote.result = { data: { name: true, phone: false }, error: null }
    })
    afterEach(() => vi.clearAllMocks())
    afterAll(async () => db.delete())

    it('matches normalized identities without including deleted, merged, excluded, or other workspace rows', async () => {
        await db.business_partners.bulkPut([
            row('self'), row('deleted', { isDeleted: true }), row('merged', { mergedIntoBusinessPartnerId: 'self' }),
            row('other', { workspaceId: 'other' }), row('witness', { role: 'witness' as BusinessPartner['role'] }),
        ])
        const input = { name: ' ACME ', phone: '07701234567', excludeBusinessPartnerId: 'self' }
        expect(await readLocalBusinessPartnerDuplicates(workspaceId, input, viewer)).toEqual({ name: false, phone: false })
        await db.business_partners.put(row('match', { partnerName: '  Acme  ' }))
        expect(await readLocalBusinessPartnerDuplicates(workspaceId, input, viewer)).toEqual({ name: true, phone: true })
    })

    it('includes pending and conflicting local edits without scanning synced cloud cache rows', async () => {
        await db.business_partners.bulkPut([
            row('synced'), row('pending', { partnerName: 'Pending', phone: '', syncStatus: 'pending' }),
            row('conflict', { partnerName: 'Conflict', syncStatus: 'conflict' }),
        ])
        expect(await readLocalBusinessPartnerDuplicates(workspaceId, { name: 'Acme', phone: '' }, viewer, true))
            .toEqual({ name: false, phone: false })
        expect(await readLocalBusinessPartnerDuplicates(workspaceId, { name: 'Pending', phone: '07701234567' }, viewer, true))
            .toEqual({ name: true, phone: true })
    })

    it('applies group visibility before reporting a local duplicate', async () => {
        await db.business_partners.put(row('hidden'))
        const input = { name: 'Acme', phone: '07701234567' }
        expect(await readLocalBusinessPartnerDuplicates(workspaceId, input, { ...viewer, featureEnabled: true }))
            .toEqual({ name: false, phone: false })
        expect(await readLocalBusinessPartnerDuplicates(workspaceId, input, { ...viewer, role: 'admin', featureEnabled: true }))
            .toEqual({ name: true, phone: true })
    })

    it('requests only duplicate flags with cancellation and never hydrates or rewrites cached partners', async () => {
        await db.business_partners.put(row('pending', { syncStatus: 'pending' }))
        const before = await db.business_partners.get('pending')
        const controller = new AbortController()
        expect(await fetchRemoteBusinessPartnerDuplicates(workspaceId, {
            name: ' ACME ', phone: '٠٧٧٠-١٢٣-٤٥٦٧', excludeBusinessPartnerId: 'self',
        }, controller.signal)).toEqual({ name: true, phone: false })
        expect(remote.rpc).toHaveBeenCalledExactlyOnceWith('check_business_partner_duplicates', {
            p_workspace_id: workspaceId, p_name: 'acme', p_phone: '07701234567', p_exclude_id: 'self',
        })
        expect(remote.abortSignal).toHaveBeenCalledWith(controller.signal)
        expect(await db.business_partners.get('pending')).toEqual(before)
        expect(await db.business_partners.count()).toBe(1)
    })

    it('rejects failed and malformed remote responses instead of reporting an available identity', async () => {
        remote.result = { data: null, error: new Error('Unavailable') }
        await expect(fetchRemoteBusinessPartnerDuplicates(workspaceId, { name: 'Acme', phone: '' }, new AbortController().signal))
            .rejects.toThrow('Unavailable')
        remote.result = { data: { name: 'yes' }, error: null }
        await expect(fetchRemoteBusinessPartnerDuplicates(workspaceId, { name: 'Acme', phone: '' }, new AbortController().signal))
            .rejects.toThrow('Invalid business partner duplicate check response')
    })
})
