import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_COURIER, POST_SECOND_COURIER } from '../fixtures/postService'

describe('Post Service status lifecycle and reasons', () => {
    const h = usePostServiceHarness()
    for (const status of ['delivered', 'postponed', 'returned'] as const) it(`requires assignment for ${status}`, async () => {
        const shipment = await h.shipment()
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status })).rejects.toThrow('Assign')
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
    })
    for (const status of ['delivered', 'postponed', 'returned', 'cancelled'] as const) it(`records an assigned → ${status} audit event and prevents wrong-courier updates`, async () => {
        const shipment = await h.shipment({}, true)
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status, note: 'Reason', actorAgentId: POST_SECOND_COURIER })).rejects.toThrow()
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status, note: ' Reason ', actorAgentId: POST_COURIER })
        expect(await db.delivery_shipments.get(shipment.id)).toMatchObject({ status, version: 3, statusNote: 'Reason' })
        expect(await db.delivery_shipment_events.where('shipmentId').equals(shipment.id).toArray()).toEqual(expect.arrayContaining([
            expect.objectContaining({ previousStatus: 'assigned', status, actorAgentId: POST_COURIER, note: 'Reason' })]))
        if (status !== 'delivered') {
            expect(await db.delivery_ledger_entries.count()).toBe(0)
            expect(await db.payment_transactions.count()).toBe(0)
        }
        if (status !== 'postponed') await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status, note: 'Reason' })).rejects.toThrow('completed')
    })
    it('requires a written cancellation reason', async () => {
        const shipment = await h.shipment()
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'cancelled', note: ' ' })).rejects.toThrow()
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'cancelled', note: 'Cancelled by merchant' })
        expect(await db.payment_transactions.count()).toBe(0)
    })
    for (const duration of [0, -1, 1.5, 1800001, NaN]) it(`rejects voice duration ${duration} before changing state`, async () => {
        const shipment = await h.shipment({}, true)
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'returned', voiceReasonPath: 'test.flac', voiceReasonDurationMs: duration })).rejects.toThrow()
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
    })
    for (const status of ['postponed', 'returned'] as const) for (const duration of [1, 1800000]) it(`accepts voice-only ${status} reason at duration boundary ${duration}`, async () => {
        const shipment = await h.shipment({}, true)
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status, voiceReasonPath: 'test.flac', voiceReasonDurationMs: duration })
        expect(await db.delivery_shipment_events.where('shipmentId').equals(shipment.id).toArray()).toEqual(expect.arrayContaining([
            expect.objectContaining({ status, voiceReasonPath: 'test.flac', voiceReasonDurationMs: duration, note: null })]))
        expect(await db.payment_transactions.count()).toBe(0)
    })
})
