import { expect } from 'vitest'
import { db } from '@/local-db/database'
import type { DeliveryShipment, DeliverySettlement } from '@/local-db/models'
import { getLedgerPaymentTransactions, getLedgerPaymentTransactionEffect } from '@/lib/ledgerPaymentTransactions'
import { POST_COURIER, POST_COURIER_PARTNER, POST_MERCHANT, POST_WORKSPACE, postUnrelatedBaseline } from '../fixtures/postService'

export async function postPayments() {
    return (await db.payment_transactions.where('workspaceId').equals(POST_WORKSPACE).toArray())
        .filter(row => row.sourceModule === 'post_service' && !row.isDeleted)
}

export async function assertPostDelivery(shipment: DeliveryShipment) {
    const rows = (await db.delivery_ledger_entries.where('shipmentId').equals(shipment.id).toArray()).filter(row => !row.isDeleted)
    const expected = new Map<string, number>([
        ['courier_collection', shipment.codAmount + (shipment.feePayer === 'recipient' ? shipment.deliveryFee : 0)],
        ['courier_delivery_fee', -(shipment.courierDeliveryFee ?? 0)],
        ['courier_recipient_advance', shipment.recipientPayoutFunding === 'courier_advance' ? -shipment.recipientPayoutAmount : 0],
        ['merchant_cod_payable', shipment.codAmount],
        ['merchant_fee', shipment.feePayer === 'merchant' ? -shipment.deliveryFee : 0],
        ['merchant_recipient_payout', -shipment.recipientPayoutAmount]
    ].filter(([, amount]) => amount !== 0) as [string, number][])
    expect(rows).toHaveLength(expected.size)
    for (const row of rows) {
        expect(row.amount, row.kind).toBeCloseTo(expected.get(row.kind)!, 6)
        expect(row).toMatchObject({ workspaceId: POST_WORKSPACE, currency: shipment.currency, settlementId: null })
        expect(row.agentId).toBe(row.kind.startsWith('courier_') ? POST_COURIER : null)
        expect(row.merchantProfileId).toBe(row.kind.startsWith('merchant_') ? shipment.merchantProfileId : null)
    }
    const payments = await postPayments()
    const workspacePaid = shipment.recipientPayoutFunding === 'workspace_payment' && shipment.recipientPayoutAmount > 0
    expect(payments).toHaveLength(workspacePaid ? 1 : 0)
    if (workspacePaid) {
        expect(payments[0]).toMatchObject({ id: shipment.recipientPayoutPaymentTransactionId,
            direction: 'outgoing', amount: shipment.recipientPayoutAmount, sourceRecordId: shipment.id })
        expect(getLedgerPaymentTransactions(payments)).toHaveLength(1)
    }
}

export async function assertPostSettlement(settlement: DeliverySettlement, direction: 'incoming' | 'outgoing', accountId: string | null = null) {
    const payments = await db.payment_transactions.where('sourceRecordId').equals(settlement.id).toArray()
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ id: settlement.paymentTransactionId, sourceModule: 'post_service',
        sourceType: `delivery_${settlement.type}`, direction, amount: settlement.actualAmount,
        currency: settlement.currency, paymentMethod: settlement.paymentMethod, accountId, isDeleted: false })
    const ledger = getLedgerPaymentTransactions(payments)
    expect(ledger).toHaveLength(1)
    expect(getLedgerPaymentTransactionEffect(ledger[0])).toMatchObject({ direction, amount: settlement.actualAmount })
    const deliveryLedger = await db.delivery_ledger_entries.where('settlementId').equals(settlement.id).toArray()
    expect(deliveryLedger.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(
        ['courier_remittance', 'merchant_payout'].includes(settlement.type) ? -settlement.actualAmount : settlement.actualAmount, 6)
    const movements = await db.payment_account_movements.where('paymentTransactionId').equals(payments[0].id).toArray()
    expect(movements).toHaveLength(accountId ? 1 : 0)
    return payments[0]
}

export async function assertPostPartyBalances(courier: number, merchant: number) {
    expect(await db.business_partners.get(POST_COURIER_PARTNER)).toMatchObject({
        receivableBalance: Math.max(courier, 0), payableBalance: Math.max(-courier, 0) })
    expect(await db.business_partners.get(POST_MERCHANT)).toMatchObject({
        receivableBalance: Math.max(-merchant, 0), payableBalance: Math.max(merchant, 0) })
}

export async function assertUnrelatedPostDataUntouched() {
    expect(postUnrelatedBaseline()).toBeDefined()
    expect(await db.business_partners.get('unrelated-partner')).toEqual(postUnrelatedBaseline())
    for (const table of [db.sales, db.sale_items, db.sales_orders, db.inventory, db.stock_batches, db.loans, db.offline_mutations]) {
        expect(await table.count(), table.name).toBe(0)
    }
}
