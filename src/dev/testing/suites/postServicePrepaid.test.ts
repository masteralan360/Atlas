import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_CURRENCIES, POST_COURIER, POST_METHODS, POST_WORKSPACE, fundedPostAccount } from '../fixtures/postService'
import { assertPostDelivery, assertPostPartyBalances, assertPostSettlement, postPayments } from '../assertions/postService'

describe('Post Service prepaid obligations and reimbursements', () => {
    const h = usePostServiceHarness()
    for (const currency of POST_CURRENCIES) for (const feePayer of ['merchant', 'recipient'] as const)
        for (const recipientPayoutFunding of ['courier_advance', 'workspace_payment'] as const)
            for (const recipientPayoutAmount of [0, 20.25]) it(`${currency} fee=${feePayer} funding=${recipientPayoutFunding} payout=${recipientPayoutAmount}`, async () => {
                const shipment = await h.delivered({ currency, customerPaymentStatus: 'prepaid_electronically', feePayer, recipientPayoutFunding,
                    recipientPayoutAmount, codAmount: 999, deliveryFee: 10.25 })
                expect(shipment.codAmount).toBe(0)
                await assertPostDelivery(shipment)
                await assertPostPartyBalances((feePayer === 'recipient' ? 10.25 : 0) - 5
                    - (recipientPayoutFunding === 'courier_advance' ? recipientPayoutAmount : 0),
                    -(feePayer === 'merchant' ? 10.25 : 0) - recipientPayoutAmount)
            })
    it('settles courier advance and merchant repayment through separate real payments', async () => {
        const shipment = await h.delivered({ customerPaymentStatus: 'prepaid_electronically', recipientPayoutAmount: 20 })
        const courier = await h.service.payDeliveryCourierReimbursement(POST_WORKSPACE, { agentId: POST_COURIER, shipmentId: shipment.id,
            currency: 'usd', actualAmount: 25, paymentMethod: 'cash' })
        const merchant = await h.service.receiveDeliveryMerchantRepayment(POST_WORKSPACE, { merchantProfileId: shipment.merchantProfileId,
            shipmentId: shipment.id, currency: 'usd', actualAmount: 30, paymentMethod: 'bank_transfer' })
        await assertPostSettlement(courier, 'outgoing'); await assertPostSettlement(merchant, 'incoming')
        await assertPostPartyBalances(0, 0)
        expect(await db.payment_transactions.count()).toBe(2)
    })
    it('pays an uncovered courier fee without inventing COD custody', async () => {
        const shipment = await h.delivered({ customerPaymentStatus: 'prepaid_electronically', deliveryFee: 0 })
        const settlement = await h.service.payDeliveryCourierFee(POST_WORKSPACE, { agentId: POST_COURIER, shipmentId: shipment.id,
            currency: 'usd', actualAmount: 5, paymentMethod: 'cash' })
        await assertPostSettlement(settlement, 'outgoing')
        await assertPostPartyBalances(0, 0)
    })
    for (const currency of POST_CURRENCIES) for (const method of POST_METHODS) for (const selected of [false, true]) it(`workspace recipient payout ${currency} ${method} account=${selected} posts its own payment and optional movement`, async () => {
        const account = selected ? await fundedPostAccount(currency, 50) : null
        const shipment = await h.shipment({ currency, customerPaymentStatus: 'prepaid_electronically', recipientPayoutAmount: 20.25,
            recipientPayoutFunding: 'workspace_payment' }, true)
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered', recipientPayoutPaymentMethod: method,
            recipientPayoutAccountId: account?.id, recipientPayoutAccountNameSnapshot: account?.name })
        const saved = (await db.delivery_shipments.get(shipment.id))!
        await assertPostDelivery(saved)
        const [payment] = await postPayments()
        expect(payment).toMatchObject({ sourceType: 'delivery_recipient_payout', direction: 'outgoing', amount: 20.25,
            paymentMethod: method, currency, accountId: account?.id ?? null, accountNameSnapshot: account?.name ?? null })
        expect(await db.payment_account_movements.where('paymentTransactionId').equals(payment.id).count()).toBe(selected ? 1 : 0)
        if (account) expect((await db.payment_account_balances.where('[accountId+currency]').equals([account.id, currency]).first())?.balanceAmount).toBe(29.75)
    })
})
