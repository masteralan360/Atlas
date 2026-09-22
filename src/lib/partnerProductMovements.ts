import type {
  AgentProductCommissionEntry, InventoryTransaction, Loan, OrderReturn, OrderReturnItem,
  Product, PurchaseOrder, Sale, SaleItem, SaleProductExchange, SaleReturn, SaleReturnItem,
  SalesOrder, SalesOrderAgentAssignment
} from '@/local-db/models'
import { getOrderLineFulfilledQuantity, getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { roundQuantity } from '@/lib/quantity'
import type { PartnerAccountStatementPeriod } from '@/lib/partnerAccountStatement'
import { getLoanDetailsPath } from '@/lib/loanPresentation'

export type ProductMovementDirection = 'sold' | 'purchased'
export type ProductMovementReference = { label: string; path: string }
export type PartnerProductMovement = {
  id: string
  date: string | null
  productId: string
  item: string
  unit: string | null
  quantity: number
  direction: ProductMovementDirection
  kind: 'sale' | 'purchase' | 'return' | 'exchange' | 'bonus'
  note: string | null
  currency: string
  commissionPerProduct: number | null
  totalProductCommission: number | null
  references: ProductMovementReference[]
}
export type PartnerProductMovementsData = {
  workspaceId: string
  partnerId: string
  agentIds: string[]
  period: PartnerAccountStatementPeriod
  salesOrders: SalesOrder[]
  purchaseOrders: PurchaseOrder[]
  assignments: SalesOrderAgentAssignment[]
  commissions: AgentProductCommissionEntry[]
  orderReturns: OrderReturn[]
  orderReturnItems: OrderReturnItem[]
  loans: Loan[]
  sales: Sale[]
  saleItems: SaleItem[]
  saleReturns: SaleReturn[]
  saleReturnItems: SaleReturnItem[]
  exchanges: SaleProductExchange[]
  products: Product[]
  inventoryTransactions: InventoryTransaction[]
  canAccessStorage?: (storageId: string | null | undefined) => boolean
}
export type PartnerProductMovementsStatement = {
  entries: PartnerProductMovement[]
  quantityTotals: { direction: ProductMovementDirection; unit: string | null; quantity: number }[]
  commissionTotals: { currency: string; amount: number }[]
  undatedCount: number
  hasCommission: boolean
}

function positive(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? roundQuantity(Math.max(0, number)) : 0
}
function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}
function unique<T extends { id: string }>(rows: T[]) {
  return [...new Map(rows.map(row => [row.id, row])).values()]
}

/** Physical quantities are independent of financing, balances and commission payout records. */
export function buildPartnerProductMovements(data: PartnerProductMovementsData, accumulate = false): PartnerProductMovementsStatement {
  const active = <T extends { workspaceId: string; isDeleted?: boolean }>(rows: T[]) => rows.filter(row => row.workspaceId === data.workspaceId && !row.isDeleted)
  const canAccessStorage = data.canAccessStorage || (() => true)
  const agentIds = new Set(data.agentIds)
  const commissions = unique(active(data.commissions)).filter(row => agentIds.has(row.agentId))
  const attributedOrderIds = new Set([
    ...active(data.assignments).filter(row => agentIds.has(row.agentId)).map(row => row.orderId),
    ...commissions.map(row => row.orderId)
  ])
  const raw: PartnerProductMovement[] = []
  const inventoryDates = new Map<string, string>()
  for (const tx of active(data.inventoryTransactions)) {
    const date = timestamp(tx.createdAt)
    const key = JSON.stringify([tx.referenceId, tx.referenceType])
    if (date && (!inventoryDates.has(key) || date < inventoryDates.get(key)!)) inventoryDates.set(key, date)
  }
  const snapshotsByLine = new Map<string, AgentProductCommissionEntry[]>()
  for (const snapshot of commissions) {
    const key = JSON.stringify([snapshot.orderId, snapshot.orderItemId, snapshot.orderReturnId || null])
    const rows = snapshotsByLine.get(key) || []
    rows.push(snapshot)
    snapshotsByLine.set(key, rows)
  }
  const snapshotsForLine = (orderId: string, itemId: string, returnId: string | null = null) => snapshotsByLine.get(JSON.stringify([orderId, itemId, returnId])) || []
  const orderDate = (order: SalesOrder | PurchaseOrder, type: string) => timestamp(order.actualDeliveryDate)
    || inventoryDates.get(JSON.stringify([order.id, type])) || null
  const add = (row: PartnerProductMovement) => { if (Number.isFinite(row.quantity) && Math.abs(row.quantity) >= 0.000001) raw.push(row) }

  // A line can carry historical commission snapshots at different locked rates.
  // Partition only the physically moved paid quantity; free products never acquire commission.
  const addWithCommission = (base: PartnerProductMovement, snapshots: AgentProductCommissionEntry[]) => {
    const byRate = new Map<string, { currency: string; rate: number; quantity: number; amount: number }>()
    for (const snapshot of snapshots) {
      if (!Number.isFinite(snapshot.commissionPerUnit) || !Number.isFinite(snapshot.amount) || !Number.isFinite(snapshot.quantity) || !snapshot.quantity) continue
      const currency = snapshot.currency.toLowerCase()
      const key = JSON.stringify([currency, snapshot.commissionPerUnit])
      const group = byRate.get(key) || { currency, rate: snapshot.commissionPerUnit, quantity: 0, amount: 0 }
      group.quantity = roundQuantity(group.quantity + Math.sign(base.quantity) * snapshot.quantity)
      group.amount = roundQuantity(group.amount + snapshot.amount)
      byRate.set(key, group)
    }
    let remaining = Math.abs(base.quantity)
    for (const [key, group] of byRate) {
      const quantity = Math.min(remaining, group.quantity)
      if (quantity <= 0) continue
      const signedQuantity = Math.sign(base.quantity) * quantity
      add({ ...base, id: `${base.id}:${key}`, currency: group.currency, quantity: signedQuantity,
        commissionPerProduct: group.rate,
        totalProductCommission: roundQuantity(group.amount * quantity / group.quantity) })
      remaining = roundQuantity(remaining - quantity)
    }
    if (remaining > 0) add({ ...base, quantity: Math.sign(base.quantity) * remaining })
  }

  const salesOrders = unique(active(data.salesOrders)).filter(order => order.status !== 'draft' && order.status !== 'cancelled'
    && (order.businessPartnerId === data.partnerId || order.customerId === data.partnerId || agentIds.has(order.salesAccountAgentId || '') || attributedOrderIds.has(order.id)))
  const orderById = new Map(salesOrders.map(order => [order.id, order]))
  for (const order of salesOrders) {
    for (const item of order.items) {
      const fulfilled = getOrderLineFulfilledQuantity(item, order.status === 'completed')
      const paid = Math.min(fulfilled, positive(item.quantity))
      const base: PartnerProductMovement = {
        id: `so:${order.id}:${item.id}`, date: orderDate(order, 'sales_order'), productId: item.productId,
        item: item.productName, unit: item.unit || null, quantity: paid, direction: 'sold', kind: 'sale', note: item.note || null,
        currency: order.currency.toLowerCase(), commissionPerProduct: null, totalProductCommission: null,
        references: [{ label: order.orderNumber, path: `/orders/${order.id}` }]
      }
      addWithCommission(base, snapshotsForLine(order.id, item.id))
      const bonus = roundQuantity(fulfilled - paid)
      if (bonus > 0) add({ ...base, id: `${base.id}:bonus`, kind: 'bonus', quantity: bonus })
    }
  }
  for (const orderReturn of unique(active(data.orderReturns)).filter(row => row.status === 'posted')) {
    const order = orderById.get(orderReturn.orderId)
    if (!order) continue
    for (const returned of unique(active(data.orderReturnItems)).filter(row => row.returnId === orderReturn.id && canAccessStorage(row.restoredStorageId))) {
      const item = order.items.find(row => row.id === returned.orderItemId)
      if (!item || !getOrderLineFulfilledQuantity(item, order.status === 'completed')) continue
      const base: PartnerProductMovement = {
        id: `so-return:${returned.id}`, date: timestamp(orderReturn.returnedAt), productId: item.productId,
        item: item.productName, unit: item.unit || null, quantity: -positive(returned.quantity), direction: 'sold', kind: 'return', note: orderReturn.reason || null,
        currency: order.currency.toLowerCase(), commissionPerProduct: null, totalProductCommission: null,
        references: [{ label: `${order.orderNumber} · ${orderReturn.id}`, path: `/orders/${order.id}` }]
      }
      addWithCommission(base, snapshotsForLine(order.id, item.id, orderReturn.id))
    }
  }
  for (const order of unique(active(data.purchaseOrders)).filter(row => row.status !== 'draft' && row.status !== 'cancelled'
    && (row.businessPartnerId === data.partnerId || row.supplierId === data.partnerId))) {
    for (const item of order.items) {
      const received = order.status === 'received' || order.status === 'completed'
        ? item.receivedQuantity != null ? positive(item.receivedQuantity) : getOrderLineInventoryQuantity(item)
        : 0
      const base: PartnerProductMovement = {
        id: `po:${order.id}:${item.id}`, date: orderDate(order, 'purchase_order'), productId: item.productId,
        item: item.productName, unit: item.unit || null, quantity: received, direction: 'purchased', kind: 'purchase', note: item.note || null,
        currency: order.currency.toLowerCase(), commissionPerProduct: null, totalProductCommission: null,
        references: [{ label: order.orderNumber, path: `/orders/${order.id}` }]
      }
      add(base)
    }
  }

  // POS has no direct partner field. Established loan links identify its partner,
  // including installment-financed POS; two financing records still yield one sale.
  const linkedSales = new Set(active(data.loans).filter(loan => loan.linkedPartyType === 'business_partner'
    && loan.linkedPartyId === data.partnerId && loan.saleId).map(loan => loan.saleId!))
  const sales = unique(active(data.sales)).filter(sale => linkedSales.has(sale.id))
  const saleById = new Map(sales.map(sale => [sale.id, sale]))
  const visibleItemIds = new Map(sales.map(sale => {
    const items = (sale as Sale & { _enrichedItems?: { id: string }[] })._enrichedItems
    return [sale.id, Array.isArray(items) ? new Set(items.map(item => item.id)) : null] as const
  }))
  const products = new Map(active(data.products).map(product => [product.id, product]))
  const saleItems = unique(active(data.saleItems)).filter(item => saleById.has(item.saleId)
    && canAccessStorage(item.storageId) && (!visibleItemIds.get(item.saleId) || visibleItemIds.get(item.saleId)!.has(item.id)))
  const itemById = new Map(saleItems.map(item => [item.id, item]))
  const posBase = (sale: Sale, item: SaleItem): PartnerProductMovement => ({
    id: `pos:${item.id}`, date: timestamp(item.createdAt) || timestamp(sale.createdAt), productId: item.productId,
    item: products.get(item.productId)?.name || item.productId, unit: products.get(item.productId)?.unit || null,
    quantity: positive(item.quantity), direction: 'sold', kind: 'sale', note: null,
    currency: sale.settlementCurrency.toLowerCase(), commissionPerProduct: null, totalProductCommission: null,
    references: [{ label: sale.sequenceId ? `SALE-${sale.sequenceId}` : `SALE-${sale.id.slice(0, 8).toUpperCase()}`,
      path: (() => { const loan = data.loans.find(row => row.saleId === sale.id && row.linkedPartyId === data.partnerId && !row.isDeleted); return loan ? getLoanDetailsPath(loan, loan.id) : '/sales' })() }]
  })
  for (const item of saleItems) add(posBase(saleById.get(item.saleId)!, item))
  const returns = unique(active(data.saleReturns)).filter(row => row.status === 'posted' && saleById.has(row.saleId))
  const returnById = new Map(returns.map(row => [row.id, row]))
  for (const returned of unique(active(data.saleReturnItems))) {
    if (!canAccessStorage(returned.restoredStorageId)) continue
    const header = returnById.get(returned.returnId)
    const item = itemById.get(returned.saleItemId)
    if (!header || !item) continue
    const base = posBase(saleById.get(header.saleId)!, item)
    add({ ...base, id: `pos-return:${returned.id}`, date: timestamp(header.returnedAt), kind: 'return', quantity: -positive(returned.quantity), note: header.reason,
      references: [{ ...base.references[0], label: `${base.references[0].label} · ${header.id}` }] })
  }
  for (const exchange of unique(active(data.exchanges)).filter(row => row.status === 'posted' && saleById.has(row.saleId))) {
    if (!canAccessStorage(exchange.replacementStorageId)) continue
    const item = itemById.get(exchange.returnSaleItemId)
    if (!item) continue
    const base = posBase(saleById.get(exchange.saleId)!, item)
    const product = products.get(exchange.replacementProductId)
    add({ ...base, id: `pos-exchange:${exchange.id}`, date: timestamp(exchange.exchangedAt), kind: 'exchange', note: exchange.reason,
      productId: exchange.replacementProductId, item: product?.name || exchange.replacementProductId, unit: product?.unit || null,
      quantity: positive(exchange.replacementQuantity), currency: exchange.settlementCurrency.toLowerCase(),
      references: [{ ...base.references[0], label: `${base.references[0].label} · ${exchange.id}` }] })
  }

  const undatedCount = raw.filter(row => !row.date).length
  const start = data.period.start ? Date.parse(data.period.start) : -Infinity
  const endDate = data.period.end ? new Date(data.period.end) : null
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(data.period.end!)) endDate.setDate(endDate.getDate() + 1)
  const end = endDate ? endDate.getTime() - (/^\d{4}-\d{2}-\d{2}$/.test(data.period.end!) ? 1 : 0) : Infinity
  const filtered = raw.filter(row => data.period.type === 'allTime'
    || (row.date !== null && Date.parse(row.date) >= start && Date.parse(row.date) <= end))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id))
  const quantities = new Map<string, PartnerProductMovementsStatement['quantityTotals'][number]>()
  const amounts = new Map<string, number>()
  for (const row of filtered) {
    const key = JSON.stringify([row.direction, row.unit])
    const total = quantities.get(key) || { direction: row.direction, unit: row.unit, quantity: 0 }
    total.quantity = roundQuantity(total.quantity + row.quantity)
    quantities.set(key, total)
    if (row.totalProductCommission !== null) amounts.set(row.currency, roundQuantity((amounts.get(row.currency) || 0) + row.totalProductCommission))
  }
  const groups = new Map<string, PartnerProductMovement>()
  if (accumulate) for (const row of filtered) {
    const key = JSON.stringify([row.productId, row.unit, row.direction, row.currency, row.commissionPerProduct, row.kind === 'bonus'])
    const existing = groups.get(key)
    if (!existing) groups.set(key, { ...row, id: `group:${key}`, kind: row.kind === 'bonus' ? 'bonus' : row.direction === 'sold' ? 'sale' : 'purchase', note: null, references: [...row.references] })
    else {
      existing.quantity = roundQuantity(existing.quantity + row.quantity)
      if (existing.totalProductCommission !== null) existing.totalProductCommission = roundQuantity(existing.totalProductCommission + (row.totalProductCommission || 0))
      for (const ref of row.references) if (!existing.references.some(other => other.label === ref.label && other.path === ref.path)) existing.references.push(ref)
    }
  }
  return {
    entries: accumulate ? [...groups.values()] : filtered,
    quantityTotals: [...quantities.values()], commissionTotals: [...amounts].map(([currency, amount]) => ({ currency, amount })),
    undatedCount, hasCommission: filtered.some(row => row.commissionPerProduct !== null)
  }
}
