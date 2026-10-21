import 'fake-indexeddb/auto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/local-db/database'
import type { PurchaseOrderItem } from '@/local-db/models'
import type { CrudTraceHandle } from '@/dev/crud-debugger/trace'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { assertOrderFinancialEffects, assertStock } from '../assertions/orderEffects'
import { installTestBrowser } from '../fixtures/browser'
import { SERVICES_VIRTUAL_STORAGE_ID } from '@/lib/catalogItem'
import { setActiveBusinessUser, setActiveBusinessWorkspace } from '@/lib/network'
import { saleOrderInput, TEST_TIME, TEST_WORKSPACE_ID } from '../fixtures/orderInput'

vi.mock('@/auth/supabase', () => {
  const remote = () => { throw new Error('Unexpected remote request in a Local product UoM scenario') }
  return { supabase: { schema: () => ({ from: remote }), from: remote, rpc: remote } }
})

let orders: typeof import('@/local-db/orders')
let hooks: typeof import('@/local-db/hooks')
let partners: typeof import('@/local-db/businessPartners')
let replaceProductUoms: typeof import('@/local-db/productUoms').replaceProductUoms

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
    sku: `UOM-${quantity}`,
    name: 'UoM medicine',
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
  const uoms = await replaceProductUoms(TEST_WORKSPACE_ID, product.id, [
    { unitRef: 'builtin:sheet', unitCode: 'sheet', coefficient: 1, isBase: true, isActive: true,
      isDefaultSelling: false, sellingPrice: 2250, costPrice: 1000, minimumSellingPrice: null },
    { unitRef: 'builtin:carton', unitCode: 'carton', coefficient: 20, isBase: false, isActive: true,
      isDefaultSelling: true, sellingPrice: 40000, costPrice: 20000, minimumSellingPrice: 35000 },
  ])
  return { storage, product, carton: uoms.find((row) => row.unitCode === 'carton')! }
}

describe('product UoM conversion in order transactions', () => {
  beforeAll(async () => {
    installTestBrowser()
    orders = await import('@/local-db/orders')
    hooks = await import('@/local-db/hooks')
    partners = await import('@/local-db/businessPartners')
    replaceProductUoms = (await import('@/local-db/productUoms')).replaceProductUoms
  }, 30_000)

  beforeEach(async () => {
    await db.delete()
    await db.open()
    writeWorkspaceModeSnapshot({ workspaceId: TEST_WORKSPACE_ID, dataMode: 'local' })
    setActiveBusinessWorkspace(TEST_WORKSPACE_ID)
    setActiveBusinessUser('service-return-admin','admin',TEST_WORKSPACE_ID)
    await db.users.put({id:'service-return-admin',workspaceId:TEST_WORKSPACE_ID,name:'Service return administrator',
      email:'service-return@example.test',role:'admin',createdAt:TEST_TIME,updatedAt:TEST_TIME,
      version:1,isDeleted:false,syncStatus:'synced',lastSyncedAt:TEST_TIME})
  })

  afterEach(() => {
    clearWorkspaceModeSnapshot(TEST_WORKSPACE_ID)
    setActiveBusinessUser(null)
    setActiveBusinessWorkspace(null)
  })
  afterAll(async () => { await db.delete() })

  it('refunds partial and full service-only returns without a storage or inventory movement', async () => {
    const customer = await createPartner('customer', 'Service return customer')
    const { product } = await createPackagedProduct(100)
    const service = {...product,id:crypto.randomUUID(),sku:'RETURN-SERVICE',name:'Returnable service',
      isService:true,quantity:0,costPrice:0,storageId:null,storageName:undefined}
    await db.products.put(service)
    const input = saleOrderInput(customer.id,service,SERVICES_VIRTUAL_STORAGE_ID,'cash',{
      quantity:2,unitPrice:50,paid:true,
    })
    const draft = await orders.createSalesOrder(TEST_WORKSPACE_ID,input)
    await orders.updateSalesOrderStatus(draft.id,'pending')
    const completed = await orders.updateSalesOrderStatus(draft.id,'completed')
    await db.storages.clear()
    const beforeStock = await db.inventory.toArray()
    const beforeMovements = await db.inventory_transactions.toArray()
    const request = {orderId:completed.id,idempotencyKey:crypto.randomUUID(),
      items:[{orderItemId:completed.items[0].id,quantity:1}],reason:'customer_returned',actorRole:'admin'}
    const first = await orders.returnSalesOrder(request)
    expect(first.return.refundAmount).toBe(50)
    expect(first.items[0]).toMatchObject({selectedUnitQuantity:1,restoredStorageId:null,restoredBatchAllocations:[]})
    expect(first.order).toMatchObject({total:50,returnStatus:'partial'})
    expect((await orders.returnSalesOrder(request)).return.id).toBe(first.return.id)
    const last = await orders.returnSalesOrder({...request,idempotencyKey:crypto.randomUUID()})
    expect(last.return.refundAmount).toBe(50)
    expect(last.order).toMatchObject({total:0,returnStatus:'full'})
    expect(await db.inventory.toArray()).toEqual(beforeStock)
    expect(await db.inventory_transactions.toArray()).toEqual(beforeMovements)
    expect((await db.products.get(service.id))?.quantity).toBe(0)
    expect(await db.payment_transactions.where('sourceRecordId').equals(completed.id).toArray()).toEqual(
      expect.arrayContaining([expect.objectContaining({amount:100}),expect.objectContaining({amount:-50})]))
    await assertOrderFinancialEffects(completed.id,0,0)
    await expect(orders.returnSalesOrder({...request,idempotencyKey:crypto.randomUUID()})).rejects.toThrow()
  })

  it.each([true,false])('returns mixed product/service lines with only physical restocking (separate returns: %s)', async separate => {
    const customer = await createPartner('customer', 'Mixed return customer')
    const {product,storage,carton} = await createPackagedProduct(100)
    const service = {...product,id:crypto.randomUUID(),sku:'MIXED-SERVICE',name:'Mixed service',
      isService:true,quantity:0,costPrice:0,storageId:null,storageName:undefined}
    await db.products.put(service)
    const input = saleOrderInput(customer.id,product,storage.id,'cash',{quantity:2,unitPrice:100,paid:true})
    input.items[0]={...input.items[0],uomId:carton.id,unit:'carton',unitRef:'builtin:carton',
      baseUnitRef:'builtin:sheet',baseUnitCode:'sheet',unitFactor:20,inventoryQuantity:40}
    const serviceInput = saleOrderInput(customer.id,service,storage.id,'cash',{quantity:2,unitPrice:50,paid:true})
    // Old orders may retain the order's physical source on their service line.
    input.items.push(serviceInput.items[0])
    input.total=300; input.subtotal=300; input.paidAmount=300
    const draft = await orders.createSalesOrder(TEST_WORKSPACE_ID,input)
    await orders.updateSalesOrderStatus(draft.id,'pending')
    const completed = await orders.updateSalesOrderStatus(draft.id,'completed')
    const serviceLine=completed.items.find(item=>item.productId===service.id)!
    const productLine=completed.items.find(item=>item.productId===product.id)!
    await assertStock(product.id,storage.id,60)
    if (!separate) {
      const result=await orders.returnSalesOrder({orderId:completed.id,items:[
        {orderItemId:serviceLine.id,quantity:2},{orderItemId:productLine.id,quantity:2}],
        reason:'customer_returned',actorRole:'admin'})
      expect(result.return.refundAmount).toBe(300)
      expect(result.items.find(item=>item.orderItemId===serviceLine.id)).toMatchObject({restoredStorageId:null,restoredBatchAllocations:[]})
      await assertStock(product.id,storage.id,100)
      expect(await db.inventory_transactions.where('referenceId').equals(result.return.id).toArray()).toEqual([
        expect.objectContaining({productId:product.id,quantityDelta:40})])
      expect(await db.inventory.where('productId').equals(service.id).count()).toBe(0)
      await assertOrderFinancialEffects(completed.id,0,0)
      return
    }
    const serviceReturn=await orders.returnSalesOrder({orderId:completed.id,
      items:[{orderItemId:serviceLine.id,quantity:2}],reason:'customer_returned',actorRole:'admin'})
    expect(serviceReturn.return.refundAmount).toBe(100)
    expect(serviceReturn.items[0]).toMatchObject({restoredStorageId:null,restoredBatchAllocations:[]})
    await assertStock(product.id,storage.id,60)
    expect(await db.inventory_transactions.where('referenceId').equals(serviceReturn.return.id).count()).toBe(0)
    const physicalReturn=await orders.returnSalesOrder({orderId:completed.id,
      items:[{orderItemId:productLine.id,quantity:2}],reason:'customer_returned',actorRole:'admin'})
    expect(physicalReturn.return.refundAmount).toBe(200)
    expect(physicalReturn.items[0]).toMatchObject({restoredStorageId:storage.id,quantity:40})
    await assertStock(product.id,storage.id,100)
    expect(await db.inventory_transactions.where('referenceId').equals(physicalReturn.return.id).toArray()).toEqual([
      expect.objectContaining({productId:product.id,quantityDelta:40})])
    expect(await db.inventory.where('productId').equals(service.id).count()).toBe(0)
    await assertOrderFinancialEffects(completed.id,0,0)
  })

  it('returns a service from a legacy unpaid completed order without creating a cash refund or stock', async () => {
    const customer=await createPartner('customer','Legacy unpaid service customer')
    const {product}=await createPackagedProduct(100)
    const service={...product,id:crypto.randomUUID(),sku:'UNPAID-SERVICE',name:'Unpaid service',isService:true,quantity:0,costPrice:0}
    await db.products.put(service)
    const draft=await orders.createSalesOrder(TEST_WORKSPACE_ID,
      saleOrderInput(customer.id,service,SERVICES_VIRTUAL_STORAGE_ID,'cash',{unitPrice:50}))
    await db.sales_orders.put({...draft,status:'completed'})
    const result=await orders.returnSalesOrder({orderId:draft.id,items:[{orderItemId:draft.items[0].id,quantity:1}],
      reason:'customer_returned',actorRole:'admin'})
    expect(result.order).toMatchObject({total:0,balanceAmount:0,returnStatus:'full'})
    expect(result.items[0].restoredStorageId).toBeNull()
    expect(await db.payment_transactions.where('sourceRecordId').equals(draft.id).count()).toBe(0)
    expect(await db.inventory.where('productId').equals(service.id).count()).toBe(0)
  })

  it('reduces financed service debt and reverses its actual repayment on a full return without touching inventory', async () => {
    const customer=await createPartner('customer','Financed service customer')
    const {product}=await createPackagedProduct(100)
    const service={...product,id:crypto.randomUUID(),sku:'FINANCED-SERVICE',name:'Financed service',isService:true,quantity:0,costPrice:0}
    await db.products.put(service)
    const draft=await orders.createSalesOrder(TEST_WORKSPACE_ID,
      saleOrderInput(customer.id,service,SERVICES_VIRTUAL_STORAGE_ID,'loan',{quantity:2,unitPrice:50}))
    await orders.updateSalesOrderStatus(draft.id,'pending')
    const completed=await orders.updateSalesOrderStatus(draft.id,'completed')
    await hooks.recordLoanPayment(TEST_WORKSPACE_ID,{loanId:completed.linkedLoanId!,amount:30,paymentMethod:'cash',paidAt:TEST_TIME})
    const request={orderId:completed.id,items:[{orderItemId:completed.items[0].id,quantity:1}],reason:'customer_returned',actorRole:'admin'}
    await orders.returnSalesOrder(request)
    expect(await db.loans.get(completed.linkedLoanId!)).toMatchObject({principalAmount:50,totalPaidAmount:30,balanceAmount:20})
    const last=await orders.returnSalesOrder(request)
    expect(last.order).toMatchObject({total:0,balanceAmount:0,returnStatus:'full'})
    expect((await db.loans.get(completed.linkedLoanId!))?.balanceAmount).toBe(0)
    expect((await db.payment_transactions.where('sourceRecordId').equals(completed.linkedLoanId!).toArray())
      .map(row=>row.amount).sort((a,b)=>a-b)).toEqual([-30,30])
    expect(await db.inventory.where('productId').equals(service.id).count()).toBe(0)
    expect(await db.inventory_transactions.where('productId').equals(service.id).count()).toBe(0)
  })

  it('sells cartons, deducts sheets, and returns paid and free quantities independently', async () => {
    const customer = await createPartner('customer', 'UoM customer')
    const { product, storage, carton } = await createPackagedProduct(100)
    const input = saleOrderInput(customer.id, product, storage.id, 'cash', {
      currency: 'iqd',
      quantity: 2,
      unitPrice: 40_000,
      paid: true,
    })
    input.items[0] = {
      ...input.items[0],
      unit: 'carton',
      uomId: carton.id,
      uomNameSnapshot: 'Carton',
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
      uomCostPrice: 20_000,
      convertedUomCostPrice: 20_000,
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
      uomId: carton.id,
      uomNameSnapshot: 'Carton',
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
      uomId: carton.id,
      unitRef: 'builtin:carton',
      unitFactor: 20,
      inventoryQuantity: 40,
      freeBonusInventoryQuantity: 20,
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
    const { product, storage, carton } = await createPackagedProduct(50)
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
        uomId: carton.id,
        uomNameSnapshot: 'Carton',
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
      `Not enough stock is available for UoM medicine. `
      + `On hand: 50 sheet; reserved: 40 sheet; available: 10 sheet; required: 20 sheet. `
      + `Reserved by sales orders: ${existingReservation.orderNumber} (40 sheet).`
    )
    expect((await db.sales_orders.get(blockedOrder.id))?.status).toBe('draft')
    await assertStock(product.id, storage.id, 50)
  })

  it('validates stock with a constant number of reads as pending reservation lines grow', async () => {
    const customer = await createPartner('customer', 'Batch reservation customer')
    const { product, storage } = await createPackagedProduct(1_000)
    const input = saleOrderInput(customer.id, product, storage.id, 'cash', { quantity: 1, paid: true })
    const draft = await orders.createSalesOrder(TEST_WORKSPACE_ID, input)
    // Repeated relevant lines reproduce the old per-line product-read delay.
    // Other statuses and workspaces must never reduce this order's stock.
    const reservations = Array.from({ length: 40 }, (_, index) => ({
      ...draft, id: `reservation-${index}`, orderNumber: `RES-${index}`, status: 'pending' as const,
      items: Array.from({ length: 20 }, (_, line) => ({ ...draft.items[0], id: `line-${index}-${line}` })),
    }))
    await db.sales_orders.bulkPut([
      ...reservations,
      { ...draft, id: 'cancelled-order', status: 'cancelled', items: [{ ...draft.items[0], quantity: 10_000 }] },
      { ...draft, id: 'foreign-order', workspaceId: 'other-workspace', status: 'pending', items: [{ ...draft.items[0], quantity: 10_000 }] },
    ])
    let checkedStock = false
    const trace: CrudTraceHandle = {
      id: 'reservation-batch-test',
      setEntityId: () => undefined,
      setWorkspaceMode: () => undefined,
      addPendingStage: () => undefined,
      measure: async (label, _layer, work) => {
        if (label !== 'crudDebugger.stages.salesOrderStockAvailability') return work()
        checkedStock = true
        const productReads = vi.spyOn(db.products, 'get')
        const inventoryQueries = vi.spyOn(db.inventory, 'where')
        try {
          const result = await work()
          expect(productReads).not.toHaveBeenCalled()
          expect(inventoryQueries).toHaveBeenCalledTimes(1)
          return result
        } finally {
          productReads.mockRestore()
          inventoryQueries.mockRestore()
        }
      },
    }

    expect((await orders.updateSalesOrderStatus(draft.id, 'pending', { trace })).status).toBe('pending')
    expect(checkedStock).toBe(true)
    await assertStock(product.id, storage.id, 1_000)
  })

  it('receives cartons and free cartons as sheets while spreading paid cost across all received stock', async () => {
    const supplier = await createPartner('supplier', 'UoM supplier')
    const { product, storage, carton } = await createPackagedProduct(0)
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
        uomId: carton.id,
        uomNameSnapshot: 'Carton',
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

  it('keeps fractional paid and bonus receipt quantities as the sum of their rounded base quantities', async () => {
    const supplier = await createPartner('supplier', 'Fractional UoM supplier')
    const { product, storage } = await createPackagedProduct(0)
    const uoms = await replaceProductUoms(TEST_WORKSPACE_ID, product.id, [
      { unitRef: 'builtin:sheet', unitCode: 'sheet', coefficient: 1, isBase: true, isActive: true,
        isDefaultSelling: false, sellingPrice: 2250, costPrice: 1000, minimumSellingPrice: null },
      { unitRef: 'builtin:meter', unitCode: 'Meter', coefficient: 0.333333, isBase: false, isActive: true,
        isDefaultSelling: true, sellingPrice: 10, costPrice: 1, minimumSellingPrice: null },
    ])
    const uom = uoms.find((row) => row.unitRef === 'builtin:meter')!
    const item: PurchaseOrderItem = {
      id: crypto.randomUUID(),
      productId: product.id,
      storageId: storage.id,
      productName: product.name,
      productSku: product.sku,
      unit: 'Meter',
      uomId: uom.id,
      uomNameSnapshot: 'Meter',
      unitRef: uom.unitRef,
      unitNameSnapshot: 'Meter',
      baseUnitRef: 'builtin:sheet',
      baseUnitCode: 'sheet',
      baseUnitNameSnapshot: 'Sheet',
      unitFactor: 0.333333,
      quantity: 0.001,
      freeBonusQuantity: 0.001,
      inventoryQuantity: 0.000333,
      freeBonusInventoryQuantity: 0.000333,
      receivedQuantity: 0.000666,
      lineTotal: 0,
      originalCurrency: 'iqd',
      originalUnitPrice: 0,
      convertedUnitPrice: 0,
      settlementCurrency: 'iqd',
      batchNumber: null,
      batchSalePrice: product.price,
      batchExpiryDate: null,
      batchManufacturingDate: null,
    }
    const order = await orders.createPurchaseOrder(TEST_WORKSPACE_ID, {
      businessPartnerId: supplier.id,
      supplierId: supplier.id,
      supplierName: supplier.partnerName,
      destinationStorageId: storage.id,
      items: [item],
      subtotal: 0,
      discount: 0,
      total: 0,
      currency: 'iqd',
      exchangeRate: null,
      exchangeRateSource: null,
      exchangeRateTimestamp: null,
      exchangeRates: null,
      status: 'received',
      expectedDeliveryDate: null,
      actualDeliveryDate: null,
      isPaid: true,
      paymentStatus: 'paid',
      paidAmount: 0,
      balanceAmount: 0,
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
    const received = order

    expect(received.items[0].receivedQuantity).toBe(0.000666)
    expect(await db.inventory.where('[productId+storageId]').equals([product.id, storage.id]).first())
      .toMatchObject({ quantity: 0.000666 })
    expect(await db.inventory_transactions.where('referenceId').equals(order.id).first())
      .toMatchObject({ quantityDelta: 0.000666, newQuantity: 0.000666 })
  })
})
