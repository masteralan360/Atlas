import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_ADMIN, POST_COURIER, POST_CURRENCIES, POST_WORKSPACE } from '../fixtures/postService'

describe('Post Service change requests and delivered corrections', () => {
    const h = usePostServiceHarness()
    for (const decision of ['approved', 'rejected'] as const) it(`COD request ${decision} blocks delivery until review and creates no payment`, async () => {
        const shipment = await h.shipment({}, true)
        await db.agents.update(POST_COURIER, { linkedUserId: 'courier-user' })
        const request = await h.service.requestDeliveryShipmentCodAdjustment(POST_WORKSPACE, { shipmentId: shipment.id,
            requesterUserId: 'courier-user', requesterAgentId: POST_COURIER, requestedCodAmount: 125.5, reason: 'Correction' })
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered' })).rejects.toThrow('pending')
        await expect(h.service.requestDeliveryShipmentCodAdjustment(POST_WORKSPACE, { shipmentId: shipment.id,
            requesterUserId: 'courier-user', requesterAgentId: POST_COURIER, requestedCodAmount: 130, reason: '' })).rejects.toThrow('pending')
        await h.service.reviewDeliveryShipmentCodAdjustment(request.id, { reviewerUserId: POST_ADMIN, decision, approvedCodAmount: decision === 'approved' ? 120.25 : null })
        expect(await db.delivery_shipment_cod_adjustment_requests.get(request.id)).toMatchObject({ status: decision, reviewedBy: POST_ADMIN })
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ codAmount: decision === 'approved' ? 120.25 : 100 })
        expect(await db.payment_transactions.count()).toBe(0)
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered' })
    })
    for (const currency of POST_CURRENCIES) for (const correctedCodAmount of [75.25, 125.75]) it(`${currency} delivered COD=${correctedCodAmount} records two signed deltas once`, async () => {
        const shipment = await h.delivered({ currency })
        const input = { operationId: crypto.randomUUID(), shipmentId: shipment.id, expectedVersion: shipment.version,
            actorRole: 'admin' as const, actorUserId: POST_ADMIN, correctedCodAmount }
        const corrected = await h.service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, input)
        expect(corrected.codAmount).toBe(correctedCodAmount)
        expect(await h.service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, input)).toEqual(corrected)
        expect(await db.delivery_shipment_cod_corrections.count()).toBe(1)
        const rows = (await db.delivery_ledger_entries.where('shipmentId').equals(shipment.id).toArray()).filter(row => row.codCorrectionId === input.operationId)
        expect(rows).toHaveLength(2)
        for (const row of rows) expect(row.amount).toBe(correctedCodAmount - 100)
        await expect(h.service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { ...input, correctedCodAmount: 150 })).rejects.toThrow('reused')
        expect(await db.payment_transactions.count()).toBe(0)
    })
    for (const correctedRecipientPayoutAmount of [0, 12.25, 40.75]) it(`delivered prepaid payout=${correctedRecipientPayoutAmount} records signed advance and debt corrections`, async () => {
        const shipment = await h.delivered({ customerPaymentStatus: 'prepaid_electronically', recipientPayoutAmount: 20 })
        const input = { operationId: crypto.randomUUID(), shipmentId: shipment.id, expectedVersion: shipment.version,
            actorRole: 'admin' as const, actorUserId: POST_ADMIN, correctedRecipientPayoutAmount }
        await h.service.correctDeliveredDeliveryShipmentRecipientPayout(POST_WORKSPACE, input)
        await h.service.correctDeliveredDeliveryShipmentRecipientPayout(POST_WORKSPACE, input)
        const rows = (await db.delivery_ledger_entries.where('shipmentId').equals(shipment.id).toArray()).filter(row => row.recipientPayoutCorrectionId === input.operationId)
        expect(rows).toHaveLength(2)
        for (const row of rows) expect(row.amount).toBe(20 - correctedRecipientPayoutAmount)
        expect(await db.payment_transactions.count()).toBe(0)
    })
    it('blocks delivered corrections after a partial settlement', async () => {
        const shipment = await h.delivered()
        await h.service.settleDeliveryCourier(POST_WORKSPACE, { agentId: POST_COURIER, shipmentId: shipment.id,
            currency: 'usd', actualAmount: 10, paymentMethod: 'cash', varianceNote: 'Partial' })
        await expect(h.service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { operationId: crypto.randomUUID(), shipmentId: shipment.id,
            expectedVersion: shipment.version, actorRole: 'admin', actorUserId: POST_ADMIN, correctedCodAmount: 125 })).rejects.toThrow('outstanding')
        expect(await db.delivery_shipment_cod_corrections.count()).toBe(0)
    })
})
