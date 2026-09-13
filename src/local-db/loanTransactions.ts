import { db } from './database'
import type {
  Loan,
  LoanInstallment,
  LoanPayment,
  PaymentTransaction,
  PurchaseOrder,
  SalesOrder,
} from './models'
import { mirrorPaymentAccountTransactionLocally } from './paymentAccounts'
import { toCamelCase } from '@/lib/utils'

export type LoanAggregateRpcResult = {
  loan: Loan
  installments: LoanInstallment[]
  payments: LoanPayment[]
  transactions: PaymentTransaction[]
  linkedOrder: SalesOrder | PurchaseOrder | null
}

function camelRow<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return toCamelCase(value as Record<string, unknown>) as T
}

function camelRows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => camelRow<T>(row)).filter((row): row is T => !!row)
}

/** Normalize the aggregate returned by the hardened loan RPCs. */
export function parseLoanAggregateRpcResult(value: unknown): LoanAggregateRpcResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loan operation returned an invalid result')
  }

  const raw = value as Record<string, unknown>
  const loan = camelRow<Loan>(raw.loan)
  if (!loan?.id || !loan.workspaceId) {
    throw new Error('Loan operation returned no loan')
  }

  return {
    loan,
    installments: camelRows<LoanInstallment>(raw.installments),
    payments: camelRows<LoanPayment>(raw.payments),
    transactions: camelRows<PaymentTransaction>(raw.transactions),
    linkedOrder: camelRow<SalesOrder | PurchaseOrder>(raw.linked_order ?? raw.linkedOrder),
  }
}

/**
 * Replace the responsive local projection with the database-authoritative
 * aggregate. This is safe for Cloud/Hybrid and for idempotent offline replay.
 */
export async function persistLoanAggregateRpcResult(value: unknown): Promise<LoanAggregateRpcResult> {
  const aggregate = parseLoanAggregateRpcResult(value)
  const syncedAt = new Date().toISOString()
  const withSync = <T extends { updatedAt?: string }>(row: T) => ({
    ...row,
    syncStatus: 'synced' as const,
    lastSyncedAt: syncedAt,
  })

  const loan = withSync(aggregate.loan)
  const installments = aggregate.installments.map(withSync)
  const payments = aggregate.payments.map(withSync)
  const transactions = aggregate.transactions.map(withSync)
  const linkedOrder = aggregate.linkedOrder ? withSync(aggregate.linkedOrder) : null

  await db.transaction(
    'rw',
    [
      db.loans,
      db.loan_installments,
      db.loan_payments,
      db.payment_transactions,
      db.sales_orders,
      db.purchase_orders,
    ],
    async () => {
      await db.loans.put(loan)
      if (installments.length > 0) await db.loan_installments.bulkPut(installments)
      if (payments.length > 0) await db.loan_payments.bulkPut(payments)
      if (transactions.length > 0) await db.payment_transactions.bulkPut(transactions)
      if (linkedOrder) {
        if (loan.orderType === 'purchase') await db.purchase_orders.put(linkedOrder as PurchaseOrder)
        else if (loan.orderType === 'sales') await db.sales_orders.put(linkedOrder as SalesOrder)
      }
    },
  )

  // The server trigger owns the authoritative account projection. Mirror it
  // immediately so Cloud/Hybrid UI does not wait for the next pull.
  for (const transaction of transactions) {
    await mirrorPaymentAccountTransactionLocally(transaction)
  }

  return { loan, installments, payments, transactions, linkedOrder }
}
