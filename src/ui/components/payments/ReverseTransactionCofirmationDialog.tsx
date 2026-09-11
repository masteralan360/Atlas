/**
 * @deprecated Use PaymentReversalDialog. The misspelled export is retained so
 * older module imports continue to resolve while receiving the new workflow.
 */
export { PaymentReversalDialog as ReverseTransactionCofirmationDialog } from './PaymentReversalDialog'
export type { PaymentTransaction as ReverseTransactionDetails } from '@/local-db'
