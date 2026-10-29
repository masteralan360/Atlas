import initSqlJs, { type Database } from 'sql.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prepareSqliteReservationValidation } from './stockReservationsSqlite'
import type { LocalModeSqliteMutation, SqliteConnection } from './localModeSqlite'

let SQL: Awaited<ReturnType<typeof initSqlJs>>
let sqlite: Database
let connection: SqliteConnection
const ws='reservation-sqlite-workspace'
const inventory = { id:'stock', workspaceId:ws, productId:'product', storageId:'storage', quantity:100, isDeleted:false }
const order = { id:'order',workspaceId:ws,status:'pending',sourceStorageId:'storage',items:[{productId:'product',quantity:70}],isDeleted:false }
const mutation = (tableName: LocalModeSqliteMutation['tableName'],row:Record<string,unknown>):LocalModeSqliteMutation => ({type:'upsert',tableName,row,workspaceId:ws})
const put = (table:string,row:Record<string,unknown>) => sqlite.run('INSERT OR REPLACE INTO local_entities VALUES(?,?,?,?,?)',[table,String(row.id),ws,JSON.stringify(row),'now'])
async function commit(mutations:LocalModeSqliteMutation[]) {
  sqlite.run('BEGIN IMMEDIATE')
  try {
    const validate=await prepareSqliteReservationValidation(connection,mutations)
    for(const m of mutations) put(m.tableName,m.row)
    await validate()
    sqlite.run('COMMIT')
  } catch(error) { sqlite.run('ROLLBACK'); throw error }
}
describe('Local-mode authoritative SQLite reservation transactions',()=>{
  beforeAll(async()=>{ SQL=await initSqlJs() })
  beforeEach(()=>{
    sqlite=new SQL.Database()
    sqlite.run('CREATE TABLE local_entities(entity_type TEXT,entity_id TEXT,workspace_id TEXT,payload TEXT,updated_at TEXT,PRIMARY KEY(entity_type,entity_id)); CREATE INDEX scoped_entities ON local_entities(entity_type,workspace_id)')
    connection={execute:async(query,values=[])=>{sqlite.run(query,values as never);},select:async<T>(query:string,values:unknown[]=[])=>{
      const statement=sqlite.prepare(query);statement.bind(values as never);const rows=[];while(statement.step()) rows.push(statement.getAsObject());statement.free();return rows as T
    }}
    put('inventory',inventory);put('products',{id:'product',isService:false});put('sales_orders',order)
  })
  afterEach(()=>sqlite.close())
  it('rolls back stock and payment writes when another order owns the stock',async()=>{
    await expect(commit([mutation('payment_transactions',{id:'payment',amount:50}),mutation('inventory',{...inventory,quantity:60})])).rejects.toMatchObject({code:'STOCK_RESERVED'})
    expect(sqlite.exec("SELECT * FROM local_entities WHERE entity_type='payment_transactions'")).toEqual([])
    expect(JSON.parse(String(sqlite.exec("SELECT payload FROM local_entities WHERE entity_type='inventory'")[0].values[0][0])).quantity).toBe(100)
  })
  it('allows selling free stock and allows the owner to fulfill its reservation',async()=>{
    await commit([mutation('inventory',{...inventory,quantity:80})])
    await commit([mutation('inventory',{...inventory,quantity:10}),mutation('inventory_transactions',{id:'movement',productId:'product',storageId:'storage',transactionType:'sale',referenceType:'sales_order',referenceId:'order'}),mutation('sales_orders',{...order,status:'completed'})])
    expect(JSON.parse(String(sqlite.exec("SELECT payload FROM local_entities WHERE entity_type='inventory'")[0].values[0][0])).quantity).toBe(10)
  })
  it('allows losses but blocks a subsequent sale and reservation increase',async()=>{
    await commit([mutation('inventory',{...inventory,quantity:60}),mutation('inventory_transactions',{id:'loss',productId:'product',storageId:'storage',transactionType:'stock_adjustment'})])
    await expect(commit([mutation('inventory',{...inventory,quantity:59})])).rejects.toMatchObject({code:'STOCK_RESERVED'})
    await expect(commit([mutation('sales_orders',{...order,id:'another',items:[{productId:'product',quantity:1}]})])).rejects.toMatchObject({code:'STOCK_RESERVED'})
  })
  it('counts selected-unit conversions and free quantities and isolates storage',async()=>{
    put('sales_orders',{...order,items:[{productId:'product',quantity:2,unitFactor:20,inventoryQuantity:40,freeBonusQuantity:1,freeBonusInventoryQuantity:20}]})
    await expect(commit([mutation('inventory',{...inventory,quantity:59})])).rejects.toMatchObject({code:'STOCK_RESERVED'})
    put('inventory',{...inventory,id:'another-stock',storageId:'other-storage'})
    await commit([mutation('inventory',{...inventory,id:'another-stock',storageId:'other-storage',quantity:0})])
  })
  it('does not reject an immediately completed Quick Order as a new pending reservation',async()=>{
    put('sales_orders',{...order,status:'cancelled'})
    await commit([mutation('sales_orders',{...order,items:[{productId:'product',quantity:70}]}),mutation('inventory',{...inventory,quantity:30}),mutation('sales_orders',{...order,status:'completed'})])
  })
})
