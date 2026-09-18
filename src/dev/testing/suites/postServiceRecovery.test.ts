import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@/local-db/database'
import { getLedgerPaymentTransactions, getLedgerPaymentTransactionEffect } from '@/lib/ledgerPaymentTransactions'
import { usePostServiceHarness } from '../fixtures/postServiceHarness'
import { POST_COURIER, POST_WORKSPACE, fundedPostAccount, postInput } from '../fixtures/postService'
import { assertPostSettlement, postPayments } from '../assertions/postService'

describe('Post Service injected failures and recovery', () => {
    const h = usePostServiceHarness()
    it('rolls back shipment creation when its receive event cannot be written', async () => {
        vi.spyOn(db.delivery_shipment_events, 'put').mockRejectedValueOnce(new Error('Injected event failure'))
        await expect(h.shipment()).rejects.toThrow('Injected')
        expect(await db.delivery_shipments.count()).toBe(0)
        expect(await db.delivery_shipment_events.count()).toBe(0)
    })
    it('rolls back assignment when manifest items cannot be written', async () => {
        const shipment = await h.shipment()
        vi.spyOn(db.delivery_run_items, 'bulkPut').mockRejectedValueOnce(new Error('Injected manifest failure'))
        await expect(h.service.createDeliveryRun(POST_WORKSPACE, { agentId: POST_COURIER, shipmentIds: [shipment.id] })).rejects.toThrow('Injected')
        expect(await db.delivery_runs.count()).toBe(0)
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
    })
    it('rolls back courier-funded delivery when obligation writes fail, then retries without duplication', async () => {
        const shipment = await h.shipment({ recipientPayoutAmount: 20 }, true)
        vi.spyOn(db.delivery_ledger_entries, 'bulkPut').mockRejectedValueOnce(new Error('Injected ledger failure'))
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered' })).rejects.toThrow('Injected')
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
        expect(await db.delivery_ledger_entries.count()).toBe(0)
        expect(await db.payment_transactions.count()).toBe(0)
        await h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered' })
        expect(await db.delivery_ledger_entries.count()).toBe(6)
    })
    it('a failed workspace-funded delivery must not leave a recipient payment or account debit', async () => {
        const account = await fundedPostAccount('usd', 50)
        const shipment = await h.shipment({ recipientPayoutAmount: 20, recipientPayoutFunding: 'workspace_payment' }, true)
        vi.spyOn(db.delivery_ledger_entries, 'bulkPut').mockRejectedValueOnce(new Error('Injected ledger failure'))
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered', recipientPayoutAccountId: account.id,
            recipientPayoutAccountNameSnapshot: account.name })).rejects.toThrow('Injected')
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
        expect(await db.delivery_ledger_entries.count()).toBe(0)
        const payments = await postPayments()
        const balance = (await db.payment_account_balances.where('[accountId+currency]').equals([account.id, 'usd']).first())?.balanceAmount
        expect({ recipientPayments: payments.length, accountBalance: balance },
            'An uncommitted delivery must leave neither a payment nor an account debit').toEqual({ recipientPayments: 0, accountBalance: 50 })
    })
    it('rejects insufficient recipient payout funding before changing delivery state', async () => {
        const account = await fundedPostAccount('usd', 10)
        const shipment = await h.shipment({ recipientPayoutAmount: 20, recipientPayoutFunding: 'workspace_payment' }, true)
        await expect(h.service.updateDeliveryShipmentStatus(shipment.id, { status: 'delivered', recipientPayoutAccountId: account.id })).rejects.toThrow()
        expect(await db.delivery_shipments.get(shipment.id)).toEqual(shipment)
        expect(await postPayments()).toHaveLength(0)
    })
    it('compensates a settlement payment when delivery clearing records fail and permits a clean retry', async () => {
        const account = await fundedPostAccount('usd', 50)
        const shipment = await h.delivered()
        const input = { merchantProfileId: shipment.merchantProfileId, shipmentId: shipment.id, currency: 'usd' as const,
            actualAmount: 90, paymentMethod: 'cash' as const, accountId: account.id, accountNameSnapshot: account.name }
        // Fund the outgoing payment independently of its merchant obligation.
        const payments = await import('@/local-db/payments')
        await payments.appendPaymentTransaction(POST_WORKSPACE, { sourceModule: 'post_service', sourceType: 'delivery_courier_remittance',
            sourceRecordId: 'test-funding', direction: 'incoming', amount: 100, currency: 'usd', paymentMethod: 'cash', accountId: account.id,
            paidAt: '2026-09-18T09:00:00.000Z' })
        vi.spyOn(db.delivery_settlements, 'put').mockRejectedValueOnce(new Error('Injected settlement failure'))
        await expect(h.service.payDeliveryMerchant(POST_WORKSPACE, input)).rejects.toThrow('Injected')
        expect(await db.delivery_settlements.count()).toBe(0)
        expect((await db.payment_account_balances.where('[accountId+currency]').equals([account.id, 'usd']).first())?.balanceAmount).toBe(150)
        const ledger = getLedgerPaymentTransactions(await db.payment_transactions.toArray())
        expect(ledger.reduce((sum, row) => { const effect = getLedgerPaymentTransactionEffect(row); return sum + (effect.direction === 'incoming' ? effect.amount : -effect.amount) }, 0)).toBe(150)
        const settlement = await h.service.payDeliveryMerchant(POST_WORKSPACE, input)
        await assertPostSettlement(settlement, 'outgoing', account.id)
    })
    it('resumes the same create-and-dispatch operation after courier validation failure', async () => {
        const profile = await h.profile()
        const input = { operationId: crypto.randomUUID(), shipment: postInput(profile.id), agentId: POST_COURIER }
        await db.agents.update(POST_COURIER, { status: 'inactive' })
        await expect(h.service.createAndDispatchDeliveryShipment(POST_WORKSPACE, input)).rejects.toThrow()
        await db.agents.update(POST_COURIER, { status: 'active' })
        await h.service.createAndDispatchDeliveryShipment(POST_WORKSPACE, input)
        expect(await db.delivery_shipments.count()).toBe(1)
        expect(await db.delivery_run_items.count()).toBe(1)
    })
})
