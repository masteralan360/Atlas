import type { PaymentTransaction } from '@/local-db/models'

export function formatDirectTransactionVoucherNumber(transaction: Pick<PaymentTransaction, 'id' | 'voucherNumber'>) {
  return transaction.voucherNumber && transaction.voucherNumber > 0
    ? `DT-${String(transaction.voucherNumber).padStart(6, '0')}`
    : transaction.id
}

/** Called inside the local payment-transactions write transaction. */
export function nextDirectTransactionVoucherNumber(rows: Pick<PaymentTransaction, 'sourceType' | 'voucherNumber'>[]) {
  return rows.reduce((highest, row) => row.sourceType === 'direct_transaction'
    ? Math.max(highest, Number(row.voucherNumber) || 0)
    : highest, 0) + 1
}
