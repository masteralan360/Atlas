import { describe, expect, it } from "vitest";

import { getInstallmentSaleLedgerPayment } from "./installmentSaleLedger";

describe("getInstallmentSaleLedgerPayment", () => {
  const baseTransaction = {
    sourceRecordId: "sale-123456789",
    referenceLabel: "IS-20260909-ABC123",
    counterpartyName: "Customer A",
    metadata: { businessPartnerId: "partner-1" },
  };

  it("maps a down payment to an incoming installment-sale Ledger entry", () => {
    expect(
      getInstallmentSaleLedgerPayment({
        ...baseTransaction,
        sourceType: "installment_sale_down_payment",
      }),
    ).toEqual({
      type: "installment_sale_down_payment",
      descriptionKey: "installmentSaleDownPayment",
      referenceId: "IS-20260909-ABC123",
      partner: "Customer A",
      businessPartnerId: "partner-1",
      relationKey: "installment-sale:sale-123456789",
    });
  });

  it("maps later collections and excludes unrelated payments", () => {
    expect(
      getInstallmentSaleLedgerPayment({
        ...baseTransaction,
        sourceType: "installment_sale_installment",
      }),
    ).toMatchObject({
      type: "installment_sale_collection",
      descriptionKey: "installmentSaleCollection",
    });
    expect(
      getInstallmentSaleLedgerPayment({
        ...baseTransaction,
        sourceType: "loan_installment",
      }),
    ).toBeNull();
  });
});
