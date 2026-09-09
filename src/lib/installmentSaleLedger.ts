import type { PaymentTransaction } from "@/local-db";

export type InstallmentSaleLedgerPayment = {
  type: "installment_sale_down_payment" | "installment_sale_collection";
  descriptionKey:
    | "installmentSaleDownPayment"
    | "installmentSaleCollection";
  referenceId: string;
  partner: string | null;
  businessPartnerId: string | null;
  relationKey: string;
};

/**
 * Maps actual installment-sale cash receipts to Ledger entries. The sale
 * receivable itself intentionally has no mapping because no cash moved yet.
 */
export function getInstallmentSaleLedgerPayment(
  transaction: Pick<
    PaymentTransaction,
    | "sourceType"
    | "sourceRecordId"
    | "referenceLabel"
    | "counterpartyName"
    | "metadata"
  >,
): InstallmentSaleLedgerPayment | null {
  const isDownPayment =
    transaction.sourceType === "installment_sale_down_payment";
  const isCollection =
    transaction.sourceType === "installment_sale_installment";

  if (!isDownPayment && !isCollection) return null;

  const businessPartnerId =
    typeof transaction.metadata?.businessPartnerId === "string"
      ? transaction.metadata.businessPartnerId
      : null;

  return {
    type: isDownPayment
      ? "installment_sale_down_payment"
      : "installment_sale_collection",
    descriptionKey: isDownPayment
      ? "installmentSaleDownPayment"
      : "installmentSaleCollection",
    referenceId:
      transaction.referenceLabel?.trim() ||
      `IS-${transaction.sourceRecordId.slice(0, 8).toUpperCase()}`,
    partner: transaction.counterpartyName?.trim() || null,
    businessPartnerId,
    relationKey: `installment-sale:${transaction.sourceRecordId}`,
  };
}
