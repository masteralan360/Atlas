import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { shipmentSettlementNetAmount } from '@/lib/postServiceSettlementNet'
import { getPostponedVoiceReasonCleanupPaths } from '@/lib/deliveryVoiceReasonPaths'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_CURRENCIES, POST_WORKSPACE, seededPostCases } from '../fixtures/postService'

describe('Post Service reporting and deterministic inputs', () => {
    const h = usePostServiceHarness()
    for (const currency of POST_CURRENCIES) it(`${currency} sales projection reports delivery revenue and courier cost, excluding COD and recipient money`, async () => {
        const shipment = await h.delivered({ currency, codAmount: 125.75, deliveryFee: 12.25, recipientPayoutAmount: 20.25 })
        const sale = h.service.toUISaleFromDeliveryShipment(shipment, { serviceName: 'Post test service' })
        expect(sale).toMatchObject({ total_amount: 12.25, settlement_currency: currency, origin: 'post_service', payment_method: null })
        expect(sale.items).toHaveLength(1)
        expect(sale.items[0]).toMatchObject({ quantity: 1, unit_price: 12.25, total_price: 12.25, cost_price: 5 })
        expect(shipmentSettlementNetAmount({ courierHandover: 100.5, courierReimbursement: 0, merchantPayout: 93.25,
            merchantRepayment: 0, hasCourierHandover: true, hasMerchantPayout: true, hasCourierReimbursement: false, hasMerchantRepayment: false })).toBe(7.25)
    })
    for (const seed of [0, 1, 20260918, 4294967295]) it(`seed ${seed} reproduces bounded samples independently`, () => {
        expect(seededPostCases(seed, 100)).toEqual(seededPostCases(seed, 100))
        expect(seededPostCases(seed, 1)).toEqual(seededPostCases(seed, 100).slice(0, 1))
        for (const scenario of seededPostCases(seed, 100)) {
            expect(scenario.cod).toBeGreaterThan(0)
            expect(scenario.cod).toBeLessThan(200)
            expect(scenario.fee).toBeGreaterThan(0)
            expect(scenario.payout).toBeGreaterThan(0)
        }
    })
    it('voice cleanup accepts only scoped postponed FLAC paths and deduplicates them', () => {
        const path = `${POST_WORKSPACE}/post/postponed/recording.flac`
        expect(getPostponedVoiceReasonCleanupPaths({ workspaceId: POST_WORKSPACE, shipmentId: 'post',
            paths: [path, path, 'other/post/postponed/file.flac', `${POST_WORKSPACE}/post/returned/file.flac`, 42, null] })).toEqual([path])
    })
})
