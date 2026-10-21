import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'
import { db } from './database'
import type { Product } from './models'
import { readOrderReturnStockProductIds } from './orderReturnCatalog'

const remote = vi.hoisted(() => ({
  rows: [] as Array<{id:string;workspace_id:string;is_service:boolean}>,
  calls: [] as Array<{workspaceId:string;ids:string[]}>,
  error: null as Error | null,
  select: vi.fn(),
}))
vi.mock('@/lib/supabaseSchema', () => ({
  getSupabaseClientForTable: () => ({ from: () => ({
    select: (columns:string) => {
      remote.select(columns)
      return {eq: (_field:string,workspaceId:string) => ({in: async (_field:string,ids:string[]) => {
        remote.calls.push({workspaceId,ids})
        return {data:remote.rows.filter(row => row.workspace_id===workspaceId && ids.includes(row.id)),error:remote.error}
      }})}
    },
  })}),
}))
vi.mock('@/lib/supabaseRequest', () => ({
  runSupabaseAction: (_label:string,run:()=>unknown) => run(),
  normalizeSupabaseActionError: (error:unknown) => error,
}))

describe('sales-order return catalog classification', () => {
  beforeAll(() => installTestBrowser())
  beforeEach(async () => {
    await db.delete()
    await db.open()
    remote.rows=[]; remote.calls=[]; remote.error=null; remote.select.mockClear()
  })
  afterAll(async () => {await db.delete()})

  it.each(['cloud','hybrid'] as const)('%s: reads selected service types from Supabase with a cold/incorrect local cache',async dataMode => {
    writeWorkspaceModeSnapshot({workspaceId:'workspace',dataMode})
    await db.products.put({id:'service',workspaceId:'workspace',isService:false} as Product)
    remote.rows=[{id:'product',workspace_id:'workspace',is_service:false},
      {id:'service',workspace_id:'workspace',is_service:true},
      {id:'unrelated',workspace_id:'workspace',is_service:false},
      {id:'foreign',workspace_id:'other',is_service:false}]
    expect(await readOrderReturnStockProductIds('workspace',['service','product','service'])).toEqual(new Set(['product']))
    expect(remote.select).toHaveBeenCalledWith('id,workspace_id,is_service')
    expect(remote.calls).toEqual([{workspaceId:'workspace',ids:['service','product']}])
    expect(await db.products.get('service')).toMatchObject({isService:false})
    expect(await readOrderReturnStockProductIds('workspace',['service'])).toEqual(new Set())
    await expect(readOrderReturnStockProductIds('workspace',['foreign'])).rejects.toThrow()
  })

  it('uses the Local mirror without querying Supabase and rejects an unknown product',async () => {
    writeWorkspaceModeSnapshot({workspaceId:'workspace',dataMode:'local'})
    await db.products.bulkPut([{id:'service',workspaceId:'workspace',isService:true},
      {id:'product',workspaceId:'workspace',isService:false}] as Product[])
    expect(await readOrderReturnStockProductIds('workspace',['service','product'])).toEqual(new Set(['product']))
    expect(await readOrderReturnStockProductIds('workspace',[])).toEqual(new Set())
    await expect(readOrderReturnStockProductIds('workspace',['missing'])).rejects.toThrow()
    expect(remote.calls).toEqual([])
  })

  it('batches a large return and propagates classification failures before inventory work starts',async () => {
    writeWorkspaceModeSnapshot({workspaceId:'workspace',dataMode:'cloud'})
    remote.rows=Array.from({length:205},(_,i)=>({id:`product-${i}`,workspace_id:'workspace',is_service:false}))
    expect((await readOrderReturnStockProductIds('workspace',remote.rows.map(row=>row.id))).size).toBe(205)
    expect(remote.calls.map(call=>call.ids.length)).toEqual([100,100,5])
    remote.error=new Error('Catalog unavailable')
    await expect(readOrderReturnStockProductIds('workspace',['product-0'])).rejects.toThrow('Catalog unavailable')
  })
})
