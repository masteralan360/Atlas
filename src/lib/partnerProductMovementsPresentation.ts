import type { PartnerProductMovement } from './partnerProductMovements'
import type { PartnerProductMovementsColumnId } from './partnerProductMovementsTemplates'
import { formatProductQuantity } from './productUnitPresentation'

export const PRODUCT_MOVEMENTS_COLUMN_KEYS: Record<PartnerProductMovementsColumnId, string> = {
  reference: 'businessPartners.accountStatement.templateColumns.reference', description: 'common.description', item: 'businessPartners.accountStatement.item',
  quantity: 'businessPartners.accountStatement.quantity', commissionPerProduct: 'salesAgentCommissions.productCommission.perUnit',
  totalProductCommission: 'salesAgentCommissions.productCommission.lineTotal'
}
export function formatProductMovementQuantity(
  quantity: number,
  unit: string | null,
  language: string,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  return formatProductQuantity(quantity, unit, language, t)
}
export function getProductMovementDescription(row: PartnerProductMovement, t: (key: string) => string) {
  return [t(`businessPartners.productMovements.kinds.${row.kind}`), row.note].filter(Boolean).join(' · ')
}

export type ProductMovementPrintRow = { entry: PartnerProductMovement; references: PartnerProductMovement['references'] }
/** One physical or accumulated product entry always occupies one table row. */
export function getProductMovementPrintRows(entries: PartnerProductMovement[], showReferences = true) {
  return entries.map(entry => ({ entry, references: showReferences ? entry.references : [] }))
}
