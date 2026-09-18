import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_MERCHANT, POST_OTHER_WORKSPACE, POST_WORKSPACE } from '../fixtures/postService'

describe('Post Service merchant profiles', () => {
    const h = usePostServiceHarness()
    for (const payoutSchedule of ['daily', 'weekly', 'on_request'] as const) it(`creates and edits ${payoutSchedule} defaults without payments`, async () => {
        const profile = await h.service.createDeliveryMerchantProfile(POST_WORKSPACE, {
            businessPartnerId: POST_MERCHANT, defaultFeeAmount: 0, defaultFeePayer: 'recipient', payoutSchedule })
        expect(profile).toMatchObject({ defaultFeeAmount: 0, defaultFeePayer: 'recipient', payoutSchedule, isActive: true })
        const updated = await h.service.updateDeliveryMerchantProfile(profile.id, {
            defaultFeeAmount: 12.75, defaultFeePayer: 'merchant', payoutSchedule, isActive: false, defaultPickupAddress: ' Address ' })
        expect(updated).toMatchObject({ version: 2, defaultFeeAmount: 12.75, defaultPickupAddress: 'Address', isActive: false })
        expect(await db.payment_transactions.count()).toBe(0)
    })
    it('returns an existing active profile instead of duplicating it', async () => {
        const profile = await h.profile()
        expect((await h.profile()).id).toBe(profile.id)
        expect(await db.delivery_merchant_profiles.count()).toBe(1)
    })
    for (const fee of [-1, NaN, Infinity]) it(`rejects default fee ${fee}`, async () => {
        await expect(h.service.createDeliveryMerchantProfile(POST_WORKSPACE, {
            businessPartnerId: POST_MERCHANT, defaultFeeAmount: fee })).rejects.toThrow()
        expect(await db.delivery_merchant_profiles.count()).toBe(0)
    })
    it('rejects missing, deleted and foreign-workspace partners', async () => {
        for (const businessPartnerId of ['missing', 'unrelated-partner']) await expect(
            h.service.createDeliveryMerchantProfile(POST_WORKSPACE, { businessPartnerId })).rejects.toThrow()
        await db.business_partners.update(POST_MERCHANT, { isDeleted: true })
        await expect(h.profile()).rejects.toThrow()
        await expect(h.service.createDeliveryMerchantProfile(POST_OTHER_WORKSPACE, { businessPartnerId: POST_MERCHANT })).rejects.toThrow()
    })
    it('deletes an unused profile but protects historical references', async () => {
        const unused = await h.profile()
        await h.service.hardDeleteDeliveryMerchantProfile(unused.id)
        expect(await db.delivery_merchant_profiles.get(unused.id)).toBeUndefined()
        const shipment = await h.shipment()
        await expect(h.service.hardDeleteDeliveryMerchantProfile(shipment.merchantProfileId)).rejects.toThrow('history')
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
    })
})
