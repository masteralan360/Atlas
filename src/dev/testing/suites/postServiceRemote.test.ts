import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import type { DeliveryLedgerEntry, DeliveryShipment } from '@/local-db/models'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { postServiceErrorMessage } from '@/lib/postServiceErrors'
import { installTestBrowser } from '../fixtures/browser'
import { POST_ADMIN, POST_COURIER, POST_MERCHANT, POST_TIME, POST_WORKSPACE, postInput, seedPostParties } from '../fixtures/postService'
import { assertPostSettlement, postPayments } from '../assertions/postService'

const remote = vi.hoisted(() => ({ rpc: vi.fn(), refresh: vi.fn(), remove: vi.fn(),
    writes: [] as { schema: string; table: string; operation: string; payload: unknown; columns?: string }[],
    failureTable: '' }))
vi.mock('@/auth/supabase', () => {
    const client = (schema: string) => ({ rpc: remote.rpc, from: (table: string) => {
        const write = (operation: string, payload: unknown) => {
            const entry = { schema, table, operation, payload, columns: undefined as string | undefined }
            remote.writes.push(entry)
            const rows = Array.isArray(payload) ? payload : [payload]
            const result = { error: remote.failureTable === table ? { message: 'Injected remote rejection', code: '42501' } : null,
                data: table === 'delivery_shipments' ? rows.map(row => ({ id: row.id, tracking_number: 'PST-SERVER-00001' })) : null }
            return Object.assign(Promise.resolve(result), { select: (columns: string) => { entry.columns = columns; return Promise.resolve(result) } })
        }
        return { upsert: (payload: unknown) => write('upsert', payload), insert: (payload: unknown) => write('insert', payload),
            update: (payload: unknown) => ({ eq: () => write('update', payload) }), delete: () => ({ eq: () => write('delete', null) }) }
    } })
    return { supabase: { ...client('public'), schema: client, storage: { from: () => ({ remove: remote.remove }) } } }
})
vi.mock('@/local-db/hooks', async importOriginal => ({ ...await importOriginal<typeof import('@/local-db/hooks')>(), fetchTableFromSupabase: remote.refresh }))
vi.mock('@/lib/supabaseRequest', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/supabaseRequest')>(),
    runSupabaseAction: (_name: string, action: () => unknown) => action() }))

let service: typeof import('@/local-db/postService')
let i18n: typeof import('@/i18n/config').default

describe('Post Service Cloud and Hybrid client contracts', () => {
    beforeAll(async () => {
        installTestBrowser(); service = await import('@/local-db/postService'); i18n = (await import('@/i18n/config')).default
    })
    beforeEach(async () => {
        await db.delete(); await db.open(); await seedPostParties()
        remote.writes.length = 0; remote.failureTable = ''
        remote.rpc.mockReset().mockResolvedValue({ data: null, error: null })
        remote.refresh.mockReset().mockResolvedValue(undefined)
        remote.remove.mockReset().mockResolvedValue({ error: null })
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode: 'cloud' }); setNetworkStatus(true)
    })
    afterEach(() => {
        vi.restoreAllMocks(); clearWorkspaceModeSnapshot(POST_WORKSPACE); setNetworkStatus(true)
        setActiveBusinessUser(null); setActiveBusinessWorkspace(null)
    })
    afterAll(async () => { await db.delete() })

    const create = async (prepaid = false) => {
        const profile = await service.createDeliveryMerchantProfile(POST_WORKSPACE, { businessPartnerId: POST_MERCHANT, defaultFeeAmount: 10 })
        return service.createDeliveryShipment(POST_WORKSPACE, postInput(profile.id, { customerPaymentStatus: prepaid ? 'prepaid_electronically' : 'cash_on_delivery' }))
    }
    for (const dataMode of ['cloud', 'hybrid'] as const) it(`${dataMode} sends scoped, sanitized writes in dependency order and adopts server tracking`, async () => {
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode })
        const shipment = await create()
        const writes = remote.writes.filter(row => row.table.startsWith('delivery_'))
        expect(writes.map(row => row.table)).toEqual(['delivery_merchant_profiles', 'delivery_merchant_profiles', 'delivery_shipments', 'delivery_shipment_events'])
        for (const row of writes) {
            expect(row.schema).toBe('delivery')
            for (const payload of row.payload as Record<string, unknown>[]) {
                expect(payload.workspace_id).toBe(POST_WORKSPACE)
                expect(payload).not.toHaveProperty('sync_status'); expect(payload).not.toHaveProperty('last_synced_at')
            }
        }
        expect(writes[2].columns).toBe('id, tracking_number')
        expect(shipment.trackingNumber).toBe('PST-SERVER-00001')
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ trackingNumber: 'PST-SERVER-00001', syncStatus: 'synced' })
        expect(await db.offline_mutations.count()).toBe(0)
    })
    for (const dataMode of ['cloud', 'hybrid'] as const) it(`${dataMode} retains a failed parent and queues dependants without premature server calls`, async () => {
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode })
        const profile = await service.createDeliveryMerchantProfile(POST_WORKSPACE, { businessPartnerId: POST_MERCHANT })
        remote.writes.length = 0; remote.failureTable = 'delivery_merchant_profiles'
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const shipment = await service.createDeliveryShipment(POST_WORKSPACE, postInput(profile.id))
        expect(remote.writes.map(row => row.table)).toEqual(['delivery_merchant_profiles'])
        const queued = await db.offline_mutations.toArray()
        expect(queued.map(row => row.entityType).sort()).toEqual(['delivery_merchant_profiles', 'delivery_shipment_events', 'delivery_shipments'])
        for (const row of queued) expect(row.workspaceId).toBe(POST_WORKSPACE)
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status: 'received', syncStatus: 'pending' })
    })
    it('offline Cloud creates pending records and queues the same IDs without contacting the backend', async () => {
        setNetworkStatus(false)
        const shipment = await create()
        expect(shipment.trackingNumber).toMatch(/^PST-PENDING-/)
        expect(remote.writes).toHaveLength(0)
        expect(await db.offline_mutations.where('entityId').equals(shipment.id).count()).toBe(1)
    })
    it('Local creation and tab refresh make no remote calls or business sync queue', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode: 'local' })
        await create(); await service.refreshPostServiceTab(POST_WORKSPACE, 'posts')
        expect(remote.writes).toHaveLength(0); expect(remote.refresh).not.toHaveBeenCalled(); expect(remote.rpc).not.toHaveBeenCalled()
        expect(await db.offline_mutations.count()).toBe(0)
    })
    for (const [tab, tables] of [
        ['posts', ['business_partners', 'delivery_merchant_profiles', 'delivery_shipments', 'delivery_shipment_events', 'delivery_shipment_cod_adjustment_requests', 'delivery_shipment_cod_corrections', 'delivery_shipment_recipient_payout_corrections', 'delivery_shipment_recipient_payout_adjustment_requests', 'delivery_ledger_entries']],
        ['dispatch', ['business_partners', 'agents', 'fleet_vehicles', 'delivery_shipments', 'delivery_runs']],
        ['my-deliveries', ['business_partners', 'agents', 'delivery_shipments', 'delivery_shipment_cod_adjustment_requests', 'delivery_shipment_recipient_payout_adjustment_requests', 'delivery_ledger_entries']],
        ['merchants', ['business_partners', 'delivery_merchant_profiles', 'delivery_ledger_entries']],
        ['courier', ['business_partners', 'agents', 'delivery_shipments', 'delivery_ledger_entries']],
        ['settlements', ['business_partners', 'agents', 'delivery_merchant_profiles', 'delivery_settlements', 'delivery_ledger_entries']]
    ] as const) it(`${tab} refreshes exactly its scoped tables`, async () => {
        await service.refreshPostServiceTab(POST_WORKSPACE, tab)
        expect(remote.refresh.mock.calls.map(call => call[0])).toEqual(tables)
        for (const call of remote.refresh.mock.calls) { expect(call[1].name).toBe(call[0]); expect(call[2]).toBe(POST_WORKSPACE) }
    })

    for (const dataMode of ['cloud', 'hybrid'] as const) for (const recipient of [false, true]) it(`${dataMode} ${recipient ? 'recipient payout' : 'COD'} correction uses atomic RPC and hydrates authoritative records and ledger`, async () => {
        // Seed a delivered production record locally; the remote mock supplies the authoritative correction response.
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode: 'local' })
        const received = await create(recipient)
        if (recipient) await db.delivery_shipments.update(received.id, { recipientPayoutAmount: 20 })
        await service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [received.id] })
        await service.updateDeliveryShipmentStatus(received.id, { status: 'delivered' })
        const original = (await db.delivery_shipments.get(received.id))!
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode }); remote.writes.length = 0
        const operationId = crypto.randomUUID()
        const table = recipient ? 'delivery_shipment_recipient_payout_corrections' : 'delivery_shipment_cod_corrections'
        const authoritative: DeliveryShipment = { ...original, version: original.version + 1,
            ...(recipient ? { recipientPayoutAmount: 25.5 } : { codAmount: 125.5 }), syncStatus: 'synced' }
        const ledgerRows = ['courier', 'merchant'].map(party => ({ id: `${operationId}:${party}`, workspaceId: POST_WORKSPACE,
            shipmentId: original.id, settlementId: null, agentId: party === 'courier' ? POST_COURIER : null,
            merchantProfileId: party === 'merchant' ? original.merchantProfileId : null,
            businessPartnerId: party === 'merchant' ? POST_MERCHANT : null,
            kind: `${party}_${recipient ? 'recipient_payout' : 'cod'}_correction`, amount: recipient ? -5.5 : 25.5,
            currency: original.currency, occurredAt: POST_TIME, note: null, createdBy: POST_ADMIN,
            createdAt: POST_TIME, updatedAt: POST_TIME, version: 1, isDeleted: false, syncStatus: 'synced', lastSyncedAt: POST_TIME,
            ...(recipient ? { recipientPayoutCorrectionId: operationId } : { codCorrectionId: operationId }) })) as DeliveryLedgerEntry[]
        const correction = { id: operationId, workspaceId: POST_WORKSPACE, shipmentId: original.id, correctedBy: POST_ADMIN,
            ...(recipient ? { originalRecipientPayoutAmount: 20, correctedRecipientPayoutAmount: 25.5 }
                : { originalCodAmount: 100, correctedCodAmount: 125.5 }) }
        remote.refresh.mockImplementation(async (name: string, target: { put: (row: unknown) => Promise<unknown>; bulkPut: (rows: unknown[]) => Promise<unknown> }) => {
            if (name === 'delivery_shipments') await target.put(authoritative)
            if (name === table) await target.put(correction)
            if (name === 'delivery_ledger_entries') await target.bulkPut(ledgerRows)
        })
        const common = { operationId, shipmentId: original.id, expectedVersion: original.version, actorRole: 'admin' as const, actorUserId: POST_ADMIN }
        const result = recipient ? await service.correctDeliveredDeliveryShipmentRecipientPayout(POST_WORKSPACE, { ...common, correctedRecipientPayoutAmount: 25.5 })
            : await service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { ...common, correctedCodAmount: 125.5 })
        expect(remote.rpc).toHaveBeenCalledWith(recipient ? 'correct_delivered_shipment_recipient_payout' : 'correct_delivered_shipment_cod', {
            p_workspace_id: POST_WORKSPACE, p_shipment_id: original.id, p_expected_version: original.version, p_operation_id: operationId,
            ...(recipient ? { p_corrected_recipient_payout_amount: 25.5 } : { p_corrected_cod_amount: 125.5 }) })
        expect(remote.refresh.mock.calls.map(call => call[0])).toEqual(['delivery_shipments', table, 'delivery_ledger_entries'])
        expect(result).toEqual(authoritative)
        expect(await db.table(table).get(operationId)).toEqual(correction)
        for (const row of ledgerRows) expect(await db.delivery_ledger_entries.get(row.id)).toEqual(row)
        expect(await postPayments()).toHaveLength(0); expect(await db.offline_mutations.count()).toBe(0)
    })
    for (const dataMode of ['cloud', 'hybrid'] as const) it(`${dataMode} settlement persists its actual payment, clearing lines and returned payment link`, async () => {
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode: 'local' })
        const shipment = await create()
        await service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id] })
        await service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered' })
        writeWorkspaceModeSnapshot({ workspaceId: POST_WORKSPACE, dataMode }); remote.writes.length = 0
        const settlement = await service.settleDeliveryCourier(POST_WORKSPACE, { agentId: POST_COURIER, shipmentId: shipment.id,
            currency: 'usd', actualAmount: 95, paymentMethod: 'bank_transfer' })
        await assertPostSettlement(settlement, 'incoming')
        expect(remote.writes.map(row => row.table)).toEqual(['payment_transactions', 'delivery_settlements', 'delivery_ledger_entries', 'delivery_settlements'])
        expect(remote.writes[0].payload).toMatchObject({ workspace_id: POST_WORKSPACE, source_record_id: settlement.id, amount: 95, direction: 'incoming' })
        expect(await db.delivery_settlements.get(settlement.id)).toMatchObject({ paymentTransactionId: settlement.paymentTransactionId, syncStatus: 'synced' })
    })
    it('offline correction produces a localized connectivity message without RPC, payment or queued correction', async () => {
        setNetworkStatus(false)
        let error: unknown
        try { await service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { operationId: 'operation', shipmentId: 'shipment',
            expectedVersion: 1, actorRole: 'admin', actorUserId: POST_ADMIN, correctedCodAmount: 125 }) } catch (caught) { error = caught }
        expect(postServiceErrorMessage(i18n.t.bind(i18n), error)).toBe(i18n.t('postService.errors.deliveredCodCorrectionOnlineRequired'))
        expect(remote.rpc).not.toHaveBeenCalled(); expect(await db.offline_mutations.count()).toBe(0)
    })
    it('RPC rejection leaves cached shipment, ledger and payments unchanged', async () => {
        const shipment = await create()
        remote.rpc.mockResolvedValue({ error: { message: 'This post has changed. Refresh it before correcting the COD' } })
        await expect(service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { operationId: 'operation', shipmentId: shipment.id,
            expectedVersion: shipment.version, actorRole: 'admin', actorUserId: POST_ADMIN, correctedCodAmount: 125 })).rejects.toMatchObject({ message: expect.stringContaining('changed') })
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ codAmount: 100, version: 1 })
        expect(remote.refresh).not.toHaveBeenCalled(); expect(await db.delivery_ledger_entries.count()).toBe(0)
        expect(await postPayments()).toHaveLength(0)
    })
    it('hydration failure reports failure without inventing local correction rows or retry queue', async () => {
        remote.refresh.mockRejectedValue(new Error('Injected hydration failure'))
        await expect(service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { operationId: 'operation', shipmentId: 'shipment',
            expectedVersion: 3, actorRole: 'admin', actorUserId: POST_ADMIN, correctedCodAmount: 125 })).rejects.toThrow('Injected hydration')
        expect(await db.delivery_shipment_cod_corrections.count()).toBe(0); expect(await db.offline_mutations.count()).toBe(0)
    })
    it('queues failed postponed-voice cleanup after redispatch without undoing its committed manifest', async () => {
        const shipment = await create()
        await service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id] })
        const path = `${POST_WORKSPACE}/${shipment.id}/postponed/test.flac`
        await service.updateDeliveryShipmentStatus(shipment.id, { status: 'postponed', voiceReasonPath: path, voiceReasonDurationMs: 1000 })
        remote.remove.mockResolvedValue({ error: { message: 'Injected storage rejection' } })
        const run = await service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id] })
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status: 'assigned', assignedRunId: run.id })
        expect(remote.remove).toHaveBeenCalledWith([path])
        expect((await db.offline_mutations.toArray()).filter(row => row.entityType === 'delivery_voice_cleanup')).toEqual([
            expect.objectContaining({ workspaceId: POST_WORKSPACE, entityId: shipment.id, payload: expect.objectContaining({ paths: [path] }) })])
    })
    it('unrecognized backend errors must use the generic friendly message instead of exposing technical details', () => {
        expect(postServiceErrorMessage(i18n.t.bind(i18n), { message: 'permission denied for relation delivery_shipments (SQLSTATE 42501)' }))
            .toBe(i18n.t('postService.errors.generic'))
    })
    for (const language of ['en', 'ku', 'ar']) it(`${language} maps known remote failures through the actual page error mapper`, () => {
        const t = i18n.getFixedT(language)
        for (const [message, key] of [
            ['This post has changed. Refresh it before correcting the COD', 'deliveredCodCorrectionChanged'],
            ['Connect to the internet before correcting a delivered recipient payout', 'deliveredRecipientPayoutCorrectionOnlineRequired'],
            ['Settlement amount cannot exceed the outstanding balance', 'amountExceedsBalance']
        ]) {
            expect(postServiceErrorMessage(t, { message })).toBe(t(`postService.errors.${key}`))
            expect(t(`postService.errors.${key}`)).not.toBe(`postService.errors.${key}`)
        }
    })
})
