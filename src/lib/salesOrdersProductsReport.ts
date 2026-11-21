import type { SalesOrder } from '@/local-db'
import { getOrderLineFreeBonusQuantity, getOrderLinePaidQuantity } from '@/lib/orderLineItems'
import { roundQuantity } from '@/lib/quantity'

export type SalesOrdersProductsReportRow = {
  key: string
  item: string
  quantity: number
  unit: string | null
}

export type SalesOrdersProductsReportUnitTotal = {
  unit: string | null
  quantity: number
}

export type SalesOrdersProductsReportData = {
  rows: SalesOrdersProductsReportRow[]
  unitTotals: SalesOrdersProductsReportUnitTotal[]
  generatedAt: string
}

function getOrderLineUnit(
  line: SalesOrder['items'][number],
  productUnits: Record<string, string | null | undefined>,
  bonus = false
) {
  if (bonus && line.freeBonusUnit?.trim()) return line.freeBonusUnit.trim()
  if (line.unitRef?.startsWith('custom:') && line.unitNameSnapshot?.trim()) return line.unitNameSnapshot.trim()
  return line.unit?.trim() || line.uomNameSnapshot?.trim() || productUnits[line.productId]?.trim() || null
}

/** Aggregate each unique order line once, retaining product identity across orders. */
export function buildSalesOrdersProductsReport(
  orders: readonly SalesOrder[],
  productUnits: Record<string, string | null | undefined> = {}
): Omit<SalesOrdersProductsReportData, 'generatedAt'> {
  const rowsByProductAndUnit = new Map<string, SalesOrdersProductsReportRow>()
  const seenOrders = new Set<string>()

  for (const order of orders) {
    if (order.status === 'cancelled' || order.status === 'returned' || (order.returnStatus && order.returnStatus !== 'none')) {
      continue
    }
    if (order.id && seenOrders.has(order.id)) continue
    if (order.id) seenOrders.add(order.id)

    const seenLines = new Set<string>()
    for (const line of order.items || []) {
      if (line.id && seenLines.has(line.id)) continue
      if (line.id) seenLines.add(line.id)

      const productId = line.productId?.trim()
      const sku = line.productSku?.trim()
      const name = line.productName?.trim() || sku || productId || ''
      const productIdentity = productId
        ? `product:${productId}`
        : sku
          ? `sku:${sku.toLocaleLowerCase()}`
          : `name:${name.normalize('NFKC').trim().toLocaleLowerCase()}`
      if (!name || !productIdentity) continue

      const addQuantity = (quantity: number, unit: string | null) => {
        if (quantity <= 0) return
        const unitIdentity = unit?.normalize('NFKC').trim().toLocaleLowerCase() || ''
        const key = JSON.stringify([productIdentity, unitIdentity])
        const existing = rowsByProductAndUnit.get(key)
        rowsByProductAndUnit.set(key, {
          key,
          item: existing?.item || name,
          quantity: roundQuantity((existing?.quantity || 0) + quantity),
          unit: existing?.unit || unit
        })
      }

      addQuantity(getOrderLinePaidQuantity(line), getOrderLineUnit(line, productUnits))
      addQuantity(getOrderLineFreeBonusQuantity(line), getOrderLineUnit(line, productUnits, true))
    }
  }

  const rows = Array.from(rowsByProductAndUnit.values())
  const totalsByUnit = new Map<string, SalesOrdersProductsReportUnitTotal>()
  for (const row of rows) {
    const unitIdentity = row.unit?.normalize('NFKC').trim().toLocaleLowerCase() || ''
    const existing = totalsByUnit.get(unitIdentity)
    totalsByUnit.set(unitIdentity, {
      unit: existing?.unit || row.unit,
      quantity: roundQuantity((existing?.quantity || 0) + row.quantity)
    })
  }

  return {
    rows,
    unitTotals: Array.from(totalsByUnit.values())
  }
}
