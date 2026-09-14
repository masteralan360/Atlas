import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const eventTarget = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined
  })
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('document', {
    ...eventTarget,
    visibilityState: 'visible',
    documentElement: {}
  })
  vi.stubGlobal('window', { ...eventTarget, location: { hash: '' } })
})

import type { Inventory, Product, PurchaseOrder, SalesOrder } from './models'
import {
  canAccessStorage,
  filterProductsByStorageAccess,
  redactPurchaseOrderForStorageAccess,
  redactSaleForStorageAccess,
  redactSalesOrderForStorageAccess,
  type StorageAccess
} from './storagePermissions'

const memberAccess: StorageAccess = {
  isAdmin: false,
  excludedStorageIds: new Set(['storage-a'])
}

function product(id: string, storageId: string | null, isService = false) {
  return {
    id,
    workspaceId: 'workspace-1',
    storageId,
    isService,
    isDeleted: false
  } as Product
}

function inventory(productId: string, storageId: string, quantity = 1) {
  return {
    id: `${productId}-${storageId}`,
    workspaceId: 'workspace-1',
    productId,
    storageId,
    quantity,
    isDeleted: false
  } as Inventory
}

describe('storage permissions', () => {
  it('keeps default access and removes only explicitly excluded storage rows', () => {
    expect(canAccessStorage('storage-a', memberAccess)).toBe(false)
    expect(canAccessStorage('storage-b', memberAccess)).toBe(true)
    expect(canAccessStorage('storage-a', { isAdmin: true, excludedStorageIds: new Set(['storage-a']) })).toBe(true)
    expect(canAccessStorage('storage-b', { isAdmin: false, excludedStorageIds: new Set(), isReady: false })).toBe(false)
  })

  it('keeps a product available when it has stock in another permitted storage', () => {
    const products = [
      product('only-excluded', 'storage-a'),
      product('also-permitted', 'storage-a'),
      product('service', null, true),
      product('unassigned', null)
    ]
    const visible = filterProductsByStorageAccess(products, [
      inventory('only-excluded', 'storage-a'),
      inventory('also-permitted', 'storage-b')
    ], memberAccess)

    expect(visible.map((row) => row.id)).toEqual(['also-permitted', 'service', 'unassigned'])
  })

  it('removes hidden sales-order lines and recomputes visible totals', () => {
    const order = {
      id: 'sales-order-1',
      sourceStorageId: 'storage-a',
      items: [
        { id: 'hidden', storageId: 'storage-a', lineTotal: 100 },
        { id: 'visible', storageId: 'storage-b', lineTotal: 50 }
      ],
      subtotal: 150,
      discount: 15,
      tax: 30,
      total: 165,
      paidAmount: 60,
      balanceAmount: 105,
      initialPaymentAmount: 30
    } as SalesOrder

    const visible = redactSalesOrderForStorageAccess(order, memberAccess)

    expect(visible).toMatchObject({
      items: [{ id: 'visible' }],
      subtotal: 50,
      discount: 5,
      tax: 10,
      total: 55,
      paidAmount: 20,
      balanceAmount: 35,
      initialPaymentAmount: 10
    })
  })

  it('hides an order that contains no permitted location lines', () => {
    const order = {
      id: 'purchase-order-1',
      destinationStorageId: 'storage-a',
      items: [{ id: 'hidden', storageId: 'storage-a', lineTotal: 10 }],
      subtotal: 10,
      discount: 0,
      total: 10,
      paidAmount: 0,
      balanceAmount: 10
    } as PurchaseOrder

    expect(redactPurchaseOrderForStorageAccess(order, memberAccess)).toBeNull()
  })

  it('does not expose an aggregate POS sale when RLS returned no visible line', () => {
    const sale = {
      id: 'sale-1',
      totalAmount: 99,
      _enrichedItems: []
    } as any

    expect(redactSaleForStorageAccess(sale, memberAccess)).toBeNull()
  })
})
