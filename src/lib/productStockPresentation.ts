import { roundQuantity } from '@/lib/quantity'

type ProductUomPresentation = {
  factor: number
  largerUnitLabel: string
  smallerUnitLabel: string
  conjunction: string
}

/** Inventory quantities are already stored in the smaller unit. */
export function getProductStockPresentation(
  quantity: number,
  fallbackUnitLabel: string,
  largerUom: ProductUomPresentation | null,
  formatNumber: (value: number) => string,
) {
  if (!largerUom || !Number.isFinite(largerUom.factor) || largerUom.factor <= 1) {
    return {
      label: `${formatNumber(quantity)} ${fallbackUnitLabel}`,
      smallerUnitTotal: null,
    }
  }

  const { factor, largerUnitLabel, smallerUnitLabel, conjunction } = largerUom
  const normalized = roundQuantity(Math.max(0, quantity))
  const parentQuantity = Math.floor((normalized + 1e-9) / factor)
  const childQuantity = roundQuantity(normalized - parentQuantity * factor)
  const parent = `${formatNumber(parentQuantity)} ${largerUnitLabel}`
  const child = `${formatNumber(childQuantity)} ${smallerUnitLabel}`
  const label = parentQuantity > 0 && childQuantity > 0
    ? `${parent} ${conjunction} ${child}`
    : parentQuantity > 0 ? parent : child

  return {
    label,
    smallerUnitTotal: parentQuantity > 0 ? `${formatNumber(quantity)} ${smallerUnitLabel}` : null,
  }
}
