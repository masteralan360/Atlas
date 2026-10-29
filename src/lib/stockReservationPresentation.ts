import { inventoryQuantityToSellingAvailability } from '@/lib/productUoms'
import { getProductStockPresentation } from '@/lib/productStockPresentation'
import { roundQuantity } from '@/lib/quantity'

/** Use the line's saved selection, rather than the product's current coefficient. */
export interface StockReservationSellingUnit {
  unitCode?: string | null
  baseUnitCode?: string | null
  factor?: number | null
  isDynamic?: boolean
}

export function getSellableStockQuantity(available: number, inCart: number, factor = 1, isDynamic = true) {
  const coefficient = Number.isFinite(factor) && factor > 0 ? factor : 1
  const remaining = roundQuantity(Math.max(0, available - inCart))
  // Do not round a nearly-full pack up before taking the whole-pack count.
  return isDynamic ? inventoryQuantityToSellingAvailability(remaining, coefficient) : Math.floor(remaining / coefficient + 1e-9)
}

/** Every input quantity is canonical stock, including quantities aggregated across different UoMs. */
export function formatStockReservationQuantity(
  quantity: number,
  baseUnitLabel: string,
  selectedUnit: { label: string; factor: number; isDynamic?: boolean } | undefined,
  formatNumber: (value: number) => string,
  conjunction: string,
) {
  const base = `${formatNumber(quantity)} ${baseUnitLabel}`
  if (!selectedUnit?.label || !Number.isFinite(selectedUnit.factor) || selectedUnit.factor <= 0) return base
  if (selectedUnit.factor === 1 && selectedUnit.label === baseUnitLabel) return base
  if (selectedUnit.factor > 1 && !selectedUnit.isDynamic) {
    const presentation = getProductStockPresentation(quantity, baseUnitLabel, {
      factor: selectedUnit.factor,
      largerUnitLabel: selectedUnit.label,
      smallerUnitLabel: baseUnitLabel,
      conjunction,
    }, formatNumber)
    return presentation.smallerUnitTotal ? `${presentation.label} (${base})` : presentation.label
  }
  return `${formatNumber(inventoryQuantityToSellingAvailability(quantity, selectedUnit.factor))} ${selectedUnit.label} (${base})`
}
