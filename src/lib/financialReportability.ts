export interface FinancialReportableRecord {
  isDeleted?: boolean | null
  voidId?: string | null
}

/** Default predicate for ordinary totals, reports, searches, and operational lists. */
export function isFinanciallyReportable(record: FinancialReportableRecord): boolean {
  return !record.isDeleted && !record.voidId
}

export const isReportablePaymentTransaction = isFinanciallyReportable
export const isReportableExpenseItem = isFinanciallyReportable
