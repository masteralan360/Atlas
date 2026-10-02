import { expect } from 'vitest'
import { db } from '@/local-db/database'
import { getLedgerPaymentTransactionEffect, getLedgerPaymentTransactions } from '@/lib/ledgerPaymentTransactions'

export async function assertOrderFinancialEffects(orderId: string, expectedPaid: number, expectedBalance: number) {
    const order = await db.sales_orders.get(orderId)
    expect(order, 'saved order must survive a database read').toBeDefined()
    expect(order?.paidAmount, 'order paid amount').toBeCloseTo(expectedPaid, 3)
    expect(order?.balanceAmount, 'order outstanding amount').toBeCloseTo(expectedBalance, 3)
    const payments = await db.payment_transactions.where('sourceRecordId').equals(orderId).toArray()
    const ledger = getLedgerPaymentTransactions(payments)
    expect(ledger.length, 'every payment and counter-entry must remain visible').toBe(payments.length)
    const ledgerNet = ledger.reduce((sum, transaction) => {
        const effect = getLedgerPaymentTransactionEffect(transaction)
        return sum + (effect.direction === 'incoming' ? effect.amount : -effect.amount)
    }, 0)
    expect(ledgerNet, 'ledger must agree with the expected payment amount').toBeCloseTo(expectedPaid, 3)
    for (const reversal of payments.filter((payment) => payment.reversalOfTransactionId)) {
        expect(payments.some((payment) => payment.id === reversal.reversalOfTransactionId), 'reversal must link to its original payment').toBe(true)
        expect(reversal.amount, 'counter-entry must reverse a signed portion').toBeLessThan(0)
    }
    return payments
}

export async function assertStock(productId: string, storageId: string, quantity: number) {
    const inventory = await db.inventory.where('[productId+storageId]').equals([productId, storageId]).first()
    expect(inventory?.quantity, 'expected stock after order action').toBeCloseTo(quantity, 3)
}
