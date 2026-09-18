import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { isVisibleDeliveryLedgerEntry } from '@/lib/postServiceLedgerVisibility'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_ADMIN, POST_COURIER, POST_OTHER_WORKSPACE, POST_SECOND_COURIER, POST_WORKSPACE, postInput } from '../fixtures/postService'

describe('Post Service permissions and scope guards', () => {
    const h = usePostServiceHarness()
    it('blocks non-admin administrative mutations without changing records', async () => {
        const received = await h.shipment()
        const delivered = await h.delivered()
        const role = 'staff' as 'admin' // Exercise runtime authorization, beyond the TypeScript API restriction.
        await expect(h.service.adminEditReceivedDeliveryShipment(POST_WORKSPACE, { shipmentId: received.id, expectedVersion: received.version,
            actorRole: role, shipment: postInput(received.merchantProfileId) })).rejects.toThrow('administrator')
        await expect(h.service.adminEditAndRedispatchDeliveryShipment(POST_WORKSPACE, { shipmentId: received.id, expectedVersion: received.version,
            operationId: crypto.randomUUID(), actorRole: role, agentId: POST_COURIER, shipment: postInput(received.merchantProfileId) })).rejects.toThrow('administrator')
        await expect(h.service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { shipmentId: delivered.id, expectedVersion: delivered.version,
            operationId: crypto.randomUUID(), actorRole: role, actorUserId: POST_ADMIN, correctedCodAmount: 125 })).rejects.toThrow('administrator')
        await expect(h.service.receiveReturnedDeliveryShipment(POST_WORKSPACE, { shipmentId: received.id, expectedVersion: received.version,
            actorRole: role })).rejects.toThrow('administrator')
        expect(await db.delivery_shipments.get(received.id)).toEqual(received)
        expect(await db.delivery_shipments.get(delivered.id)).toEqual(delivered)
    })
    it('requires the linked courier identity for change requests', async () => {
        const shipment = await h.shipment({}, true)
        await db.agents.update(POST_COURIER, { linkedUserId: 'linked-user' })
        for (const [requesterUserId, requesterAgentId] of [['other-user', POST_COURIER], ['linked-user', POST_SECOND_COURIER]]) {
            await expect(h.service.requestDeliveryShipmentCodAdjustment(POST_WORKSPACE, { shipmentId: shipment.id,
                requesterUserId, requesterAgentId, requestedCodAmount: 125, reason: '' })).rejects.toThrow('assigned')
        }
        expect(await db.delivery_shipment_cod_adjustment_requests.count()).toBe(0)
    })
    it('rejects cross-workspace settlements and corrections', async () => {
        const shipment = await h.delivered()
        await expect(h.service.settleDeliveryCourier(POST_OTHER_WORKSPACE, { agentId: POST_COURIER,
            actualAmount: 95, currency: 'usd', paymentMethod: 'cash' })).rejects.toThrow('not found')
        await expect(h.service.payDeliveryMerchant(POST_OTHER_WORKSPACE, { merchantProfileId: shipment.merchantProfileId,
            actualAmount: 90, currency: 'usd', paymentMethod: 'cash' })).rejects.toThrow('not found')
        await expect(h.service.correctDeliveredDeliveryShipmentCod(POST_OTHER_WORKSPACE, { shipmentId: shipment.id,
            expectedVersion: shipment.version, operationId: crypto.randomUUID(), actorRole: 'admin', actorUserId: POST_ADMIN, correctedCodAmount: 125 })).rejects.toThrow('not found')
        expect(await db.payment_transactions.count()).toBe(0)
    })
    for (const deleted of [false, true]) for (const visiblePost of [false, true]) for (const ownCourier of [false, true]) it(`view-own deleted=${deleted} visiblePost=${visiblePost} ownCourier=${ownCourier}`, () => {
        expect(isVisibleDeliveryLedgerEntry({ isDeleted: deleted, shipmentId: 'post', agentId: 'courier' },
            new Set(visiblePost ? ['post'] : []), new Set(ownCourier ? ['courier'] : []))).toBe(!deleted && (visiblePost || ownCourier))
    })
    it('keeps own aggregate remittances visible while excluding another courier', () => {
        expect(isVisibleDeliveryLedgerEntry({ isDeleted: false, shipmentId: null, agentId: POST_COURIER }, new Set(), new Set([POST_COURIER]))).toBe(true)
        expect(isVisibleDeliveryLedgerEntry({ isDeleted: false, shipmentId: null, agentId: POST_SECOND_COURIER }, new Set(), new Set([POST_COURIER]))).toBe(false)
    })
})
