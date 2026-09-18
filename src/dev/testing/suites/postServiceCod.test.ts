import 'fake-indexeddb/auto'
import { describe, it } from 'vitest'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_CURRENCIES } from '../fixtures/postService'
import { assertPostDelivery, assertPostPartyBalances, assertUnrelatedPostDataUntouched } from '../assertions/postService'

describe('Post Service COD obligation matrix', () => {
    const h = usePostServiceHarness()
    for (const currency of POST_CURRENCIES) for (const feePayer of ['merchant', 'recipient'] as const)
        for (const recipientPayoutFunding of ['courier_advance', 'workspace_payment'] as const)
            for (const recipientPayoutAmount of [0, 20.25]) it(`${currency} fee=${feePayer} funding=${recipientPayoutFunding} payout=${recipientPayoutAmount}`, async () => {
                const shipment = await h.delivered({ currency, feePayer, recipientPayoutFunding, recipientPayoutAmount, codAmount: 125.75, deliveryFee: 10.25 })
                await assertPostDelivery(shipment)
                await assertPostPartyBalances(125.75 + (feePayer === 'recipient' ? 10.25 : 0) - 5
                    - (recipientPayoutFunding === 'courier_advance' ? recipientPayoutAmount : 0),
                    125.75 - (feePayer === 'merchant' ? 10.25 : 0) - recipientPayoutAmount)
                await assertUnrelatedPostDataUntouched()
            })
})
