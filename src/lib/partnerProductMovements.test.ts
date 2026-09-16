import { describe, expect, it } from 'vitest'
import type { AgentProductCommissionEntry, PurchaseOrder, SalesOrder } from '@/local-db/models'
import { buildPartnerProductMovements, type PartnerProductMovementsData } from './partnerProductMovements'

const entity = { workspaceId: 'workspace', isDeleted: false, createdAt: '2026-01-01T10:00:00Z' }
function sales(id: string, quantity = 1, overrides: Partial<SalesOrder> = {}): SalesOrder {
  return { ...entity, id, orderNumber: id, customerId: 'partner', status: 'completed', currency: 'usd', actualDeliveryDate: '2026-09-10T10:00:00Z',
    items: [{ id: `${id}-line`, productId: 'a', productName: 'Product A', unit: 'Box', quantity }], ...overrides } as SalesOrder
}
function purchase(id: string, overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return { ...entity, id, orderNumber: id, supplierId: 'partner', status: 'received', currency: 'usd', actualDeliveryDate: '2026-09-10T10:00:00Z',
    items: [{ id: `${id}-line`, productId: 'a', productName: 'Product A', unit: 'Box', quantity: 4 }], ...overrides } as PurchaseOrder
}
function commission(orderId: string, rate: number, quantity: number, overrides: Partial<AgentProductCommissionEntry> = {}): AgentProductCommissionEntry {
  return { ...entity, id: `commission-${orderId}`, orderId, orderItemId: `${orderId}-line`, agentId: 'agent', productId: 'a', kind: 'accrual',
    currency: 'usd', commissionPerUnit: rate, quantity, amount: rate * quantity, ...overrides } as AgentProductCommissionEntry
}
function data(overrides: Partial<PartnerProductMovementsData> = {}): PartnerProductMovementsData {
  return { workspaceId: 'workspace', partnerId: 'partner', agentIds: ['agent'], period: { type: 'allTime' }, salesOrders: [], purchaseOrders: [],
    assignments: [], commissions: [], orderReturns: [], orderReturnItems: [], loans: [], sales: [], saleItems: [], saleReturns: [], saleReturnItems: [],
    exchanges: [], products: [], inventoryTransactions: [], ...overrides }
}

describe('Partner Product Movements Statement', () => {
  it('includes only actual fulfilled and received quantities, independent of financing', () => {
    const partial = sales('partial', 5, { status: 'pending' })
    partial.items[0].fulfilledQuantity = 2
    const unreceived = purchase('unreceived', { status: 'ordered' })
    const received = purchase('partial-receipt', { status: 'ordered' })
    received.items[0].receivedQuantity = 1.5
    const statement = buildPartnerProductMovements(data({ salesOrders: [sales('draft', 3, { status: 'draft' }), sales('cancelled', 3, { status: 'cancelled' }), sales('pending', 5, { status: 'pending' }), partial, sales('financed', 3, { linkedLoanId: 'loan' })], purchaseOrders: [unreceived, received] }))
    expect(statement.entries.map(row => row.quantity)).toEqual([1.5, 3, 2])
    expect(statement.quantityTotals).toEqual(expect.arrayContaining([{ direction: 'sold', unit: 'Box', quantity: 5 }, { direction: 'purchased', unit: 'Box', quantity: 1.5 }]))
  })
  it('accumulates the requested example and preserves unique source references', () => {
    const b = (id: string, qty: number) => { const order = sales(id, qty); order.items[0].productId = 'b'; order.items[0].productName = 'Product B'; return order }
    const source = data({ salesOrders: [sales('SO-2026-0006'), sales('SO-2026-0003', 3), b('SO-2026-0001', 1), sales('SO-2026-0009'), b('SO-2026-0008', 5)] })
    const statement = buildPartnerProductMovements(source, true)
    expect(statement.entries.find(row => row.productId === 'a')?.quantity).toBe(5)
    expect(statement.entries.find(row => row.productId === 'b')?.quantity).toBe(6)
    expect(statement.entries.find(row => row.productId === 'a')?.references.map(ref => ref.label)).toEqual(['SO-2026-0003', 'SO-2026-0006', 'SO-2026-0009'])
    expect(buildPartnerProductMovements(source).entries).toHaveLength(5)
    expect(statement.quantityTotals).toEqual(buildPartnerProductMovements(source).quantityTotals)
  })
  it('separates rates, currencies, units, product IDs and purchase direction', () => {
    const unit = sales('piece', 2); unit.items[0].unit = 'Piece'
    const sameName = sales('different-product'); sameName.items[0].productId = 'other'
    const source = data({ salesOrders: [sales('rate2', 3), sales('rate3', 2), sales('iqd'), unit, sameName], purchaseOrders: [purchase('po')],
      commissions: [commission('rate2', 2, 3), commission('rate3', 3, 2), commission('iqd', 2, 1, { currency: 'iqd' })] })
    const statement = buildPartnerProductMovements(source, true)
    expect(statement.entries).toHaveLength(6)
    expect(statement.commissionTotals).toEqual(expect.arrayContaining([{ currency: 'usd', amount: 12 }, { currency: 'iqd', amount: 2 }]))
    expect(statement.quantityTotals).toEqual(expect.arrayContaining([{ direction: 'sold', unit: 'Box', quantity: 7 }, { direction: 'sold', unit: 'Piece', quantity: 2 }, { direction: 'purchased', unit: 'Box', quantity: 4 }]))
  })
  it('counts free bonus movements without commission and prorates only fulfilled paid quantities', () => {
    const order = sales('bonus', 3); order.items[0].freeBonusQuantity = 2
    const partial = sales('partial', 10, { status: 'pending' }); partial.items[0].fulfilledQuantity = 4
    const statement = buildPartnerProductMovements(data({ salesOrders: [order, partial], commissions: [commission('bonus', 2, 3), commission('partial', 2, 10)] }), true)
    expect(statement.quantityTotals[0].quantity).toBe(9)
    expect(statement.entries.find(row => row.kind === 'bonus')).toMatchObject({ quantity: 2, commissionPerProduct: null, totalProductCommission: null })
    expect(statement.commissionTotals).toEqual([{ currency: 'usd', amount: 14 }])
  })
  it('nets posted returns and their exact recorded commission reversals, retaining zero groups', () => {
    const source = data({ salesOrders: [sales('sale', 2)], commissions: [commission('sale', 1.5, 2), commission('sale', 1.5, -2, { id: 'reversal', kind: 'reversal', orderReturnId: 'return' })],
      orderReturns: [{ ...entity, id: 'return', orderId: 'sale', status: 'posted', returnedAt: '2026-09-11T10:00:00Z', reason: 'Damaged' } as never,
        { ...entity, id: 'void', orderId: 'sale', status: 'voided' } as never],
      orderReturnItems: [{ ...entity, id: 'return-line', returnId: 'return', orderId: 'sale', orderItemId: 'sale-line', quantity: 2 } as never,
        { ...entity, id: 'void-line', returnId: 'void', orderId: 'sale', orderItemId: 'sale-line', quantity: 2 } as never] })
    const statement = buildPartnerProductMovements(source, true)
    expect(statement.entries).toHaveLength(1)
    expect(statement.entries[0]).toMatchObject({ quantity: 0, totalProductCommission: 0 })
    expect(statement.entries[0].references).toHaveLength(2)
    expect(statement.commissionTotals).toEqual([{ currency: 'usd', amount: 0 }])
  })
  it('includes attributed fulfilled agent sales for another buyer once and excludes other agents', () => {
    const order = sales('agent-sale', 3, { customerId: 'other-buyer' })
    const unrelated = sales('other-sale', 5, { customerId: 'other-buyer' })
    const statement = buildPartnerProductMovements(data({ salesOrders: [order, order, unrelated], commissions: [commission('agent-sale', 2, 3), commission('other-sale', 2, 5, { agentId: 'other-agent' })],
      assignments: [{ ...entity, id: 'assignment', orderId: 'agent-sale', agentId: 'agent' } as never] }))
    expect(statement.entries).toHaveLength(1)
    expect(statement.quantityTotals[0].quantity).toBe(3)
    expect(statement.hasCommission).toBe(true)
  })
  it('filters by actual movement date and includes the entire custom end day', () => {
    const statement = buildPartnerProductMovements(data({ period: { type: 'custom', start: '2026-09-10', end: '2026-09-10' },
      salesOrders: [sales('in', 2), sales('out', 3, { actualDeliveryDate: '2026-09-11T10:00:00Z' })] }))
    expect(statement.entries).toHaveLength(1)
    expect(statement.entries[0].quantity).toBe(2)
  })
  it('shows undated legacy movements in All Time only, using linked inventory dates when present', () => {
    const source = data({ salesOrders: [sales('undated', 2, { actualDeliveryDate: null }), sales('inventory-dated', 3, { actualDeliveryDate: null })],
      inventoryTransactions: [{ ...entity, id: 'tx', referenceId: 'inventory-dated', referenceType: 'sales_order', createdAt: '2026-09-10T10:00:00Z' } as never] })
    expect(buildPartnerProductMovements(source).undatedCount).toBe(1)
    const statement = buildPartnerProductMovements({ ...source, period: { type: 'custom', start: '2026-09-10', end: '2026-09-10' } })
    expect(statement.entries).toHaveLength(1)
    expect(statement.entries[0].quantity).toBe(3)
  })
  it('rounds quantities and commission totals to six decimals', () => {
    const statement = buildPartnerProductMovements(data({ salesOrders: [sales('one', 0.1), sales('two', 0.2)], commissions: [commission('one', 0.333333, 0.1), commission('two', 0.333333, 0.2)] }), true)
    expect(statement.entries[0]).toMatchObject({ quantity: 0.3, totalProductCommission: 0.1 })
    expect(statement.quantityTotals[0].quantity).toBe(0.3)
  })
  it('includes signed commission reconciliations without adding physical movement rows', () => {
    const statement = buildPartnerProductMovements(data({ salesOrders: [sales('adjusted', 5)],
      commissions: [commission('adjusted', 2, 2), commission('adjusted', 2, 3, { id: 'adjustment', kind: 'adjustment' }),
        commission('adjusted', 2, -1, { id: 'reversal', kind: 'reversal' })] }))
    expect(statement.quantityTotals[0].quantity).toBe(5)
    expect(statement.commissionTotals).toEqual([{ currency: 'usd', amount: 8 }])
    expect(statement.entries.find(row => row.commissionPerProduct === null)?.quantity).toBe(1)
  })
  it('ignores deleted, cross-workspace and invalid quantities and corrupted commission snapshots', () => {
    const statement = buildPartnerProductMovements(data({ salesOrders: [sales('deleted', 2, { isDeleted: true }), sales('foreign', 2, { workspaceId: 'other' }), sales('nan', NaN), sales('negative', -2), sales('valid', 1)], commissions: [commission('valid', 2, NaN)] }))
    expect(statement.entries).toHaveLength(1)
    expect(statement.entries[0]).toMatchObject({ quantity: 1, commissionPerProduct: null })
    expect(statement.hasCommission).toBe(false)
  })
  it('deduplicates financed POS, includes return and exchange sides, and ignores unrelated sales', () => {
    const source = data({
      loans: [{ ...entity, id: 'loan1', saleId: 'pos', linkedPartyType: 'business_partner', linkedPartyId: 'partner' } as never,
        { ...entity, id: 'loan2', saleId: 'pos', linkedPartyType: 'business_partner', linkedPartyId: 'partner' } as never],
      sales: [{ ...entity, id: 'pos', sequenceId: 6, settlementCurrency: 'usd' } as never, { ...entity, id: 'unrelated', settlementCurrency: 'usd' } as never],
      saleItems: [{ ...entity, id: 'pos-line', saleId: 'pos', productId: 'a', quantity: 3, returnedQuantity: 1 } as never,
        { ...entity, id: 'unrelated-line', saleId: 'unrelated', productId: 'a', quantity: 100 } as never],
      products: [{ ...entity, id: 'a', name: 'Product A', unit: 'Box' } as never, { ...entity, id: 'b', name: 'Product B', unit: 'Piece' } as never],
      saleReturns: [{ ...entity, id: 'pos-return', saleId: 'pos', status: 'posted', returnedAt: '2026-09-10T10:00:00Z', reason: 'Exchange' } as never],
      saleReturnItems: [{ ...entity, id: 'pos-return-line', returnId: 'pos-return', saleId: 'pos', saleItemId: 'pos-line', quantity: 1 } as never],
      exchanges: [{ ...entity, id: 'exchange', saleId: 'pos', returnId: 'pos-return', returnSaleItemId: 'pos-line', replacementProductId: 'b', replacementQuantity: 2, settlementCurrency: 'usd', exchangedAt: '2026-09-10T10:00:00Z', status: 'posted' } as never]
    })
    const statement = buildPartnerProductMovements(source)
    expect(statement.entries).toHaveLength(3)
    expect(statement.quantityTotals).toEqual(expect.arrayContaining([{ direction: 'sold', unit: 'Box', quantity: 2 }, { direction: 'sold', unit: 'Piece', quantity: 2 }]))
    expect(statement.commissionTotals).toEqual([])
  })
  it('respects redacted POS lines and storage exclusions for returns and exchange replacements', () => {
    const source = data({ canAccessStorage: storageId => storageId !== 'excluded',
      loans: [{ ...entity, id: 'loan', saleId: 'pos', linkedPartyType: 'business_partner', linkedPartyId: 'partner' } as never],
      sales: [{ ...entity, id: 'pos', settlementCurrency: 'usd', _enrichedItems: [{ id: 'visible' }] } as never],
      saleItems: [{ ...entity, id: 'visible', saleId: 'pos', productId: 'a', storageId: 'allowed', quantity: 2 } as never,
        { ...entity, id: 'hidden', saleId: 'pos', productId: 'a', storageId: 'allowed', quantity: 100 } as never],
      saleReturns: [{ ...entity, id: 'return', saleId: 'pos', status: 'posted', returnedAt: '2026-09-10T10:00:00Z' } as never],
      saleReturnItems: [{ ...entity, id: 'return-line', returnId: 'return', saleId: 'pos', saleItemId: 'visible', quantity: 1, restoredStorageId: 'excluded' } as never],
      exchanges: [{ ...entity, id: 'exchange', saleId: 'pos', returnSaleItemId: 'visible', replacementProductId: 'b', replacementStorageId: 'excluded', replacementQuantity: 5, settlementCurrency: 'usd', status: 'posted' } as never]
    })
    const statement = buildPartnerProductMovements(source)
    expect(statement.entries).toHaveLength(1)
    expect(statement.entries[0].quantity).toBe(2)
  })
})
