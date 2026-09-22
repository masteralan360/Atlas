import { describe, expect, it, vi } from 'vitest'

vi.hoisted(async () => {
  const { installTestBrowser } = await import('@/dev/testing/fixtures/browser')
  installTestBrowser()
})

import type { Inventory, Product, PurchaseOrder, SalesOrder } from './models'
import { supabase } from '@/auth/supabase'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'
import {
  canAccessStorage,
  canAccessOrderForStorageAccess,
  filterProductsByStorageAccess,
  assertRecentCurrentUserCanAccessStorage,
  getCurrentStorageAccess,
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
  it('never restricts the active authenticated admin while membership cache is stale', async () => {
    const workspaceId = 'storage-access-admin-workspace'
    const fromSpy = vi.spyOn(supabase, 'from').mockImplementation((() => {
      throw new Error('An admin must not fetch member exclusions')
    }) as typeof supabase.from)
    try {
      setNetworkStatus(true)
      setActiveBusinessWorkspace(workspaceId)
      setActiveBusinessUser('storage-access-admin', 'admin', workspaceId)

      await expect(getCurrentStorageAccess(workspaceId)).resolves.toMatchObject({
        isAdmin: true,
        isReady: true
      })
      expect(fromSpy).not.toHaveBeenCalled()
    } finally {
      fromSpy.mockRestore()
      clearWorkspaceModeSnapshot(workspaceId)
      setActiveBusinessUser(null)
      setActiveBusinessWorkspace(null)
    }
  })

  it('uses the RLS-scoped cloud deny-list when local access caches are unavailable', async () => {
    const workspaceId = 'storage-access-staff-workspace'
    const userSpy = vi.spyOn(db.users, 'get').mockRejectedValue(new Error('users store unavailable'))
    const profileSpy = vi.spyOn(db.profiles, 'get').mockRejectedValue(new Error('profiles store unavailable'))
    const exclusionTransactionSpy = vi.spyOn(db, 'transaction')
    const fromSpy = vi.spyOn(supabase, 'from').mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [{
              id: 'storage-exclusion-1',
              workspace_id: workspaceId,
              storage_id: 'storage-a',
              user_id: 'storage-access-staff',
              is_deleted: false
            }],
            error: null
          })
        })
      })
    } as never)
    try {
      setNetworkStatus(true)
      setActiveBusinessWorkspace(workspaceId)
      setActiveBusinessUser('storage-access-staff', 'staff', workspaceId)

      await expect(getCurrentStorageAccess(workspaceId)).resolves.toMatchObject({
        isAdmin: false,
        isReady: true
      })
      expect(userSpy).not.toHaveBeenCalled()
      expect(profileSpy).not.toHaveBeenCalled()
      await expect(getCurrentStorageAccess(workspaceId)).resolves.toMatchObject({
        excludedStorageIds: new Set(['storage-a'])
      })
      expect(fromSpy).toHaveBeenCalledWith('storage_member_exclusions')
      expect(exclusionTransactionSpy).not.toHaveBeenCalled()
      expect(assertRecentCurrentUserCanAccessStorage(workspaceId, 'storage-b')).toBe(true)
      expect(() => assertRecentCurrentUserCanAccessStorage(workspaceId, 'storage-a')).toThrow()
    } finally {
      userSpy.mockRestore()
      profileSpy.mockRestore()
      exclusionTransactionSpy.mockRestore()
      fromSpy.mockRestore()
      clearWorkspaceModeSnapshot(workspaceId)
      setNetworkStatus(true)
      setActiveBusinessUser(null)
      setActiveBusinessWorkspace(null)
    }
  })

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
      sourceStorageId: null,
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

  it('allows an order whose explicit lines are permitted even if its legacy default storage is excluded', () => {
    const order = {
      id: 'sales-order-allowed',
      sourceStorageId: 'storage-a',
      items: [{ id: 'visible', storageId: 'storage-b', lineTotal: 50 }]
    } as SalesOrder

    expect(canAccessOrderForStorageAccess(order, memberAccess)).toBe(true)
  })

  it('does not treat a partially redacted order as actionable', () => {
    const order = {
      id: 'sales-order-mixed',
      sourceStorageId: 'storage-b',
      items: [
        { id: 'hidden', storageId: 'storage-a', lineTotal: 100 },
        { id: 'visible', storageId: 'storage-b', lineTotal: 50 }
      ]
    } as SalesOrder

    expect(canAccessOrderForStorageAccess(order, memberAccess)).toBe(false)
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
