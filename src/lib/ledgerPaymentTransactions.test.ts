import { describe, expect, it } from "vitest";

import type { PaymentTransaction } from "@/local-db";

import {
  getLedgerPaymentTransactionEffect,
  getLedgerPaymentTransactions,
} from "./ledgerPaymentTransactions";

function payment(
  overrides: Partial<PaymentTransaction> = {},
): PaymentTransaction {
  return {
    id: "payment-1",
    workspaceId: "workspace-1",
    sourceModule: "installment_sales",
    sourceType: "installment_sale_installment",
    sourceRecordId: "sale-1",
    sourceSubrecordId: "installment-1",
    direction: "incoming",
    amount: 100,
    currency: "iqd",
    paymentMethod: "cash",
    paidAt: "2026-09-09T10:00:00.000Z",
    counterpartyName: "Customer A",
    referenceLabel: "IS-100",
    note: null,
    createdBy: "user-1",
    reversalOfTransactionId: null,
    metadata: null,
    createdAt: "2026-09-09T10:00:00.000Z",
    updatedAt: "2026-09-09T10:00:00.000Z",
    version: 1,
    isDeleted: false,
    syncStatus: "synced",
    lastSyncedAt: "2026-09-09T10:00:00.000Z",
    ...overrides,
  };
}

function signedLedgerEffect(transaction: PaymentTransaction) {
  const effect = getLedgerPaymentTransactionEffect(transaction);
  return effect.direction === "incoming" ? effect.amount : -effect.amount;
}

describe("ledger payment transactions", () => {
  it("keeps a full installment-sale reversal as an audited counter-entry that nets to zero", () => {
    const original = payment({ id: "original", amount: 100 });
    const reversal = payment({
      id: "reversal",
      amount: -100,
      paidAt: "2026-09-10T10:00:00.000Z",
      reversalOfTransactionId: original.id,
    });

    expect(getLedgerPaymentTransactions([original, reversal])).toEqual([
      original,
      reversal,
    ]);
    expect(getLedgerPaymentTransactionEffect(original)).toEqual({
      direction: "incoming",
      amount: 100,
    });
    expect(getLedgerPaymentTransactionEffect(reversal)).toEqual({
      direction: "outgoing",
      amount: 100,
    });
    expect(signedLedgerEffect(original) + signedLedgerEffect(reversal)).toBe(0);
  });

  it("keeps partial reversals visible and preserves the correct remaining net amount", () => {
    const original = payment({ id: "original", amount: 100 });
    const reversal = payment({
      id: "partial-reversal",
      amount: -35,
      reversalOfTransactionId: original.id,
    });

    expect(getLedgerPaymentTransactions([original, reversal])).toHaveLength(2);
    expect(signedLedgerEffect(original) + signedLedgerEffect(reversal)).toBe(
      65,
    );
  });

  it("excludes soft-deleted and administrator-voided payment transactions", () => {
    const deleted = payment({ id: "deleted", isDeleted: true });
    const voided = payment({ id: "voided", voidId: "void-1" });
    const reversal = payment({
      id: "reversal",
      amount: -100,
      reversalOfTransactionId: "original",
    });

    expect(getLedgerPaymentTransactions([deleted, voided, reversal])).toEqual([
      reversal,
    ]);
  });
});
