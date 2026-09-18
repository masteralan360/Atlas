import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_CURRENCIES, POST_OTHER_WORKSPACE, POST_TIME, POST_WORKSPACE, postInput } from '../fixtures/postService'

describe('Post Service shipment creation', () => {
    const h = usePostServiceHarness()
    for (const currency of POST_CURRENCIES) for (const prepaid of [false, true]) it(`${currency} ${prepaid ? 'prepaid' : 'COD'} keeps decimal amounts and creates only a received event`, async () => {
        const shipment = await h.shipment({ currency, codAmount: 125.75, customerPaymentStatus: prepaid ? 'prepaid_electronically' : 'cash_on_delivery',
            deliveryFee: 0, recipientPayoutAmount: 12.25, recipientPhone: ' 07500000000 ', recipientAddress: ' Address ', sourceSalesOrderId: 'source-order' })
        expect(shipment).toMatchObject({ codAmount: prepaid ? 0 : 125.75, deliveryFee: 0, recipientPayoutAmount: 12.25,
            recipientPhone: '07500000000', recipientAddress: 'Address', sourceSalesOrderId: 'source-order',
            recipientPayoutFunding: 'courier_advance', status: 'received', version: 1, assignedAgentId: null })
        expect(await db.delivery_shipment_events.where('shipmentId').equals(shipment.id).toArray()).toEqual([
            expect.objectContaining({ previousStatus: null, status: 'received' })])
        expect(await db.delivery_ledger_entries.count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(0)
    })
    for (const field of ['codAmount', 'deliveryFee', 'recipientPayoutAmount'] as const) for (const value of [-1, NaN, Infinity]) it(`rejects ${field}=${value} without shipment or event`, async () => {
        await expect(h.shipment({ [field]: value })).rejects.toThrow()
        expect(await db.delivery_shipments.count()).toBe(0)
        expect(await db.delivery_shipment_events.count()).toBe(0)
    })
    it('rejects zero COD, blank recipient fields and inactive/foreign profiles', async () => {
        const profile = await h.profile()
        for (const overrides of [{ codAmount: 0 }, { recipientPhone: ' ' }, { recipientAddress: '' }]) {
            await expect(h.service.createDeliveryShipment(POST_WORKSPACE, postInput(profile.id, overrides))).rejects.toThrow()
        }
        await expect(h.service.createDeliveryShipment(POST_OTHER_WORKSPACE, postInput(profile.id))).rejects.toThrow()
        await db.delivery_merchant_profiles.update(profile.id, { isActive: false })
        await expect(h.shipment()).rejects.toThrow()
        expect(await db.delivery_shipments.count()).toBe(0)
    })
    it('inherits merchant defaults when fees are omitted', async () => {
        const profile = await h.profile()
        const input = postInput(profile.id); delete input.deliveryFee; delete input.feePayer
        expect(await h.service.createDeliveryShipment(POST_WORKSPACE, input)).toMatchObject({ deliveryFee: 10, feePayer: 'merchant' })
    })
    it('numbers posts by Baghdad calendar day, including midnight rollover', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(POST_TIME))
        expect((await h.shipment()).trackingNumber).toBe('PST-20260918-00001')
        expect((await h.shipment()).trackingNumber).toBe('PST-20260918-00002')
        vi.setSystemTime(new Date('2026-09-18T21:00:00Z'))
        expect((await h.shipment()).trackingNumber).toBe('PST-20260919-00001')
    })
})
