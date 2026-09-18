import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_ADMIN, POST_COURIER, POST_SECOND_COURIER, POST_WORKSPACE, postInput } from '../fixtures/postService'

describe('Post Service returns and administrative redispatch', () => {
    const h = usePostServiceHarness()
    it('transfers a returned package to another courier with an auditable prior item', async () => {
        const shipment = await h.shipment({}, true)
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'returned' })
        await expect(h.service.transferReturnedDeliveryShipment(POST_WORKSPACE, { shipmentId: shipment.id, agentId: POST_COURIER })).rejects.toThrow('different')
        const run = await h.service.transferReturnedDeliveryShipment(POST_WORKSPACE, { shipmentId: shipment.id, agentId: POST_SECOND_COURIER, courierDeliveryFee: 8 })
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status: 'assigned', assignedAgentId: POST_SECOND_COURIER, assignedRunId: run.id, courierDeliveryFee: 8 })
        expect((await db.delivery_run_items.where('runId').equals(shipment.assignedRunId!).first())?.returnedAt).toBeTruthy()
        expect(await db.payment_transactions.count()).toBe(0)
    })
    it('physically receives a return once and then blocks transfer', async () => {
        const shipment = await h.shipment({}, true)
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'returned' })
        const original = (await db.delivery_shipments.get(shipment.id))!
        const input = { shipmentId: original.id, expectedVersion: original.version, actorRole: 'admin' as const, actorUserId: POST_ADMIN }
        await expect(h.service.receiveReturnedDeliveryShipment(POST_WORKSPACE, { ...input, expectedVersion: 1 })).rejects.toThrow('changed')
        expect(await h.service.receiveReturnedDeliveryShipment(POST_WORKSPACE, input)).toMatchObject({ status: 'returned', returnReceivedAt: expect.any(String) })
        await expect(h.service.receiveReturnedDeliveryShipment(POST_WORKSPACE, input)).rejects.toThrow('already')
        await expect(h.service.transferReturnedDeliveryShipment(POST_WORKSPACE, { shipmentId: shipment.id, agentId: POST_SECOND_COURIER })).rejects.toThrow('received')
        expect(await db.delivery_ledger_entries.count()).toBe(0)
    })
    for (const status of ['received', 'assigned', 'postponed'] as const) it(`admin edits and redispatches ${status} with a stable operation key`, async () => {
        const shipment = await h.shipment({}, status !== 'received')
        if (status === 'postponed') await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'postponed' })
        const original = (await db.delivery_shipments.get(shipment.id))!
        const input = { operationId: crypto.randomUUID(), shipmentId: original.id, expectedVersion: original.version,
            actorRole: 'admin' as const, actorUserId: POST_ADMIN, shipment: postInput(original.merchantProfileId, { codAmount: 125.5 }), agentId: POST_SECOND_COURIER }
        await h.service.adminEditAndRedispatchDeliveryShipment(POST_WORKSPACE, input)
        const count = await db.delivery_runs.count()
        await h.service.adminEditAndRedispatchDeliveryShipment(POST_WORKSPACE, input)
        expect(await db.delivery_runs.count()).toBe(count)
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status: 'assigned', codAmount: 125.5, assignedAgentId: POST_SECOND_COURIER })
        expect(await db.payment_transactions.count()).toBe(0)
    })
    it('edits a received package without generating a manifest and rejects stale edits', async () => {
        const shipment = await h.shipment()
        const input = { shipmentId: shipment.id, expectedVersion: shipment.version, actorRole: 'admin' as const,
            shipment: postInput(shipment.merchantProfileId, { recipientAddress: 'Corrected address', deliveryFee: 0 }) }
        expect(await h.service.adminEditReceivedDeliveryShipment(POST_WORKSPACE, input)).toMatchObject({ status: 'received', recipientAddress: 'Corrected address', deliveryFee: 0 })
        await expect(h.service.adminEditReceivedDeliveryShipment(POST_WORKSPACE, input)).rejects.toThrow('changed')
        expect(await db.delivery_runs.count()).toBe(0)
    })
})
