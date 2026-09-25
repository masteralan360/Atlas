import { formatHierarchicalQuantity, splitHierarchicalQuantity } from '@/lib/unitRelationships'

type RelatedUnits = {
  factor: number
  largerUnitLabel: string
  smallerUnitLabel: string
  conjunction: string
}

/** Inventory quantities are already stored in the smaller unit. */
export function getProductStockPresentation(
  quantity: number,
  fallbackUnitLabel: string,
  relatedUnits: RelatedUnits | null,
  formatNumber: (value: number) => string,
) {
  if (!relatedUnits) {
    return {
      label: `${formatNumber(quantity)} ${fallbackUnitLabel}`,
      smallerUnitTotal: null,
    }
  }

  const { factor, largerUnitLabel, smallerUnitLabel, conjunction } = relatedUnits
  const label = formatHierarchicalQuantity(
    quantity,
    factor,
    largerUnitLabel,
    smallerUnitLabel,
    conjunction,
    formatNumber,
  )
  const { parentQuantity } = splitHierarchicalQuantity(quantity, factor)

  return {
    label,
    smallerUnitTotal: parentQuantity > 0 ? `${formatNumber(quantity)} ${smallerUnitLabel}` : null,
  }
}
