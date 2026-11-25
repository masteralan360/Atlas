import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const workspace = '00000000-0000-4000-8000-000000000001'
const product = '00000000-0000-4000-8000-000000000002'
const storage = '00000000-0000-4000-8000-000000000003'
const order = '00000000-0000-4000-8000-000000000004'
const batch = '00000000-0000-4000-8000-000000000005'
const inventory = '00000000-0000-4000-8000-000000000006'
const actor = '00000000-0000-4000-8000-000000000007'
const otherOrder = '00000000-0000-4000-8000-000000000008'
const migrations = new URL('../../supabase/migrations/', import.meta.url)
let pg: PGlite

function complete(expectedBatchVersion: number, secondLineBatchQuantity = 2) {
    return pg.query<{ result: Record<string, unknown> }>(`SELECT public.complete_sales_order_with_inventory(
        $1::uuid, $2::uuid, 1, $1::uuid, $3::jsonb, now(), $4::jsonb, $5::jsonb) AS result`, [
        order, workspace,
        JSON.stringify([
            { productId: product, quantity: 1, batchAllocations: [{ batchId: batch, quantity: 1 }] },
            { productId: product, quantity: 2, batchAllocations: [{ batchId: batch, quantity: secondLineBatchQuantity }] }
        ]),
        JSON.stringify([{ id: inventory, quantity: 7 }]),
        JSON.stringify([{ id: batch, version: expectedBatchVersion }]),
    ]).then((response) => response.rows[0].result)
}

async function stockState() {
    return (await pg.query(`SELECT orders.status, inv.quantity::int AS total, b.quantity::int AS batch,
        b.version AS batch_version, (SELECT count(*)::int FROM private.test_receipts) AS receipts
        FROM crm.sales_orders orders CROSS JOIN public.inventory inv CROSS JOIN public.stock_batches b
        WHERE orders.id = $1`, [order])).rows[0]
}

async function reserveRegularStock(quantity: number) {
    await pg.query(`INSERT INTO crm.sales_orders(id,workspace_id,status,items,source_storage_id)
        VALUES($1,$2,'pending',$3,$4)`, [otherOrder, workspace, JSON.stringify([{
        productId: product, quantity, stockSourceType: 'regular',
    }]), storage])
}

describe('online sales order batch completion', () => {
    beforeAll(async () => {
        pg = new PGlite()
        await pg.exec(`CREATE SCHEMA private; CREATE SCHEMA crm; CREATE SCHEMA auth;
          CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
          CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${workspace}'::uuid $$;
          CREATE FUNCTION public.current_user_can_access_storage(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
          CREATE FUNCTION private.current_user_can_access_any_product_storage(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
          CREATE TABLE public.products(id uuid PRIMARY KEY, workspace_id uuid, is_service boolean, is_deleted boolean, storage_id uuid);
          CREATE TABLE public.inventory(id uuid PRIMARY KEY, workspace_id uuid, product_id uuid, storage_id uuid, quantity numeric, is_deleted boolean);
          CREATE TABLE public.stock_batches(id uuid PRIMARY KEY, workspace_id uuid, product_id uuid, storage_id uuid,
            quantity numeric, is_deleted boolean, version integer, updated_at timestamptz, created_at timestamptz DEFAULT now(),
            batch_number text DEFAULT 'Batch', expiry_date date, manufacturing_date date);
          CREATE TABLE crm.sales_orders(id uuid PRIMARY KEY, workspace_id uuid, status text, items jsonb, source_storage_id uuid,
            is_deleted boolean DEFAULT false, created_at timestamptz DEFAULT now(), order_number text DEFAULT 'SO-1', created_by uuid);
          CREATE TABLE private.test_receipts(order_id uuid PRIMARY KEY, inventory jsonb);
          CREATE FUNCTION private.apply_inventory_snapshot_changes(p_changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
          DECLARE stock public.inventory;
          BEGIN
            UPDATE public.inventory SET quantity = (p_changes->0->>'quantity')::numeric
            WHERE id = (p_changes->0->>'id')::uuid RETURNING * INTO stock;
            RETURN jsonb_build_array(to_jsonb(stock));
          END $$;
          CREATE FUNCTION private.complete_sales_order_with_inventory(p_order_id uuid,p_workspace_id uuid,p_expected_order_version bigint,
            p_operation_id uuid,p_items jsonb,p_actual_delivery_date timestamptz,p_changes jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
          DECLARE v_stock_result jsonb; saved crm.sales_orders; replay boolean;
          BEGIN
            SELECT * INTO saved FROM crm.sales_orders WHERE id=p_order_id AND workspace_id=p_workspace_id FOR UPDATE;
            replay := saved.status = 'completed';
            IF replay THEN
              SELECT inventory INTO v_stock_result FROM private.test_receipts WHERE order_id=p_order_id;
            ELSE
              v_stock_result := private.apply_inventory_snapshot_changes(p_changes);
              UPDATE crm.sales_orders SET status='completed',items=p_items WHERE id=p_order_id RETURNING * INTO saved;
              INSERT INTO private.test_receipts VALUES(p_order_id,v_stock_result);
            END IF;
            RETURN jsonb_build_object('order',to_jsonb(saved),'inventory',v_stock_result,'inventory_transactions','[]'::jsonb,'already_applied',replay);
          END $$;
          GRANT USAGE ON SCHEMA private TO authenticated,service_role;`)
        for (const name of [
            '20261029151640_protect_sales_order_reservations.sql',
            '20261124194331_reserve_sales_order_stock_sources.sql',
            '20261125143305_atomic_online_sales_order_batch_completion.sql',
            '20261125151434_allow_batch_completion_with_existing_regular_stock_deficit.sql'
        ]) {
            await pg.exec(readFileSync(new URL(name, migrations), 'utf8'))
        }
    }, 60_000)

    beforeEach(async () => {
        await pg.exec(`RESET ROLE;
          TRUNCATE crm.sales_orders, public.stock_batches, public.products, public.inventory, private.test_receipts CASCADE;
          INSERT INTO public.products VALUES('${product}','${workspace}',false,false,'${storage}');
          INSERT INTO public.inventory VALUES('${inventory}','${workspace}','${product}','${storage}',10,false);
          INSERT INTO public.stock_batches(id,workspace_id,product_id,storage_id,quantity,is_deleted,version,updated_at)
            VALUES('${batch}','${workspace}','${product}','${storage}',6,false,2,now());
          INSERT INTO crm.sales_orders(id,workspace_id,status,items,source_storage_id)
            VALUES('${order}','${workspace}','pending','[{"productId":"${product}","quantity":3}]','${storage}');`)
    })

    afterAll(async () => { await pg?.close() })

    it('commits one combined batch deduction and returns current stock on replay', async () => {
        await pg.exec('SET ROLE authenticated')
        await expect(complete(2)).resolves.toMatchObject({
            already_applied: false, stock_batches: [{ id: batch, quantity: 3, version: 3 }],
        })
        await pg.exec('RESET ROLE')
        expect(await stockState()).toEqual({ status: 'completed', total: 7, batch: 3, batch_version: 3, receipts: 1 })
        await pg.exec('UPDATE public.inventory SET quantity=8; SET ROLE authenticated')
        await expect(complete(2)).resolves.toMatchObject({
            already_applied: true, inventory: [{ id: inventory, quantity: 8 }], stock_batches: [{ quantity: 3 }],
        })
        await pg.exec('RESET ROLE')
        expect(await stockState()).toEqual({ status: 'completed', total: 8, batch: 3, batch_version: 3, receipts: 1 })
    })

    it('rolls back inventory, order, and receipt when the batch version has changed', async () => {
        await expect(complete(1)).resolves.toMatchObject({ conflict: true, conflict_reason: 'inventory_version' })
        expect(await stockState()).toEqual({ status: 'pending', total: 10, batch: 6, batch_version: 2, receipts: 0 })
        await expect(complete(2)).resolves.toMatchObject({ already_applied: false })
    })

    it('completes a fully batched sale when earlier reservations already exceed regular stock', async () => {
        await reserveRegularStock(3)
        await pg.query('UPDATE public.stock_batches SET quantity = 10 WHERE id = $1', [batch])
        await expect(complete(2)).resolves.toMatchObject({
            already_applied: false, stock_batches: [{ id: batch, quantity: 7, version: 3 }],
        })
        expect(await stockState()).toEqual({ status: 'completed', total: 7, batch: 7, batch_version: 3, receipts: 1 })
        const remaining = await pg.query(`SELECT quantity::int AS quantity FROM private.sales_order_stock_source_reservations
            WHERE order_id = $1 AND source_type = 'regular'`, [otherOrder])
        expect(remaining.rows).toEqual([{ quantity: 3 }])
    })

    it('rolls back a mixed sale that would consume regular stock reserved by another order', async () => {
        await reserveRegularStock(4)
        await expect(complete(2, 1)).resolves.toMatchObject({ conflict: true, conflict_reason: 'inventory_version' })
        expect(await stockState()).toEqual({ status: 'pending', total: 10, batch: 6, batch_version: 2, receipts: 0 })
    })
})
