import { expect } from 'vitest'
import { db } from '@/local-db/database'
import { getLedgerPaymentTransactions, getLedgerPaymentTransactionEffect } from '@/lib/ledgerPaymentTransactions'

export async function assertPosPayment(saleId: string, expectedAmount: number) {
    const payments = await db.payment_transactions.where('sourceRecordId').equals(saleId).toArray()
    expect(payments).toHaveLength(expectedAmount === 0 ? 0 : 1)
    const ledger = getLedgerPaymentTransactions(payments)
    expect(ledger).toHaveLength(payments.length)
    expect(ledger.reduce((sum, row) => {
        const effect = getLedgerPaymentTransactionEffect(row)
        return sum + (effect.direction === 'incoming' ? effect.amount : -effect.amount)
    }, 0)).toBeCloseTo(expectedAmount, 3)
    if (payments[0]) expect(payments[0]).toMatchObject({ sourceType: 'pos_sale', direction: 'incoming', sourceRecordId: saleId })
    return payments
}

export async function assertNoPosCommit() {
    for (const table of [db.sales, db.sale_items, db.sales_exchange, db.loans, db.loan_installments,
        db.payment_transactions, db.payment_account_movements, db.payment_account_balances, db.offline_mutations]) {
        expect(await table.count(), `${table.name} must remain empty after rejection`).toBe(0)
    }
}
