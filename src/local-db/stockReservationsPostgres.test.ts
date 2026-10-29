import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const workspace = '00000000-0000-4000-8000-000000000001'
const product = '00000000-0000-4000-8000-000000000002'
const storage = '00000000-0000-4000-8000-000000000003'
const inventory = '00000000-0000-4000-8000-000000000004'
const order = '00000000-0000-4000-8000-000000000005'
const actor = '00000000-0000-4000-8000-000000000006'
let pg: PGlite
const migration = readFileSync(new URL('../../supabase/migrations/20261029151640_protect_sales_order_reservations.sql', import.meta.url), 'utf8')

async function reserve(id = order, quantity = 70, extra: Record<string, unknown> = {}) {
  await pg.query(`INSERT INTO crm.sales_orders(id,workspace_id,order_number,status,created_by,items,source_storage_id)
    VALUES($1::uuid,$2,$1::text,'pending',$3,$4,$5)`, [id,workspace,actor,JSON.stringify([{ productId:product,quantity,...extra }]),storage])
}

describe('authoritative PostgreSQL reservation protection', () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`CREATE SCHEMA private; CREATE SCHEMA crm; CREATE SCHEMA auth;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${actor}'::uuid$$;
      CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$SELECT '${workspace}'::uuid$$;
      CREATE FUNCTION public.current_user_can_access_storage(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
      CREATE FUNCTION private.current_user_can_access_any_product_storage(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
      CREATE TABLE public.products(id uuid PRIMARY KEY,workspace_id uuid,is_service boolean DEFAULT false,is_deleted boolean DEFAULT false,storage_id uuid);
      CREATE TABLE public.inventory(id uuid PRIMARY KEY,workspace_id uuid,product_id uuid,storage_id uuid,quantity numeric,is_deleted boolean DEFAULT false);
      CREATE TABLE crm.sales_orders(id uuid PRIMARY KEY,workspace_id uuid,order_number text,status text,items jsonb,source_storage_id uuid,is_deleted boolean DEFAULT false,created_at timestamptz DEFAULT now(),created_by uuid);
      CREATE TABLE public.test_payments(id integer);
      CREATE FUNCTION private.apply_inventory_snapshot_changes(changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
        PERFORM set_config('atlas.inventory_transaction_type','inventory_change',true);
        PERFORM set_config('atlas.inventory_reference_type','sales_order_completion',true);
        UPDATE public.inventory SET quantity=(changes->>'quantity')::numeric WHERE id=(changes->>'id')::uuid; RETURN '{}'; END$$;
      CREATE FUNCTION private.complete_sales_order_with_inventory(p_order_id uuid,p_workspace_id uuid,p_expected_order_version bigint,p_operation_id uuid,p_items jsonb,p_actual_delivery_date timestamptz,p_changes jsonb)
      RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE v_stock_result jsonb; BEGIN
        v_stock_result := private.apply_inventory_snapshot_changes(p_changes);
        UPDATE crm.sales_orders SET status='completed' WHERE id=p_order_id;
        RETURN v_stock_result; END$$;
      GRANT USAGE ON SCHEMA public,crm,auth TO authenticated;
      GRANT SELECT ON crm.sales_orders TO authenticated;
      ALTER TABLE crm.sales_orders ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_orders ON crm.sales_orders FOR SELECT TO authenticated USING (created_by=auth.uid());`)
    await pg.exec(migration)
  }, 60_000)
  afterAll(async () => { await pg?.close() })
  beforeEach(async () => {
    await pg.exec(`RESET ROLE; TRUNCATE crm.sales_orders CASCADE; TRUNCATE public.inventory,public.products,public.test_payments;
      SELECT set_config('atlas.inventory_transaction_type','',false),set_config('atlas.inventory_reference_type','',false),set_config('atlas.inventory_reference_id','',false);`)
    await pg.query('INSERT INTO public.products(id,workspace_id,storage_id) VALUES($1,$2,$3)',[product,workspace,storage])
    await pg.query('INSERT INTO public.inventory VALUES($1,$2,$3,$4,100,false)',[inventory,workspace,product,storage])
  })
  it('allows free stock, blocks consuming committed stock, and rolls back payments', async () => {
    await reserve()
    await pg.query('UPDATE public.inventory SET quantity=80 WHERE id=$1',[inventory])
    await expect(pg.transaction(async tx => {
      await tx.exec('INSERT INTO public.test_payments VALUES(1)')
      await tx.query('UPDATE public.inventory SET quantity=60 WHERE id=$1',[inventory])
    })).rejects.toThrow('stock_reserved')
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity:80 }])
    expect((await pg.query('SELECT * FROM public.test_payments')).rows).toEqual([])
  })
  it('counts canonical units and free quantities and rejects an overcommitted reservation', async () => {
    await reserve(order,2,{ unitFactor:20,inventoryQuantity:40,freeBonusQuantity:1,freeBonusInventoryQuantity:20 })
    const result=await pg.query<{ total:number }>('SELECT SUM(quantity)::float8 total FROM private.sales_order_stock_reservations')
    expect(result.rows[0].total).toBe(60)
    await expect(reserve('00000000-0000-4000-8000-000000000007',3,{ unitFactor:20 })).rejects.toThrow('stock_reserved')
    expect((await pg.query('SELECT * FROM crm.sales_orders')).rows).toHaveLength(1)
  })
  it('consumes its own reservation once and releases it on completion', async () => {
    await reserve()
    await pg.query(`SELECT private.complete_sales_order_with_inventory($1,$2,1,$1,'[]',now(),$3)`,[order,workspace,JSON.stringify({ id:inventory,quantity:30 })])
    expect((await pg.query('SELECT * FROM private.sales_order_stock_reservations')).rows).toEqual([])
    expect((await pg.query('SELECT status FROM crm.sales_orders')).rows).toEqual([{ status:'completed' }])
  })
  it('cannot use its fulfillment identity to consume another order reservation', async () => {
    await reserve(order,70)
    await reserve('00000000-0000-4000-8000-000000000007',20)
    await expect(pg.query(`SELECT private.complete_sales_order_with_inventory($1,$2,1,$1,'[]',now(),$3)`,[order,workspace,JSON.stringify({ id:inventory,quantity:10 })])).rejects.toThrow('stock_reserved')
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:100}])
    expect((await pg.query('SELECT * FROM private.sales_order_stock_reservations')).rows).toHaveLength(2)
  })
  it('serializes competing new reservations and excludes services', async () => {
    const outcomes=await Promise.allSettled([reserve(order,70),reserve('00000000-0000-4000-8000-000000000007',70)])
    expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    await pg.query('UPDATE public.products SET is_service=true WHERE id=$1',[product])
    await reserve('00000000-0000-4000-8000-000000000008',500)
    expect((await pg.query('SELECT * FROM private.sales_order_stock_reservations')).rows).toHaveLength(1)
  })
  it('releases cancellation, permits real losses, and blocks new consumption after a loss', async () => {
    await reserve()
    await pg.transaction(async tx => {
      await tx.exec("SELECT set_config('atlas.inventory_transaction_type','stock_adjustment',true)")
      await tx.query('UPDATE public.inventory SET quantity=60 WHERE id=$1',[inventory])
    })
    await expect(pg.query('UPDATE public.inventory SET quantity=59 WHERE id=$1',[inventory])).rejects.toThrow('stock_reserved')
    await pg.query("UPDATE crm.sales_orders SET status='cancelled' WHERE id=$1",[order])
    await pg.query('UPDATE public.inventory SET quantity=50 WHERE id=$1',[inventory])
  })
  it('protects transfers/deletion and keeps storage/workspace scopes separate', async () => {
    await reserve()
    await expect(pg.query('DELETE FROM public.inventory WHERE id=$1',[inventory])).rejects.toThrow('stock_reserved')
    await pg.query('INSERT INTO public.inventory VALUES($1,$2,$3,$4,100,false)', ['00000000-0000-4000-8000-000000000008',workspace,product,'00000000-0000-4000-8000-000000000009'])
    await pg.exec("SELECT set_config('atlas.inventory_transaction_type','inventory_transfer',false)")
    await pg.query('UPDATE public.inventory SET quantity=0 WHERE storage_id<>$1',[storage])
    await expect(pg.query('UPDATE public.inventory SET quantity=69 WHERE id=$1',[inventory])).rejects.toThrow('stock_reserved')
  })
  it('does not accept an audit reference as authorization to consume a reservation', async () => {
    await reserve()
    await pg.transaction(async tx => {
      await tx.exec("SELECT set_config('atlas.inventory_transaction_type','sale',true),set_config('atlas.inventory_reference_type','sales_order',true)")
      await tx.query("SELECT set_config('atlas.inventory_reference_id',$1,true)",[order])
      await expect(tx.query('UPDATE public.inventory SET quantity=0 WHERE id=$1',[inventory])).rejects.toThrow('stock_reserved')
    }).catch(() => undefined)
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:100}])
  })
  it('protects legacy completion snapshots even when their audit defaults to inventory_change', async () => {
    await reserve()
    await expect(pg.query('SELECT private.apply_inventory_snapshot_changes($1)',[JSON.stringify({id:inventory,quantity:60})])).rejects.toThrow('stock_reserved')
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:100}])
  })
  it('returns aggregate availability while order detail obeys RLS', async () => {
    await reserve()
    await pg.query('UPDATE crm.sales_orders SET created_by=$1 WHERE id=$2',['00000000-0000-4000-8000-000000000099',order])
    await pg.exec('SET ROLE authenticated')
    const result=await pg.query<{ result: { onHand:number;reserved:number;available:number }[] }>('SELECT public.get_stock_reservation_availability($1,$2) result',[workspace,JSON.stringify([{productId:product,storageId:storage}])])
    expect(result.rows[0].result).toEqual([{productId:product,storageId:storage,onHand:100,reserved:70,available:30}])
    const details=await pg.query<{ result:{total:number;rows:unknown[]} }>('SELECT public.get_visible_stock_reservations($1,$2,$3) result',[workspace,product,storage])
    expect(details.rows[0].result).toEqual({total:0,rows:[]})
    await expect(pg.query('SELECT * FROM private.sales_order_stock_reservations')).rejects.toThrow()
  })
})
