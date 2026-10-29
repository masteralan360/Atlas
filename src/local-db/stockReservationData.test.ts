import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'
import { assertLocalStockDemands, readLocalStockAvailability } from './stockReservationData'
import type { Product, SalesOrder } from './models'

const ws='local-stock-reservation-test'
const base={workspaceId:ws,createdAt:'2026-10-29T10:00:00Z',updatedAt:'2026-10-29T10:00:00Z',version:1,isDeleted:false,syncStatus:'synced' as const,lastSyncedAt:null}
const product={...base,id:'product',name:'Chairs',unit:'pcs',quantity:100,isService:false} as Product
const order={...base,id:'order',orderNumber:'SO-001',status:'pending',sourceStorageId:'storage',items:[{id:'line',productId:'product',quantity:70}]} as SalesOrder
describe('indexed Local reservation availability',()=>{
  beforeAll(()=>installTestBrowser())
  beforeEach(async()=>{
    installTestBrowser();await db.delete();await db.open();writeWorkspaceModeSnapshot({workspaceId:ws,dataMode:'local'})
    await db.products.put(product)
    await db.inventory.put({...base,id:'inventory',productId:'product',storageId:'storage',quantity:100})
    await db.sales_orders.put(order)
  })
  afterEach(()=>clearWorkspaceModeSnapshot(ws))
  afterAll(async()=>{await db.delete()})
  it('shows on-hand, reserved and sellable quantities and allows an order to use its own stock',async()=>{
    expect(await readLocalStockAvailability(ws,[{productId:'product',storageId:'storage'}])).toEqual([{productId:'product',storageId:'storage',onHand:100,reserved:70,available:30}])
    await assertLocalStockDemands(ws,[{productId:'product',storageId:'storage',quantity:30}])
    await assertLocalStockDemands(ws,[{productId:'product',storageId:'storage',quantity:70}],'order')
  })
  it('aggregates duplicate cart lines before validating',async()=>{
    await expect(assertLocalStockDemands(ws,[{productId:'product',storageId:'storage',quantity:20},{productId:'product',storageId:'storage',quantity:20}])).rejects.toMatchObject({code:'STOCK_RESERVED',conflict:{required:40,available:30}})
  })
  it('excludes drafts, cancellations, deleted rows and other workspaces',async()=>{
    await db.sales_orders.update(order.id,{status:'cancelled'})
    for(const row of [{...order,id:'draft',status:'draft'},{...order,id:'deleted',isDeleted:true},{...order,id:'foreign',workspaceId:'foreign'}]) await db.sales_orders.put(row as SalesOrder)
    expect((await readLocalStockAvailability(ws,[{productId:'product',storageId:'storage'}]))[0].reserved).toBe(0)
  })
  it('counts free quantities and unit conversions and separates storages',async()=>{
    await db.sales_orders.update(order.id,{items:[{...order.items[0],quantity:2,unitFactor:20,inventoryQuantity:40,freeBonusQuantity:1,freeBonusInventoryQuantity:20}]})
    const rows=await readLocalStockAvailability(ws,[{productId:'product',storageId:'storage'},{productId:'product',storageId:'another-storage'}])
    expect(rows[0]).toMatchObject({reserved:60,available:40});expect(rows[1].reserved).toBe(0)
  })
  it('does not apply physical reservations to services',async()=>{
    await db.products.update(product.id,{isService:true})
    await assertLocalStockDemands(ws,[{productId:'product',storageId:'storage',quantity:1000}])
  })
})
