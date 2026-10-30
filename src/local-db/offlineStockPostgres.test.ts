import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const workspace = '00000000-0000-4000-8000-000000000801'
const actor = '00000000-0000-4000-8000-000000000802'
const product = '00000000-0000-4000-8000-000000000803'
const storage = '00000000-0000-4000-8000-000000000804'
const inventory = '00000000-0000-4000-8000-000000000805'
const operation = '00000000-0000-4000-8000-000000000806'
let pg: PGlite
const migration = readFileSync(new URL('../../supabase/migrations/20261029221116_offline_stock_operations.sql', import.meta.url), 'utf8')
const receiptPolicyMigration = readFileSync(new URL('../../supabase/migrations/20261030131040_optimize_offline_stock_receipt_policies.sql', import.meta.url), 'utf8')
const auditLockMigration = readFileSync(new URL('../../supabase/migrations/20261030132510_fix_offline_stock_read_only_audit_locks.sql', import.meta.url), 'utf8')

function command(delta = -2) {
  return { version: 1, id: operation, workspaceId: workspace, actorId: actor, kind: 'product', sequence: 1, dependencies: [], effects: [{
    table: 'inventory', id: inventory,
    before: { id: inventory, workspace_id: workspace, product_id: product, storage_id: storage, quantity: 10, version: 1 },
    after: { id: inventory, workspace_id: workspace, product_id: product, storage_id: storage, quantity: 10 + delta, version: 2 },
  }] }
}
async function apply(value: unknown) { return (await pg.query<{ result: { id: string; rows: unknown[] } }>('SELECT public.apply_offline_stock_operation($1::jsonb) result', [JSON.stringify(value)])).rows[0].result }

describe('PostgreSQL offline stock transaction replay', () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`CREATE SCHEMA auth; CREATE SCHEMA crm; CREATE SCHEMA extensions;
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${actor}'::uuid$$;
      CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$SELECT '${workspace}'::uuid$$;
      CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql AS $$SELECT 'admin'::text$$;
      CREATE TABLE public.workspaces(id uuid PRIMARY KEY);
      INSERT INTO public.workspaces VALUES('${workspace}');
      CREATE TABLE public.inventory(id uuid PRIMARY KEY,workspace_id uuid,product_id uuid,storage_id uuid,quantity numeric,version int,is_deleted boolean DEFAULT false);
      CREATE TABLE public.products(id uuid PRIMARY KEY,workspace_id uuid,name text,version int,updated_at timestamptz);
      CREATE TABLE public.stock_batches(id uuid PRIMARY KEY,workspace_id uuid,product_id uuid,storage_id uuid,quantity numeric,version int,is_deleted boolean DEFAULT false);
      CREATE TABLE public.inventory_transactions(id uuid PRIMARY KEY,workspace_id uuid,product_id uuid,storage_id uuid,transaction_type text,quantity_delta numeric);
      CREATE TABLE public.inventory_transfer_batches(id uuid PRIMARY KEY,workspace_id uuid);
      CREATE FUNCTION public.apply_stock_adjustment(p_transaction jsonb)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$BEGIN
        UPDATE public.inventory SET quantity=quantity+(p_transaction->>'quantity_delta')::numeric,version=version+1
          WHERE workspace_id=(p_transaction->>'workspace_id')::uuid AND product_id=(p_transaction->>'product_id')::uuid AND storage_id=(p_transaction->>'storage_id')::uuid;
        INSERT INTO public.inventory_transactions VALUES((p_transaction->>'id')::uuid,(p_transaction->>'workspace_id')::uuid,
          (p_transaction->>'product_id')::uuid,(p_transaction->>'storage_id')::uuid,'stock_adjustment',(p_transaction->>'quantity_delta')::numeric);
        RETURN jsonb_build_object('transaction',p_transaction); END$$;
      CREATE FUNCTION public.apply_inventory_snapshot_changes(p_operation_id uuid,p_workspace_id uuid,p_operation_kind text,p_changes jsonb)
      RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$DECLARE change jsonb; BEGIN
        FOR change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
          IF (change->>'quantity')::numeric<0 THEN RAISE EXCEPTION 'Insufficient inventory' USING ERRCODE='23514'; END IF;
          UPDATE public.inventory SET quantity=(change->>'quantity')::numeric,version=version+1,is_deleted=(change->>'quantity')::numeric=0
            WHERE id=(change->>'id')::uuid AND workspace_id=p_workspace_id AND version=(change->>'expected_version')::int;
          IF NOT FOUND THEN RAISE EXCEPTION 'stock changed' USING ERRCODE='40001'; END IF;
        END LOOP;
        RETURN jsonb_build_object('inventory','[]'::jsonb); END$$;`)
    await pg.exec(`
      CREATE TABLE crm.sales_orders(id uuid PRIMARY KEY,workspace_id uuid,status text,version int,items jsonb,payment_method text,linked_loan_id uuid);
      CREATE TABLE crm.purchase_orders(LIKE crm.sales_orders INCLUDING ALL);
      CREATE TABLE public.loans(id uuid PRIMARY KEY,workspace_id uuid,principal_amount numeric);
      CREATE FUNCTION extensions.uuid_generate_v5(namespace uuid,name text) RETURNS uuid LANGUAGE sql AS $$SELECT md5(namespace::text||name)::uuid$$;
      CREATE FUNCTION public.activate_financed_order(p_order_type text,p_order_id uuid,p_target_status text) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
        IF NOT EXISTS (SELECT 1 FROM crm.sales_orders WHERE id=p_order_id AND status='draft' AND linked_loan_id IS NULL) THEN RAISE EXCEPTION 'must activate draft'; END IF;
        INSERT INTO public.loans VALUES('${product}','${workspace}',100);
        UPDATE crm.sales_orders SET status='pending',version=version+1,linked_loan_id='${product}' WHERE id=p_order_id;
        RETURN jsonb_build_object('loan_id','${product}'); END$$;
      CREATE FUNCTION public.complete_sales_order_with_inventory(p_order_id uuid,p_workspace_id uuid,p_expected_order_version bigint,p_operation_id uuid,p_items jsonb,p_actual_delivery_date timestamptz,p_changes jsonb)
      RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
        IF NOT EXISTS (SELECT 1 FROM crm.sales_orders WHERE id=p_order_id AND status='pending' AND version=p_expected_order_version) THEN RAISE EXCEPTION 'incorrect staged order revision'; END IF;
        PERFORM public.apply_inventory_snapshot_changes(p_operation_id,p_workspace_id,'completion',p_changes);
        UPDATE crm.sales_orders SET status='completed',version=version+1 WHERE id=p_order_id;
        RETURN '{}'; END$$;
      CREATE FUNCTION public.receive_purchase_order(p_order_id uuid,p_target_status text,p_batches jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
        IF NOT EXISTS (SELECT 1 FROM crm.purchase_orders WHERE id=p_order_id AND status='ordered' AND version>=1) THEN RAISE EXCEPTION 'incorrect staged purchase'; END IF;
        UPDATE public.inventory SET quantity=quantity+2,version=version+1;
        UPDATE crm.purchase_orders SET status=p_target_status,version=version+1 WHERE id=p_order_id;
        RETURN '{}'; END$$;
      CREATE FUNCTION public.apply_inventory_transfer_batch(p_operation_id uuid,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE change jsonb; BEGIN
        FOR change IN SELECT value FROM jsonb_array_elements(p_payload->'inventory_changes') LOOP
          IF (change->>'quantity')::numeric<0 THEN RAISE EXCEPTION 'Insufficient transfer stock'; END IF;
          UPDATE public.inventory SET quantity=(change->>'quantity')::numeric,version=version+1 WHERE id=(change->>'id')::uuid AND version=(change->>'expected_version')::int;
          IF NOT FOUND THEN RAISE EXCEPTION 'incorrect rebased transfer revision'; END IF;
        END LOOP;
        IF p_payload->'batch'->>'id' IS NOT NULL THEN
          INSERT INTO public.inventory_transfer_batches VALUES(p_operation_id,(p_payload->'batch'->>'workspace_id')::uuid);
          INSERT INTO public.inventory_transactions VALUES(p_operation_id,(p_payload->'batch'->>'workspace_id')::uuid,
            (p_payload->'inventory_changes'->0->>'product_id')::uuid,(p_payload->'inventory_changes'->0->>'storage_id')::uuid,
            'transfer_out',(p_payload->'inventory_changes'->0->>'quantity_delta')::numeric);
        END IF;
        RETURN '{}'; END$$;
    `)
    await pg.exec(`
      CREATE TABLE public.sales(id uuid PRIMARY KEY,workspace_id uuid,settlement_currency text);
      CREATE TABLE public.sale_returns(id uuid PRIMARY KEY,workspace_id uuid,sale_id uuid,refund_amount numeric);
      CREATE TABLE public.sale_return_items(id uuid PRIMARY KEY,workspace_id uuid,return_id uuid,sale_item_id uuid,quantity numeric);
      CREATE TABLE public.payment_transactions(id uuid PRIMARY KEY,workspace_id uuid,source_record_id uuid,source_subrecord_id uuid,source_type text,amount numeric,direction text,currency text,reversal_of_transaction_id uuid,created_at timestamptz);
      CREATE FUNCTION public.process_sale_return_with_loan(p_return_id uuid,p_sale_id uuid,p_items jsonb,p_return_reason text,p_refund_method text) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
        INSERT INTO public.sale_returns VALUES(p_return_id,'${workspace}',p_sale_id,10);
        INSERT INTO public.sale_return_items VALUES(gen_random_uuid(),'${workspace}',p_return_id,(p_items->0->>'sale_item_id')::uuid,(p_items->0->>'quantity')::numeric);
        UPDATE public.inventory SET quantity=quantity+2,version=version+1;
        RETURN jsonb_build_object('return_value',10); END$$;
    `)
    await pg.exec('GRANT USAGE ON SCHEMA public,crm,auth,extensions TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,crm TO authenticated;')
    await pg.exec(`REVOKE INSERT,UPDATE,DELETE ON public.inventory_transactions,public.inventory_transfer_batches FROM authenticated;
      ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
      CREATE POLICY offline_audit_read ON public.inventory_transactions FOR SELECT TO authenticated USING (workspace_id=public.current_workspace_id());
      ALTER TABLE public.inventory_transfer_batches ENABLE ROW LEVEL SECURITY;
      CREATE POLICY offline_transfer_read ON public.inventory_transfer_batches FOR SELECT TO authenticated USING (workspace_id=public.current_workspace_id());`)
    // Mirror hosted Supabase defaults so receipt grants cannot accidentally
    // retain destructive privileges that bypass row-level policies.
    await pg.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;')
    await pg.exec(migration)
    await pg.exec(receiptPolicyMigration)
    await pg.exec(auditLockMigration)
  }, 60_000)
  afterAll(async () => { await pg?.close() })
  beforeEach(async () => {
    await pg.exec(`RESET ROLE; TRUNCATE public.offline_stock_operation_receipts,public.inventory,public.stock_batches,public.products,crm.sales_orders,crm.purchase_orders,public.loans,public.sales,public.sale_returns,public.sale_return_items,public.payment_transactions,public.inventory_transactions,public.inventory_transfer_batches;
      INSERT INTO public.inventory VALUES('${inventory}','${workspace}','${product}','${storage}',7,3,false);`)
  })
  it('applies a relative movement to current authoritative stock instead of a stale offline balance', async () => {
    expect((await apply(command())).id).toBe(operation)
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 5 }])
  })
  it('returns the same receipt after a lost response without deducting twice', async () => {
    const first = await apply(command())
    expect(await apply(command())).toEqual(first)
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 5 }])
    expect((await pg.query('SELECT count(*)::int count FROM public.offline_stock_operation_receipts')).rows).toEqual([{ count: 1 }])
  })
  it('replays a stock adjustment with a read-only audit ledger exactly once', async () => {
    const value = { ...command(), kind: 'adjustment', effects: [...command().effects, {
      table: 'inventory_transactions', id: operation, before: null,
      after: { id: operation, workspace_id: workspace, product_id: product, storage_id: storage, transaction_type: 'stock_adjustment', quantity_delta: -2 },
    }] }
    const first = await apply(value)
    expect(await apply(value)).toEqual(first)
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 5 }])
    expect((await pg.query('SELECT count(*)::int count FROM public.inventory_transactions')).rows).toEqual([{ count: 1 }])
    expect((await pg.query(`SELECT has_table_privilege('atlas_offline_stock_executor','public.inventory_transactions','UPDATE') AS can_update,
      has_table_privilege('atlas_offline_stock_executor','public.inventory_transactions','INSERT') AS can_insert`)).rows).toEqual([{ can_update: false, can_insert: false }])
  })
  it('rolls back replay when the caller cannot read the authoritative audit row', async () => {
    const value = { ...command(), kind: 'adjustment', effects: [...command().effects, {
      table: 'inventory_transactions', id: operation, before: null,
      after: { id: operation, workspace_id: workspace, product_id: product, storage_id: storage, transaction_type: 'stock_adjustment', quantity_delta: -2 },
    }] }
    await pg.exec('ALTER POLICY offline_audit_read ON public.inventory_transactions USING (false)')
    try {
      await expect(apply(value)).rejects.toThrow('authoritative_child_missing')
    } finally {
      await pg.exec('ALTER POLICY offline_audit_read ON public.inventory_transactions USING (workspace_id=public.current_workspace_id())')
    }
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 7 }])
    expect((await pg.query('SELECT count(*)::int count FROM public.inventory_transactions')).rows).toEqual([{ count: 0 }])
    expect((await pg.query('SELECT count(*)::int count FROM public.offline_stock_operation_receipts')).rows).toEqual([{ count: 0 }])
  })
  it('rejects operation-ID reuse with different quantities', async () => {
    await apply(command())
    await expect(apply(command(-3))).rejects.toThrow('identity_conflict')
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 5 }])
  })
  it('rejects forged actor/workspace scope and unrecognized tables', async () => {
    await expect(apply({ ...command(), actorId: product })).rejects.toThrow('access_denied')
    await expect(apply({ ...command(), workspaceId: product })).rejects.toThrow('access_denied')
    const bad = command(); bad.effects[0].table = 'workspaces'
    await expect(apply(bad)).rejects.toThrow('invalid_offline_stock_table')
  })
  it('rolls back document writes if the stock deduction fails', async () => {
    const value = command(-20)
    value.effects.unshift({ table: 'products', id: product, before: null as never, after: { id: product, workspace_id: workspace, name: 'Created offline' } as never })
    await expect(apply(value)).rejects.toThrow('Insufficient inventory')
    expect((await pg.query('SELECT * FROM public.products')).rows).toHaveLength(0)
    expect((await pg.query('SELECT * FROM public.offline_stock_operation_receipts')).rows).toHaveLength(0)
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 7 }])
  })
  it('keeps a stale batch edit as a conflict', async () => {
    await pg.exec(`INSERT INTO public.stock_batches VALUES('${product}','${workspace}','${product}','${storage}',3,4,false)`)
    const value = command()
    value.effects.push({ table: 'stock_batches', id: product, before: { id: product, workspace_id: workspace, version: 2 } as never, after: { id: product, workspace_id: workspace, product_id: product, storage_id: storage, quantity: 1, version: 3 } as never })
    await expect(apply(value)).rejects.toThrow('record_changed')
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 7 }])
  })
  it('does not allow a client to forge an authoritative receipt', async () => {
    expect((await pg.query(`SELECT
      has_table_privilege('authenticated','public.offline_stock_operation_receipts','SELECT') AS can_read,
      has_table_privilege('authenticated','public.offline_stock_operation_receipts','INSERT') AS can_insert,
      has_table_privilege('authenticated','public.offline_stock_operation_receipts','UPDATE') AS can_update,
      has_table_privilege('authenticated','public.offline_stock_operation_receipts','DELETE') AS can_delete,
      has_table_privilege('authenticated','public.offline_stock_operation_receipts','TRUNCATE') AS can_truncate,
      has_table_privilege('anon','public.offline_stock_operation_receipts','SELECT') AS anon_read
    `)).rows).toEqual([{ can_read: true, can_insert: false, can_update: false, can_delete: false, can_truncate: false, anon_read: false }])
    await pg.exec('SET ROLE authenticated');
    await expect(pg.query(`INSERT INTO public.offline_stock_operation_receipts(id,workspace_id,actor_id,operation,result) VALUES($1,$2,$3,'{}','{}')`, [operation,workspace,actor])).rejects.toThrow('permission denied');
    await pg.exec('RESET ROLE');
  })
  it('only exposes receipts belonging to the current workspace and actor', async () => {
    await pg.exec(`INSERT INTO public.workspaces VALUES('${storage}') ON CONFLICT DO NOTHING;
      INSERT INTO public.offline_stock_operation_receipts(id,workspace_id,actor_id,operation,result) VALUES
        ('${operation}','${workspace}','${actor}','{}','{}'),
        ('${product}','${workspace}','${product}','{}','{}'),
        ('${storage}','${storage}','${actor}','{}','{}');
      SET ROLE authenticated;`)
    try {
      expect((await pg.query('SELECT id FROM public.offline_stock_operation_receipts')).rows).toEqual([{ id: operation }])
    } finally {
      await pg.exec('RESET ROLE')
    }
  })
  it('keeps authenticated inventory RLS active inside the receipt executor', async () => {
    await pg.exec(`ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
      CREATE POLICY offline_test_visibility ON public.inventory TO authenticated USING (storage_id<>'${storage}'::uuid) WITH CHECK (storage_id<>'${storage}'::uuid)`)
    try { await expect(apply(command())).rejects.toThrow('Insufficient inventory') }
    finally { await pg.exec('DROP POLICY offline_test_visibility ON public.inventory; ALTER TABLE public.inventory DISABLE ROW LEVEL SECURITY') }
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 7 }])
  })
  it('fences delayed replay after discarding an unconfirmed physical count', async () => {
    const value = { ...command(), kind: 'adjustment', count: { productId: product, storageId: storage, version: 1, quantity: 8 } }
    const discarded = (await pg.query<{ result: { discarded: boolean } }>('SELECT public.cancel_offline_stock_count($1::jsonb) result', [JSON.stringify(value)])).rows[0].result
    expect(discarded.discarded).toBe(true)
    expect(await apply(value)).toEqual(discarded)
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{ quantity: 7 }])
    await expect(pg.query('SELECT public.cancel_offline_stock_count($1::jsonb)', [JSON.stringify(command())])).rejects.toThrow('discard_unavailable')
  })

  it.each([false,true])('completes a new offline sales order through its canonical lifecycle (financed: %s)', async financed => {
    const value = command() as unknown as Record<string, unknown>
    value.kind='sales_order'
    const effects = value.effects as unknown[]
    effects.push({ table:'sales_orders',id:operation,before:null,after:{id:operation,workspace_id:workspace,status:'completed',version:financed?3:2,items:[],payment_method:financed?'loan':'cash',linked_loan_id:financed?product:null} })
    if (financed) effects.push({table:'loans',id:product,before:null,after:{id:product,workspace_id:workspace,principal_amount:100}})
    await apply(value)
    expect((await pg.query('SELECT status,version FROM crm.sales_orders')).rows).toEqual([{status:'completed',version:financed?3:2}])
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:5}])
  })
  it('stages a new purchase at a valid revision and receives it once', async () => {
    const value = command(2) as unknown as Record<string, unknown>
    value.kind='purchase_order'
    ;(value.effects as unknown[]).push({table:'purchase_orders',id:operation,before:null,after:{id:operation,workspace_id:workspace,status:'received',version:1,items:[],payment_method:'cash',linked_loan_id:null}})
    await apply(value); await apply(value)
    expect((await pg.query('SELECT status,version FROM crm.purchase_orders')).rows).toEqual([{status:'received',version:2}])
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:9}])
  })
  it('rebases the canonical transfer payload against the current inventory revision', async () => {
    const value = command() as unknown as Record<string, unknown>
    value.kind='transfer';value.rpc={name:'apply_inventory_transfer_batch',args:{p_operation_id:operation,p_payload:{batch:{id:operation,workspace_id:workspace},inventory_changes:[{
      id:inventory,workspace_id:workspace,product_id:product,storage_id:storage,quantity:8,expected_version:1,quantity_delta:-2,
    }],stock_batch_changes:[]}}}
    ;(value.effects as unknown[]).push(
      {table:'inventory_transfer_batches',id:operation,before:null,after:{id:operation,workspace_id:workspace}},
      {table:'inventory_transactions',id:operation,before:null,after:{id:operation,workspace_id:workspace,product_id:product,storage_id:storage,transaction_type:'transfer_out',quantity_delta:-2}},
    )
    await apply(value); await apply(value)
    expect((await pg.query('SELECT quantity::float8 quantity,version FROM public.inventory')).rows).toEqual([{quantity:5,version:4}])
    expect((await pg.query('SELECT count(*)::int count FROM public.inventory_transfer_batches')).rows).toEqual([{count:1}])
    expect((await pg.query('SELECT count(*)::int count FROM public.inventory_transactions')).rows).toEqual([{count:1}])
  })

  it.each([-10,-20])('commits only the exact return refund amount (%s) with its stock restoration', async refund => {
    await pg.exec(`INSERT INTO public.sales VALUES('${actor}','${workspace}','usd')`)
    const child='00000000-0000-4000-8000-000000000809'
    const value = command(2) as unknown as Record<string, unknown>
    value.kind='return';value.rpc={name:'process_sale_return_with_loan',args:{p_return_id:operation,p_sale_id:actor,p_items:[{id:child,sale_item_id:product,quantity:2}],p_return_reason:'Customer return',p_refund_method:null}}
    ;(value.effects as unknown[]).push(
      {table:'sale_returns',id:operation,before:null,after:{id:operation,workspace_id:workspace,sale_id:actor,refund_amount:10}},
      {table:'sale_return_items',id:child,before:null,after:{id:child,workspace_id:workspace,return_id:operation,sale_item_id:product,quantity:2}},
      {table:'payment_transactions',id:operation,before:null,after:{id:operation,workspace_id:workspace,source_record_id:actor,source_subrecord_id:operation,source_type:'pos_sale',amount:refund,direction:'incoming',currency:'usd'}},
    )
    if (refund===-10) {
      const result=await apply(value) as {aliases?:{table:string;from:string;to:string}[]}
      expect(result.aliases).toEqual([expect.objectContaining({table:'sale_return_items',from:child})])
      await apply(value)
      expect((await pg.query('SELECT count(*)::int count FROM public.payment_transactions')).rows).toEqual([{count:1}])
      expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:9}])
    } else {
      await expect(apply(value)).rejects.toThrow('invalid_offline_stock_refund_amount')
      expect((await pg.query('SELECT count(*)::int count FROM public.sale_returns')).rows).toEqual([{count:0}])
      expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:7}])
    }
  })
  it('does not overwrite a newer product edit while replaying metadata and stock together', async () => {
    await pg.exec(`INSERT INTO public.products(id,workspace_id,name,version) VALUES('${product}','${workspace}','Changed on another device',3)`)
    const value=command() as unknown as Record<string,unknown>
    ;(value.effects as unknown[]).push({table:'products',id:product,before:{id:product,workspace_id:workspace,name:'Original name',version:1},after:{id:product,workspace_id:workspace,name:'Offline rename',version:2}})
    await expect(apply(value)).rejects.toThrow('offline_stock_product_changed')
    expect((await pg.query('SELECT quantity::float8 quantity FROM public.inventory')).rows).toEqual([{quantity:7}])
  })

})
