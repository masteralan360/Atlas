import { describe, expect, it } from 'vitest'

import type { SalesOrder } from '@/local-db'

import { filterRevenueRecordsByStorage, getRevenueAnalysisTotals, getRevenueProductSalesSummary, getRevenueRecordReturnSummary, toRevenueRecordFromSale, toRevenueRecordFromSalesOrder, type RevenueAnalysisRecord } from './revenueAnalysis'

describe('sales order revenue analysis', () => {
  it('treats a post-service projection as fee revenue, not COD revenue', () => {
    const record = toRevenueRecordFromSale({
      id: 'shipment-1',
      origin: 'post_service',
      created_at: '2026-08-15T12:00:00.000Z',
      settlement_currency: 'iqd',
      cashier_name: 'Delivery service',
      items: [{
        product_id: 'delivery_service_fee',
        product_name: 'Delivery service · PST-0001',
        quantity: 1,
        converted_unit_price: 5000,
        converted_cost_price: 0,
      }]
    } as any)

    expect(record.source).toBe('post_service')
    expect(getRevenueAnalysisTotals(record)).toEqual({ revenue: 5000, cost: 0, profit: 5000, margin: 100 })
  })

  it('charges revenue on paid quantity and cost on paid plus free bonus quantity', () => {
    const order = {
      id: 'order-1',
      orderNumber: 'SO-1',
      customerId: 'customer-1',
      customerName: 'Customer',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      currency: 'usd',
      status: 'completed',
      isDeleted: false,
      total: 50,
      items: [{
        id: 'line-1',
        productId: 'product-1',
        productName: 'Product',
        productSku: 'SKU-1',
        quantity: 5,
        freeBonusQuantity: 2,
        lineTotal: 50,
        originalCurrency: 'usd',
        originalUnitPrice: 10,
        convertedUnitPrice: 10,
        settlementCurrency: 'usd',
        costPrice: 4,
        convertedCostPrice: 4
      }]
    } as SalesOrder

    const totals = getRevenueAnalysisTotals(toRevenueRecordFromSalesOrder(order))

    expect(totals.revenue).toBe(50)
    expect(totals.cost).toBe(28)
    expect(totals.profit).toBe(22)
  })

  it('deducts returned order quantities and exposes the partial return in analytics', () => {
    const order = {
      id: 'order-returned-1',
      orderNumber: 'SO-RETURN-1',
      customerId: 'customer-1',
      customerName: 'Customer',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      currency: 'usd',
      status: 'completed',
      returnStatus: 'partial',
      isDeleted: false,
      total: 30,
      items: [{
        id: 'line-1',
        productId: 'product-1',
        productName: 'Product',
        productSku: 'SKU-1',
        quantity: 5,
        lineTotal: 50,
        originalCurrency: 'usd',
        originalUnitPrice: 10,
        convertedUnitPrice: 10,
        settlementCurrency: 'usd',
        costPrice: 4,
        convertedCostPrice: 4,
        returnedQuantity: 2
      }]
    } as SalesOrder

    const record = toRevenueRecordFromSalesOrder(order)
    const totals = getRevenueAnalysisTotals(record)

    expect(totals).toMatchObject({ revenue: 30, cost: 12, profit: 18 })
    expect(getRevenueRecordReturnSummary(record)).toMatchObject({
      isFullyReturned: false,
      hasAnyReturn: true,
      totalReturnedQuantity: 2
    })
  })

  it('uses paid returns for related-unit revenue and total returned stock for cost', () => {
    const order = {
      id: 'order-related-return',
      orderNumber: 'SO-RELATED-RETURN',
      customerId: 'customer-1',
      customerName: 'Customer',
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      currency: 'iqd',
      status: 'completed',
      returnStatus: 'partial',
      isDeleted: false,
      total: 40_000,
      items: [{
        id: 'line-related',
        productId: 'product-1',
        productName: 'Medicine',
        productSku: 'MED-1',
        quantity: 2,
        freeBonusQuantity: 1,
        unitFactor: 20,
        inventoryQuantity: 40,
        freeBonusInventoryQuantity: 20,
        returnedQuantity: 40,
        returnedPaidInventoryQuantity: 20,
        returnedFreeInventoryQuantity: 20,
        lineTotal: 80_000,
        originalCurrency: 'iqd',
        originalUnitPrice: 40_000,
        convertedUnitPrice: 40_000,
        settlementCurrency: 'iqd',
        costPrice: 1_000,
        convertedCostPrice: 1_000
      }]
    } as SalesOrder

    const record = toRevenueRecordFromSalesOrder(order)
    expect(record.items[0]).toMatchObject({
      quantity: 2,
      returnedQuantity: 1,
      costQuantity: 60,
      returnedCostQuantity: 40
    })
    expect(getRevenueAnalysisTotals(record)).toMatchObject({
      revenue: 40_000,
      cost: 20_000,
      profit: 20_000
    })
  })

  it('excludes a fully returned order from revenue totals', () => {
    const order = {
      id: 'order-returned-2',
      orderNumber: 'SO-RETURN-2',
      customerId: 'customer-1',
      customerName: 'Customer',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      currency: 'usd',
      status: 'completed',
      returnStatus: 'full',
      isDeleted: false,
      total: 0,
      items: [{
        id: 'line-1',
        productId: 'product-1',
        productName: 'Product',
        productSku: 'SKU-1',
        quantity: 5,
        lineTotal: 50,
        originalCurrency: 'usd',
        originalUnitPrice: 10,
        convertedUnitPrice: 10,
        settlementCurrency: 'usd',
        costPrice: 4,
        convertedCostPrice: 4,
        returnedQuantity: 5
      }]
    } as SalesOrder

    expect(getRevenueAnalysisTotals(toRevenueRecordFromSalesOrder(order))).toMatchObject({
      revenue: 0,
      cost: 0,
      profit: 0
    })
  })

  it('summarizes distinct products and net units while preserving the selected sale count', () => {
    const records: RevenueAnalysisRecord[] = [
      {
        key: 'sale:1', id: '1', source: 'sale', referenceCode: 'S-1', date: '2026-01-01T00:00:00.000Z', currency: 'usd', origin: 'pos', cashier: 'Staff', hasPartialReturn: true, isReturned: false,
        items: [
          { productId: 'product-a', productName: 'Product A', quantity: 5, returnedQuantity: 2, unitPrice: 10, costPrice: 4 },
          { productId: 'product-b', productName: 'Product B', quantity: 1, returnedQuantity: 1, unitPrice: 10, costPrice: 4 }
        ]
      },
      {
        key: 'sale:2', id: '2', source: 'sale', referenceCode: 'S-2', date: '2026-01-02T00:00:00.000Z', currency: 'usd', origin: 'pos', cashier: 'Staff', hasPartialReturn: false, isReturned: false,
        items: [{ productId: 'product-a', productName: 'Product A', quantity: 2, returnedQuantity: 0, unitPrice: 10, costPrice: 4 }]
      },
      {
        key: 'sale:3', id: '3', source: 'sale', referenceCode: 'S-3', date: '2026-01-03T00:00:00.000Z', currency: 'usd', origin: 'pos', cashier: 'Staff', hasPartialReturn: false, isReturned: true,
        items: [{ productId: 'product-c', productName: 'Product C', quantity: 4, returnedQuantity: 0, unitPrice: 10, costPrice: 4 }]
      }
    ]

    expect(getRevenueProductSalesSummary(records)).toEqual({
      totalSales: 3,
      productsSold: 1,
      unitsSold: 5
    })
  })

  it('scopes mixed-storage sales to matching line items before calculating totals', () => {
    const records: RevenueAnalysisRecord[] = [{
      key: 'sale:storage-mix',
      id: 'storage-mix',
      source: 'sale',
      referenceCode: 'S-STORAGE',
      date: '2026-01-01T00:00:00.000Z',
      currency: 'usd',
      origin: 'pos',
      cashier: 'Staff',
      hasPartialReturn: false,
      isReturned: false,
      items: [
        { productId: 'product-a', productName: 'Product A', storageId: 'storage-a', quantity: 2, returnedQuantity: 0, unitPrice: 10, costPrice: 4 },
        { productId: 'product-b', productName: 'Product B', storageId: 'storage-b', quantity: 3, returnedQuantity: 0, unitPrice: 20, costPrice: 8 }
      ]
    }]

    const storageARecords = filterRevenueRecordsByStorage(records, 'storage-a')

    expect(storageARecords).toHaveLength(1)
    expect(storageARecords[0].items).toHaveLength(1)
    expect(getRevenueAnalysisTotals(storageARecords[0])).toMatchObject({
      revenue: 20,
      cost: 8,
      profit: 12
    })
    expect(filterRevenueRecordsByStorage(records, 'storage-missing')).toEqual([])
  })
})
