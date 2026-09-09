import type { PaymentTransaction } from "@/local-db";

export type LedgerPaymentDirection = "incoming" | "outgoing";

/**
 * Ledger is an immutable audit view: it must retain both a payment and each
 * reversing transaction rather than collapsing them to a net settlement.
 */
export function getLedgerPaymentTransactions(rows: PaymentTransaction[]) {
  return rows.filter((row) => !row.isDeleted);
}

/**
 * Payment reversals retain their source direction and use a signed amount.
 * Convert that signed accounting effect into the Ledger's positive amount plus
 * incoming/outgoing direction representation.
 */
export function getLedgerPaymentTransactionEffect(
  transaction: Pick<PaymentTransaction, "amount" | "direction">,
): { direction: LedgerPaymentDirection; amount: number } {
  const amount = Number(transaction.amount || 0);
  const signedAmount = transaction.direction === "incoming" ? amount : -amount;

  return {
    direction: signedAmount < 0 ? "outgoing" : "incoming",
    amount: Math.abs(signedAmount),
  };
}
