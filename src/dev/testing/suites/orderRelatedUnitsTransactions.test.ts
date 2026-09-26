import 'fake-indexeddb/auto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/local-db/database'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { assertOrderFinancialEffects, assertStock } from '../assertions/saleOrders'
import { installTestBrowser } from '../fixtures/browser'
import { saleOrderInput, TEST_TIME, TEST_WORKSPACE_ID } from '../fixtures/saleOrder'

vi.mock('@/auth/supabase', () => {
  const remote = () => { throw new Error('Unexpected remote request in a Local related-unit scenario') }
  return { supabase: { schema: () => ({ from: remote }), from: remote, rpc: remote } }
})

let orders: typeof import('@/local-db/orders')
let hooks: typeof import('@/local-db/hooks')
let partners: typeof import('@/local-db/businessPartners')

async function createPartner(role: 'customer' | 'supplier', name: string) {
  return partners.createBusinessPartner(TEST_WORKSPACE_ID, {
    partnerName: name,
    phone: role === 'customer' ? '07500000071' : '07500000072',
    defaultCurrency: 'iqd',
    creditLimit: 0,
    receivableCreditLimit: null,
    payableCreditLimit: null,
    role,
  })
}

async function createPackagedProduct(quantity: number) {
  const storage = await hooks.createStorage(TEST_WORKSPACE_ID, { name: `Related-unit stock ${quantity}` })
  const product = await hooks.createProduct(TEST_WORKSPACE_ID, {
    sku: `RELATED-${quantity}`,
    name: 'Related-unit medicine',
    description: '',
    categoryId: null,
    category: null,
    storageId: storage.id,
    storageName: storage.name,
    price: 2_250,
    costPrice: 1_000,
    quantity,
    minStockLevel: 0,
    unit: 'sheet',
    currency: 'iqd',
    barcode: '',
    barcodes: [],
    imageUrl: '',
    canBeReturned: true,
    returnRules: '',
    createdBy: null,
  })
  return { storage, product }
}

describe('related units in order transactions', () => {
  beforeAll(async () => {
    installTestBrowser()
    orders = await import('@/local-db/orders')
    hooks = await import('@/local-db/hooks')
    partners = await import('@/local-db/businessPartners')
  }, 30_000)

  beforeEach(async () => {
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: TEST_WORKSPACE_ID, dataMode: 'local' })
  })

  afterEach(() => clearWorkspaceModeSnapshot(TEST_WORKSPACE_ID))
  afterAll(async () => { await db.delete() })

  it('sells cartons, deducts sheets, and returns paid and free quantities independently', async () => {
    const customer = await createPartner('customer', 'Related-unit customer')
    const { product, storage } = await createPackagedProduct(100)
    const input = saleOrderInput(customer.id, product, storage.id, 'cash', {
      currency: 'iqd',
      quantity: 2,
      unitPrice: 40_000,
      paid: true,
    })
    input.items[0] = {
      ...input.items[0],
      unit: 'carton',
      unitRelationshipId: '00000000-0000-4000-8000-000000000071',
      unitRef: 'builtin:carton',
      unitNameSnapshot: 'Carton',
      baseUnitRef: 'builtin:sheet',
      baseUnitCode: 'sheet',
      baseUnitNameSnapshot: 'Sheet',
      unitFactor: 20,
      quantity: 2,
      freeBonusQuantity: 1,
      inventoryQuantity: 40,
      freeBonusInventoryQuantity: 20,
      lineTotal: 80_000,
      originalCurrency: 'iqd',
      originalUnitPrice: 40_000,
      convertedUnitPrice: 40_000,
      settlementCurrency: 'iqd',
      costPrice: 1_000,
      convertedCostPrice: 1_000,
    }
    input.subtotal = 80_000
    input.total = 80_000
    input.paidAmount = 80_000
    input.balanceAmount = 0

    const draft = await orders.createSalesOrder(TEST_WORKSPACE_ID, input)
    await orders.updateSalesOrderStatus(draft.id, 'pending')
    const completed = await orders.updateSalesOrderStatus(draft.id, 'completed')

    expect(completed.items[0]).toMatchObject({
      quantity: 2,
      unitRef: 'builtin:carton',
      unitFactor: 20,
      inventoryQuantity: 40,
      freeBonusInventoryQuantity: 20,
    })
    await assertStock(product.id, storage.id, 40)
    expect(await db.inventory_transactions.where('referenceId').equals(completed.id).first()).toMatchObject({
      transactionType: 'sale',
      quantityDelta: -60,
      previousQuantity: 100,
      newQuantity: 40,
      referenceType: 'sales_order',
    })

    const firstReturn = await orders.returnSalesOrder({
      orderId: completed.id,
      items: [{ orderItemId: completed.items[0].id, paidQuantity: 1, freeQuantity: 1 }],
      reason: 'customer_returned',
      actorRole: 'admin',
    })
    expect(firstReturn.items[0]).toMatchObject({
      selectedUnitQuantity: 2,
      paidSelectedUnitQuantity: 1,
      freeSelectedUnitQuantity: 1,
      inventoryQuantity: 40,
      paidInventoryQuantity: 20,
      freeInventoryQuantity: 20,
      unitRef: 'builtin:carton',
      unitFactor: 20,
      refundAmount: 40_000,
    })
    expect(firstReturn.order.items[0]).toMatchObject({
      returnedQuantity: 40,
      returnedPaidInventoryQuantity: 20,
      returnedFreeInventoryQuantity: 20,
    })
    await assertOrderFinancialEffects(completed.id, 40_000, 0)
    await assertStock(product.id, storage.id, 80)
    expect(await db.inventory_transactions.where('referenceId').equals(firstReturn.return.id).first()).toMatchObject({
      transactionType: 'return',
      quantityDelta: 40,
      previousQuantity: 40,
      newQuantity: 80,
      referenceType: 'sales_order_return',
    })

    const finalReturn = await orders.returnSalesOrder({
      orderId: completed.id,
      items: [{ orderItemId: completed.items[0].id, paidQuantity: 1, freeQuantity: 0 }],
      reason: 'customer_returned',
      actorRole: 'admin',
    })
    await assertOrderFinancialEffects(completed.id, 0, 0)
    await assertStock(product.id, storage.id, 100)
    expect(await db.inventory_transactions.where('referenceId').equals(finalReturn.return.id).first()).toMatchObject({
      transactionType: 'return',
      quantityDelta: 20,
      previousQuantity: 80,
      newQuantity: 100,
      referenceType: 'sales_order_return',
    })
  })

  it('reports the reserving order in canonical inventory units when a carton reservation blocks another order', async () => {
    const customer = await createPartner('customer', 'Reservation customer')
    const { product, storage } = await createPackagedProduct(50)
    const makeInput = (quantity: number) => {
      const input = saleOrderInput(customer.id, product, storage.id, 'cash', {
        currency: 'iqd',
        quantity,
        unitPrice: 40_000,
        paid: true,
      })
      input.items[0] = {
        ...input.items[0],
        unit: 'carton',
        unitRelationshipId: '00000000-0000-4000-8000-000000000071',
        unitRef: 'builtin:carton',
        unitNameSnapshot: 'Carton',
        baseUnitRef: 'builtin:sheet',
        baseUnitCode: 'sheet',
        baseUnitNameSnapshot: 'Sheet',
        unitFactor: 20,
        quantity,
        inventoryQuantity: quantity * 20,
        freeBonusQuantity: 0,
        freeBonusInventoryQuantity: 0,
      }
      return input
    }

    const existingReservation = await orders.createSalesOrder(TEST_WORKSPACE_ID, makeInput(2))
    await orders.updateSalesOrderStatus(existingReservation.id, 'pending')
    const blockedOrder = await orders.createSalesOrder(TEST_WORKSPACE_ID, makeInput(1))

    const error = await orders.updateSalesOrderStatus(blockedOrder.id, 'pending')
      .then(() => null, (reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      `Not enough stock is available for Related-unit medicine. `
      + `On hand: 50 sheet; reserved: 40 sheet; available: 10 sheet; required: 20 sheet. `
      + `Reserved by sales orders: ${existingReservation.orderNumber} (40 sheet).`
    )
    expect((await db.sales_orders.get(blockedOrder.id))?.status).toBe('draft')
    await assertStock(product.id, storage.id, 50)
  })

  it('receives cartons and free cartons as sheets while spreading paid cost across all received stock', async () => {
    const supplier = await createPartner('supplier', 'Related-unit supplier')
    const { product, storage } = await createPackagedProduct(0)
    const itemId = crypto.randomUUID()

    const order = await orders.createPurchaseOrder(TEST_WORKSPACE_ID, {
      businessPartnerId: supplier.id,
      supplierId: supplier.id,
      supplierName: supplier.partnerName,
      destinationStorageId: storage.id,
      items: [{
        id: itemId,
        productId: product.id,
        storageId: storage.id,
        productName: product.name,
        productSku: product.sku,
        unit: 'carton',
        unitRelationshipId: '00000000-0000-4000-8000-000000000071',
        unitRef: 'builtin:carton',
        unitNameSnapshot: 'Carton',
        baseUnitRef: 'builtin:sheet',
        baseUnitCode: 'sheet',
        baseUnitNameSnapshot: 'Sheet',
        unitFactor: 20,
        quantity: 2,
        freeBonusQuantity: 1,
        inventoryQuantity: 40,
        freeBonusInventoryQuantity: 20,
        receivedQuantity: 60,
        lineTotal: 80_000,
        originalCurrency: 'iqd',
        originalUnitPrice: 40_000,
        convertedUnitPrice: 40_000,
        settlementCurrency: 'iqd',
        batchNumber: null,
        batchSalePrice: product.price,
        batchExpiryDate: null,
        batchManufacturingDate: null,
      }],
      subtotal: 80_000,
      discount: 0,
      total: 80_000,
      currency: 'iqd',
      exchangeRate: null,
      exchangeRateSource: null,
      exchangeRateTimestamp: null,
      exchangeRates: null,
      status: 'received',
      approvalStatus: null,
      approvalRequestedBy: null,
      approvalRequestedAt: null,
      approvalReviewedBy: null,
      approvalReviewedAt: null,
      expectedDeliveryDate: null,
      actualDeliveryDate: TEST_TIME,
      isPaid: true,
      paymentStatus: 'paid',
      paidAmount: 80_000,
      balanceAmount: 0,
      paidAt: TEST_TIME,
      paymentMethod: 'cash',
      initialPaymentAmount: 0,
      linkedLoanId: null,
      isInstallmentBased: false,
      installmentCount: 0,
      installmentFrequency: null,
      firstDueDate: null,
      nextDueDate: null,
      notes: '',
      isLocked: false,
      createdBy: null,
    })

    await assertStock(product.id, storage.id, 60)
    const transaction = await db.inventory_transactions.where('referenceId').equals(order.id).first()
    const batch = await db.stock_batches
      .where('[sourcePurchaseOrderId+sourcePurchaseOrderItemId]')
      .equals([order.id, itemId])
      .first()
    expect(transaction).toMatchObject({ quantityDelta: 60, newQuantity: 60 })
    expect(batch).toMatchObject({ quantity: 60, costPrice: 1_333.333, currency: 'iqd' })
  })
})
