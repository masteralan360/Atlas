import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from '@/local-db/database'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_ADMIN, POST_COURIER, POST_CURRENCIES, POST_METHODS, POST_WORKSPACE, fundedPostAccount, seededPostCases } from '../fixtures/postService'
import { assertPostDelivery, assertPostPartyBalances, assertPostSettlement, assertUnrelatedPostDataUntouched, postPayments } from '../assertions/postService'

describe('Post Service settlement payment matrices and generated lifecycles', () => {
    const h = usePostServiceHarness()
    for (const currency of POST_CURRENCIES) for (const paymentMethod of POST_METHODS) for (const selected of [false, true])
        for (const prepaid of [false, true]) it(`${currency} ${paymentMethod} account=${selected} ${prepaid ? 'repayment/reimbursement' : 'remittance/payout'}`, async () => {
            const account = selected ? await fundedPostAccount(currency) : null
            const shipment = await h.delivered({ currency, customerPaymentStatus: prepaid ? 'prepaid_electronically' : 'cash_on_delivery', recipientPayoutAmount: prepaid ? 20 : 0 })
            const common = { currency, paymentMethod, shipmentId: shipment.id, accountId: account?.id ?? null, accountNameSnapshot: account?.name ?? null }
            const courier = prepaid
                ? await h.service.payDeliveryCourierReimbursement(POST_WORKSPACE, { ...common, agentId: POST_COURIER, actualAmount: 25 })
                : await h.service.settleDeliveryCourier(POST_WORKSPACE, { ...common, agentId: POST_COURIER, actualAmount: 95 })
            const merchant = prepaid
                ? await h.service.receiveDeliveryMerchantRepayment(POST_WORKSPACE, { ...common, merchantProfileId: shipment.merchantProfileId, actualAmount: 30 })
                : await h.service.payDeliveryMerchant(POST_WORKSPACE, { ...common, merchantProfileId: shipment.merchantProfileId, actualAmount: 90 })
            await assertPostSettlement(courier, prepaid ? 'outgoing' : 'incoming', account?.id)
            await assertPostSettlement(merchant, prepaid ? 'incoming' : 'outgoing', account?.id)
            await assertPostPartyBalances(0, 0)
            if (account) {
                expect((await db.payment_account_balances.where('[accountId+currency]').equals([account.id, currency]).first())?.balanceAmount).toBe(10005)
            } else expect(await db.payment_account_movements.count()).toBe(0)
            expect(await postPayments()).toHaveLength(2)
            await assertUnrelatedPostDataUntouched()
        })
    for (const paymentMethod of POST_METHODS) for (const selected of [false, true]) it(`uncovered courier fee ${paymentMethod} account=${selected}`, async () => {
        const account = selected ? await fundedPostAccount('usd') : null
        const shipment = await h.delivered({ customerPaymentStatus: 'prepaid_electronically', deliveryFee: 0 })
        const settlement = await h.service.payDeliveryCourierFee(POST_WORKSPACE, { agentId: POST_COURIER, shipmentId: shipment.id,
            currency: 'usd', actualAmount: 5, paymentMethod, accountId: account?.id, accountNameSnapshot: account?.name })
        await assertPostSettlement(settlement, 'outgoing', account?.id)
        if (account) expect((await db.payment_account_balances.where('[accountId+currency]').equals([account.id, 'usd']).first())?.balanceAmount).toBe(9995)
    })
    for (const actualAmount of [0, -1, NaN, Infinity, 95.01]) it(`invalid remittance=${actualAmount} creates no settlement/payment/clearing line`, async () => {
        const shipment = await h.delivered()
        await expect(h.service.settleDeliveryCourier(POST_WORKSPACE, { agentId: POST_COURIER, currency: 'usd',
            shipmentId: shipment.id, actualAmount, paymentMethod: 'cash' })).rejects.toThrow()
        expect(await db.delivery_settlements.count()).toBe(0)
        expect(await postPayments()).toHaveLength(0)
        expect(await db.delivery_ledger_entries.count()).toBe(4)
    })
    it('requires an explanation for a partial settlement and clears only the exact remaining amount', async () => {
        const shipment = await h.delivered()
        const input = { agentId: POST_COURIER, shipmentId: shipment.id, currency: 'usd' as const, actualAmount: 40.25, paymentMethod: 'cash' as const }
        await expect(h.service.settleDeliveryCourier(POST_WORKSPACE, input)).rejects.toThrow('Explain')
        const partial = await h.service.settleDeliveryCourier(POST_WORKSPACE, { ...input, varianceNote: 'Partial handover' })
        expect(partial).toMatchObject({ expectedAmount: 95, actualAmount: 40.25, varianceAmount: -54.75 })
        await assertPostSettlement(partial, 'incoming')
        const final = await h.service.settleDeliveryCourier(POST_WORKSPACE, { ...input, actualAmount: 54.75 })
        await assertPostSettlement(final, 'incoming')
        await expect(h.service.settleDeliveryCourier(POST_WORKSPACE, { ...input, actualAmount: 1 })).rejects.toThrow('outstanding')
    })
    it('collective merchant payout makes one payment with FIFO allocations to both posts', async () => {
        const a = await h.delivered(), b = await h.delivered()
        // Stable timestamps remove scheduling and UUID tie ambiguity from the FIFO assertion.
        await db.delivery_ledger_entries.where('shipmentId').equals(a.id).modify({ occurredAt: '2026-09-18T08:00:00Z' })
        await db.delivery_ledger_entries.where('shipmentId').equals(b.id).modify({ occurredAt: '2026-09-18T09:00:00Z' })
        const settlement = await h.service.payDeliveryMerchant(POST_WORKSPACE, { merchantProfileId: a.merchantProfileId,
            currency: 'usd', actualAmount: 120, paymentMethod: 'cash', varianceNote: 'Partial collective payout' })
        await assertPostSettlement(settlement, 'outgoing')
        const lines = await db.delivery_ledger_entries.where('settlementId').equals(settlement.id).toArray()
        expect(lines).toHaveLength(2)
        expect(lines).toEqual(expect.arrayContaining([
            expect.objectContaining({ shipmentId: a.id, amount: -90 }), expect.objectContaining({ shipmentId: b.id, amount: -30 })]))
    })
    it('collective settlement keeps the outstanding amount isolated by currency for the same courier', async () => {
        await h.delivered({ currency: 'usd' })
        await h.delivered({ currency: 'iqd' })
        const settlement = await h.service.settleDeliveryCourier(POST_WORKSPACE, { agentId: POST_COURIER, currency: 'usd',
            actualAmount: 95, paymentMethod: 'cash', varianceNote: 'Currency isolation regression' })
        const iqd = (await db.delivery_ledger_entries.toArray()).filter(row => row.agentId === POST_COURIER && row.currency === 'iqd')
        expect({ expectedUsd: settlement.expectedAmount, remainingIqd: iqd.reduce((sum, row) => sum + row.amount, 0) },
            'A USD settlement must include only USD obligations and leave IQD unchanged').toEqual({ expectedUsd: 95, remainingIqd: 95 })
    })

    const seed = Number(process.env.ATLAS_TEST_SEED ?? 20260918)
    const samples = Number(process.env.ATLAS_TEST_SAMPLES ?? 16)
    for (const scenario of seededPostCases(seed, samples)) it(`seed=${seed} case=${scenario.index} ${JSON.stringify(scenario)}`, async () => {
        const currency = scenario.currency, paymentMethod = scenario.method
        const account = scenario.account ? await fundedPostAccount(currency) : null
        let shipment = await h.shipment({ currency, codAmount: scenario.cod, deliveryFee: scenario.fee,
            feePayer: scenario.recipientFee ? 'recipient' : 'merchant',
            customerPaymentStatus: scenario.prepaid ? 'prepaid_electronically' : 'cash_on_delivery',
            recipientPayoutAmount: scenario.payout, recipientPayoutFunding: scenario.workspaceFunded ? 'workspace_payment' : 'courier_advance' })
        await h.service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id], courierDeliveryFee: scenario.courierFee })
        if (scenario.redispatch) {
            await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'postponed' })
            await h.service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id], courierDeliveryFee: scenario.courierFee })
        }
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered', recipientPayoutPaymentMethod: paymentMethod,
            recipientPayoutAccountId: account?.id, recipientPayoutAccountNameSnapshot: account?.name })
        shipment = (await db.delivery_shipments.get(shipment.id))!
        await assertPostDelivery(shipment)
        if (scenario.correct && !scenario.prepaid) {
            shipment = await h.service.correctDeliveredDeliveryShipmentCod(POST_WORKSPACE, { shipmentId: shipment.id, operationId: crypto.randomUUID(),
                expectedVersion: shipment.version, actorRole: 'admin', actorUserId: POST_ADMIN, correctedCodAmount: shipment.codAmount + 1.25 })
        }
        const courierAmount = shipment.codAmount + (scenario.recipientFee ? scenario.fee : 0) - scenario.courierFee
            - (scenario.workspaceFunded ? 0 : scenario.payout)
        const merchantAmount = shipment.codAmount - (scenario.recipientFee ? 0 : scenario.fee) - scenario.payout
        const common = { currency, paymentMethod, shipmentId: scenario.collective ? null : shipment.id, accountId: account?.id, accountNameSnapshot: account?.name }
        const settle = async (party: 'courier' | 'merchant', balance: number) => {
            if (Math.abs(balance) <= 0.000001) return
            const amount = Math.abs(balance)
            const pay = async (actualAmount: number, partial = false) => {
                const options = { ...common, actualAmount, varianceNote: partial ? 'Generated partial settlement' : null }
                const settlement = party === 'courier'
                    ? balance > 0 ? await h.service.settleDeliveryCourier(POST_WORKSPACE, { ...options, agentId: POST_COURIER })
                        : await h.service.payDeliveryCourierReimbursement(POST_WORKSPACE, { ...options, agentId: POST_COURIER })
                    : balance > 0 ? await h.service.payDeliveryMerchant(POST_WORKSPACE, { ...options, merchantProfileId: shipment.merchantProfileId })
                        : await h.service.receiveDeliveryMerchantRepayment(POST_WORKSPACE, { ...options, merchantProfileId: shipment.merchantProfileId })
                await assertPostSettlement(settlement, (party === 'courier') === (balance > 0) ? 'incoming' : 'outgoing', account?.id)
            }
            if (scenario.partial) { await pay(amount / 2, true); await pay(amount / 2) } else await pay(amount)
        }
        await settle('courier', courierAmount); await settle('merchant', merchantAmount)
        const rows = await db.delivery_ledger_entries.where('shipmentId').equals(shipment.id).toArray()
        // Collective courier remittance is intentionally party-level; include its allocation through party totals.
        const allRows = await db.delivery_ledger_entries.where('workspaceId').equals(POST_WORKSPACE).toArray()
        expect(allRows.filter(row => row.agentId === POST_COURIER).reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(0, 6)
        expect(rows.filter(row => row.merchantProfileId === shipment.merchantProfileId).reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(0, 6)
        if (account) expect((await db.payment_account_balances.where('[accountId+currency]').equals([account.id, currency]).first())?.balanceAmount)
            .toBeCloseTo(10000 + scenario.fee - scenario.courierFee, 6)
        await assertUnrelatedPostDataUntouched()
    })
})
