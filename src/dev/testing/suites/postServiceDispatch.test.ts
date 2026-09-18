import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_COURIER, POST_OTHER_WORKSPACE, POST_SECOND_COURIER, POST_WORKSPACE, postInput } from '../fixtures/postService'

describe('Post Service dispatch and manifests', () => {
    const h = usePostServiceHarness()
    it('deduplicates manifest items and snapshots courier fees on the run and shipments', async () => {
        const a = await h.shipment(), b = await h.shipment()
        const run = await h.service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [a.id, a.id, b.id], courierDeliveryFee: 7.25 })
        const items = await db.delivery_run_items.where('runId').equals(run.id).toArray()
        expect(items).toHaveLength(2)
        await db.agents.update(POST_COURIER, { courierDeliveryFee: 20 })
        for (const shipment of [a, b]) expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status: 'assigned', assignedRunId: run.id, courierDeliveryFee: 7.25 })
        expect(run.courierDeliveryFee).toBe(7.25)
        for (const item of items) expect([a.id, b.id]).toContain(item.shipmentId)
        expect(await db.payment_transactions.count()).toBe(0)
    })
    for (const patch of [{ status: 'inactive' as const }, { isDeleted: true }, { workspaceId: POST_OTHER_WORKSPACE }, { agentType: 'field_agent' as const }]) it(`rejects ineligible courier ${JSON.stringify(patch)}`, async () => {
        const shipment = await h.shipment()
        await db.agents.update(POST_COURIER, patch)
        await expect(h.service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id] })).rejects.toThrow()
        expect(await db.delivery_runs.count()).toBe(0)
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
    })
    it('validates the entire batch before assigning any shipment', async () => {
        const a = await h.shipment(), b = await h.shipment({}, true)
        for (const shipmentIds of [[], [a.id, 'missing'], [a.id, b.id]]) {
            await expect(h.service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_SECOND_COURIER, shipmentIds })).rejects.toThrow()
        }
        expect(await db.delivery_shipments.get(a.id)).toEqual(a)
        expect(await db.delivery_runs.count()).toBe(1)
    })
    it('replays create-and-dispatch with one shipment, manifest and item', async () => {
        const profile = await h.profile()
        const input = { operationId: crypto.randomUUID(), shipment: postInput(profile.id), agentId: POST_COURIER }
        await h.service.createAndDispatchDeliveryShipment(POST_WORKSPACE, input)
        await h.service.createAndDispatchDeliveryShipment(POST_WORKSPACE, input)
        expect(await db.delivery_shipments.count()).toBe(1)
        expect(await db.delivery_runs.count()).toBe(1)
        expect(await db.delivery_run_items.count()).toBe(1)
        expect(await db.delivery_shipment_events.count()).toBe(2)
    })
    it('closes a manifest once without altering shipment or accounting', async () => {
        const shipment = await h.shipment({}, true)
        const closed = await h.service.closeDeliveryRun(shipment.assignedRunId!)
        expect(closed).toMatchObject({ status: 'closed', version: 2 })
        expect(await h.service.closeDeliveryRun(shipment.assignedRunId!)).toEqual(closed)
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
        expect(await db.delivery_ledger_entries.count()).toBe(0)
    })
})
