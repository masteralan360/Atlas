-- An offline operation is one transaction. No stale inventory snapshot is
-- uploaded: relative movements are calculated under the inventory position lock.
-- A dedicated NOLOGIN/NOBYPASSRLS executor inherits authenticated table policies.
-- Only these functions can seal receipts; callers cannot forge their results.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='atlas_offline_stock_executor') THEN
    CREATE ROLE atlas_offline_stock_executor NOLOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$role$;
GRANT authenticated TO atlas_offline_stock_executor;
GRANT USAGE ON SCHEMA public,crm,extensions TO atlas_offline_stock_executor;
CREATE TABLE public.offline_stock_operation_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  actor_id uuid NOT NULL,
  operation jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offline_stock_operation_receipts_workspace_created
  ON public.offline_stock_operation_receipts(workspace_id, created_at, id);
ALTER TABLE public.offline_stock_operation_receipts ENABLE ROW LEVEL SECURITY;
-- Hosted projects may grant ALL on new public tables by default. Strip those
-- grants before restoring scoped receipt reads; TRUNCATE is not subject to RLS.
REVOKE ALL ON public.offline_stock_operation_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.offline_stock_operation_receipts TO authenticated;
GRANT SELECT, INSERT ON public.offline_stock_operation_receipts TO atlas_offline_stock_executor;
CREATE POLICY offline_stock_receipts_read ON public.offline_stock_operation_receipts
  FOR SELECT TO authenticated USING (workspace_id=public.current_workspace_id() AND actor_id=auth.uid());
CREATE POLICY offline_stock_receipts_insert ON public.offline_stock_operation_receipts
  FOR INSERT TO atlas_offline_stock_executor WITH CHECK (workspace_id=public.current_workspace_id() AND actor_id=auth.uid());

CREATE OR REPLACE FUNCTION public.apply_offline_stock_operation(p_operation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_id uuid := (p_operation->>'id')::uuid;
  v_workspace uuid := (p_operation->>'workspaceId')::uuid;
  v_kind text := p_operation->>'kind';
  v_receipt public.offline_stock_operation_receipts%ROWTYPE;
  v_effect jsonb;
  v_before jsonb;
  v_after jsonb;
  v_current jsonb;
  v_table text;
  v_schema text;
  v_relation regclass;
  v_columns text;
  v_updates text;
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_aliases jsonb := '[]'::jsonb;
  v_candidates jsonb;
  v_batch_limits jsonb := '{}'::jsonb;
  v_changes jsonb := '[]'::jsonb;
  v_movement jsonb;
  v_rpc text := p_operation->'rpc'->>'name';
  v_args jsonb := p_operation->'rpc'->'args';
  v_result jsonb;
  v_inventory public.inventory%ROWTYPE;
  v_delta numeric;
  v_completion jsonb;
  v_purchase jsonb;
  v_activation jsonb;
  v_loan_id uuid;
  v_batches jsonb;
  v_positions jsonb;
  v_position_batch jsonb;
  v_availability jsonb := '[]'::jsonb;
  v_stock_handled boolean := false;
  v_rebased jsonb;
  v_change jsonb;
  v_batch_before jsonb;
  v_batch_current jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_workspace IS DISTINCT FROM public.current_workspace_id()
    OR (p_operation->>'actorId')::uuid IS DISTINCT FROM auth.uid()
    OR COALESCE(public.current_user_role(),'') NOT IN ('admin','staff') THEN
    RAISE EXCEPTION 'offline_stock_actor_access_denied' USING ERRCODE='42501';
  END IF;
  IF (p_operation->>'version')::int IS DISTINCT FROM 1 OR v_id IS NULL
    OR v_kind IS NULL OR v_kind NOT IN ('adjustment','checkout','transfer','sales_order','purchase_order','return','exchange','product','storage','batch')
    OR jsonb_typeof(p_operation->'effects') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_operation->'effects') > 2000 THEN
    RAISE EXCEPTION 'invalid_offline_stock_operation' USING ERRCODE='23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('offline-stock:'||v_id::text,0));
  SELECT * INTO v_receipt FROM public.offline_stock_operation_receipts WHERE id=v_id;
  IF FOUND THEN
    IF v_receipt.operation IS DISTINCT FROM p_operation THEN
      RAISE EXCEPTION 'offline_stock_operation_identity_conflict' USING ERRCODE='23514';
    END IF;
    RETURN v_receipt.result;
  END IF;

  -- Lock and validate every requested row before any write. Table identifiers
  -- come from a closed list; no caller-controlled SQL or schema is executed.
  FOR v_effect IN SELECT value FROM jsonb_array_elements(p_operation->'effects') ORDER BY value->>'table',value->>'id' LOOP
    v_table := v_effect->>'table';
    IF v_table NOT IN ('business_partners','customers','suppliers','price_books','price_book_items','product_unit_conversions','price_book_unit_prices','products','product_uoms','product_barcodes','product_storage_assignments','inventory','inventory_transactions','stock_batches',
      'inventory_transfer_batches','sales','sale_items','sales_exchange','sale_returns','sale_return_items','sale_product_exchanges',
      'sales_orders','purchase_orders','order_returns','order_return_items','order_installments','payment_transactions','loans','loan_installments','loan_payments','storages') THEN
      RAISE EXCEPTION 'invalid_offline_stock_table' USING ERRCODE='23514';
    END IF;
    v_schema := CASE WHEN v_table IN ('business_partners','customers','suppliers','sales_orders','purchase_orders','order_installments') THEN 'crm' ELSE 'public' END;
    v_before := NULLIF(v_effect->'before','null'::jsonb);
    v_after := NULLIF(v_effect->'after','null'::jsonb);
    IF COALESCE(v_after->>'id',v_before->>'id') IS DISTINCT FROM v_effect->>'id'
      OR COALESCE(v_after->>'workspace_id',v_before->>'workspace_id')::uuid IS DISTINCT FROM v_workspace
      OR (v_before IS NOT NULL AND (v_before->>'workspace_id')::uuid IS DISTINCT FROM v_workspace) THEN
      RAISE EXCEPTION 'offline_stock_workspace_mismatch' USING ERRCODE='42501';
    END IF;
    EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=$1 AND workspace_id=$2 FOR UPDATE',v_schema,v_table)
      INTO v_current USING (v_effect->>'id')::uuid,v_workspace;
    IF v_kind='product' AND v_table='inventory' AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_operation->'effects')
      WHERE value->>'table'='products' AND value->>'id'=v_after->>'product_id' AND value->'after'->>'is_deleted'='true')
      AND (v_current IS NULL OR (v_current->>'version')::bigint IS DISTINCT FROM (v_before->>'version')::bigint) THEN
      RAISE EXCEPTION 'offline_stock_product_changed' USING ERRCODE='40001';
    END IF;
    -- Canonical checkout RPCs validate their own rows. Inventory is a relative
    -- movement; all document edits and batch changes retain revision checks.
    IF v_rpc IS NULL AND v_before - ARRAY['version','updated_at'] IS DISTINCT FROM v_after - ARRAY['version','updated_at'] AND v_table NOT IN ('inventory','inventory_transactions','products','product_storage_assignments') THEN
      IF v_before IS NULL AND v_current IS NOT NULL THEN
        RAISE EXCEPTION 'offline_stock_record_changed' USING ERRCODE='40001';
      ELSIF v_before IS NOT NULL AND (v_current IS NULL
        OR (v_before ? 'version' AND (v_before->>'version')::bigint IS DISTINCT FROM (v_current->>'version')::bigint)
        OR (NOT v_before ? 'version' AND (v_before->>'updated_at')::timestamptz IS DISTINCT FROM (v_current->>'updated_at')::timestamptz)) THEN
        RAISE EXCEPTION 'offline_stock_record_changed' USING ERRCODE='40001';
      END IF;
    END IF;
    IF v_table='sales_orders' AND COALESCE(v_before->>'status','')<>'completed' AND v_after->>'status'='completed' THEN v_completion := jsonb_set(v_effect,'{before}',COALESCE(v_before,'{}'::jsonb)||jsonb_build_object('version',(v_after->>'version')::int-1)); END IF;
    IF v_table IN ('sales_orders','purchase_orders') AND v_after->>'payment_method' IN ('loan','installments')
      AND v_after->>'linked_loan_id' IS NOT NULL AND v_before->>'linked_loan_id' IS NULL
      AND v_after->>'status' IN ('pending','ordered','received','completed') THEN
      v_activation := v_effect;
      IF v_table='sales_orders' AND v_after->>'status'='completed' THEN
        v_completion := jsonb_set(v_effect,'{before}',jsonb_build_object('version',(v_after->>'version')::int-1));
      END IF;
    END IF;
    IF v_table='purchase_orders' AND v_after->>'status' IN ('received','completed')
      AND COALESCE(v_before->>'status','') NOT IN ('received','completed') THEN v_purchase := v_effect; END IF;
  END LOOP;

  SELECT COALESCE(jsonb_object_agg(position.product_id::text||':'||position.storage_id::text,
    GREATEST(0,COALESCE((SELECT sum(b.quantity) FROM public.stock_batches b WHERE b.workspace_id=v_workspace AND b.product_id=position.product_id AND b.storage_id=position.storage_id AND NOT b.is_deleted),0)
      -COALESCE((SELECT i.quantity FROM public.inventory i WHERE i.workspace_id=v_workspace AND i.product_id=position.product_id AND i.storage_id=position.storage_id AND NOT i.is_deleted),0))),'{}'::jsonb)
  INTO v_batch_limits FROM (SELECT DISTINCT (value->'after'->>'product_id')::uuid product_id,(value->'after'->>'storage_id')::uuid storage_id
    FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table'='stock_batches') position;

  IF v_kind='adjustment' THEN
    SELECT value->'after' INTO v_movement FROM jsonb_array_elements(p_operation->'effects')
      WHERE value->>'table'='inventory_transactions' AND value->'after'->>'transaction_type'='stock_adjustment';
    IF v_movement IS NULL THEN RAISE EXCEPTION 'invalid_offline_stock_adjustment' USING ERRCODE='23514'; END IF;
    IF p_operation ? 'count' THEN
      SELECT * INTO v_inventory FROM public.inventory WHERE workspace_id=v_workspace
        AND product_id=(v_movement->>'product_id')::uuid AND storage_id=(v_movement->>'storage_id')::uuid FOR UPDATE;
      IF COALESCE(v_inventory.version,0) IS DISTINCT FROM (p_operation->'count'->>'version')::bigint THEN
        RAISE EXCEPTION 'offline_stock_count_changed' USING ERRCODE='40001';
      END IF;
      v_result := public.apply_stock_adjustment_to_target(v_movement,(p_operation->'count'->>'quantity')::numeric);
    ELSE
      v_result := public.apply_stock_adjustment(v_movement);
    END IF;
    v_stock_handled := true;
  ELSIF v_rpc IS NOT NULL THEN
    IF v_kind='checkout' AND v_rpc IN ('complete_pos_checkout','complete_sale_with_loan')
      AND (v_args->'payload'->>'workspace_id')::uuid=v_workspace AND (v_args->'payload'->>'id')::uuid=v_id THEN
      IF v_rpc='complete_pos_checkout' THEN
        v_result := public.complete_pos_checkout(v_args->'payload',(v_args->>'p_account_id')::uuid,v_args->>'p_account_name_snapshot');
      ELSE
        v_result := public.complete_sale_with_loan(v_args->'payload',v_args->'p_loan');
      END IF;
      v_stock_handled := true;
    ELSIF v_kind IN ('transfer','storage') AND v_rpc='apply_inventory_transfer_batch'
      AND (v_kind='storage' OR (v_args->>'p_operation_id')::uuid=v_id)
      AND (v_args->'p_payload'->'batch'->>'workspace_id')::uuid=v_workspace THEN
      v_rebased := '[]'::jsonb;
      FOR v_change IN SELECT value FROM jsonb_array_elements(v_args->'p_payload'->'inventory_changes') LOOP
        SELECT * INTO v_inventory FROM public.inventory WHERE workspace_id=(v_change->>'workspace_id')::uuid
          AND product_id=(v_change->>'product_id')::uuid AND storage_id=(v_change->>'storage_id')::uuid FOR UPDATE;
        v_rebased := v_rebased || jsonb_build_array(v_change || jsonb_build_object(
          'id',COALESCE(v_inventory.id,(v_change->>'id')::uuid),'expected_version',COALESCE(v_inventory.version,0),
          'quantity',COALESCE(v_inventory.quantity,0)+(v_change->>'quantity_delta')::numeric));
      END LOOP;
      v_args := jsonb_set(v_args,'{p_payload,inventory_changes}',v_rebased);
      v_rebased := '[]'::jsonb;
      FOR v_change IN SELECT value FROM jsonb_array_elements(v_args->'p_payload'->'stock_batch_changes') LOOP
        SELECT value->'before' INTO v_batch_before FROM jsonb_array_elements(p_operation->'effects')
          WHERE value->>'table'='stock_batches' AND value->>'id'=v_change->'row'->>'id';
        SELECT to_jsonb(batch) INTO v_batch_current FROM public.stock_batches batch WHERE id=(v_change->'row'->>'id')::uuid AND workspace_id=v_workspace FOR UPDATE;
        IF v_batch_before IS NOT NULL AND v_batch_before<>'null'::jsonb AND (
          v_batch_current IS NULL OR ROW(v_batch_before->>'product_id',v_batch_before->>'storage_id',v_batch_before->>'batch_number',v_batch_before->>'currency',v_batch_before->>'expiry_date',v_batch_before->>'manufacturing_date',v_batch_before->>'notes',v_batch_before->>'source_purchase_order_id',v_batch_before->>'source_purchase_order_item_id',(v_batch_before->>'price')::numeric,(v_batch_before->>'cost_price')::numeric) IS DISTINCT FROM ROW(v_batch_current->>'product_id',v_batch_current->>'storage_id',v_batch_current->>'batch_number',v_batch_current->>'currency',v_batch_current->>'expiry_date',v_batch_current->>'manufacturing_date',v_batch_current->>'notes',v_batch_current->>'source_purchase_order_id',v_batch_current->>'source_purchase_order_item_id',(v_batch_current->>'price')::numeric,(v_batch_current->>'cost_price')::numeric)) THEN
          RAISE EXCEPTION 'offline_stock_batch_changed' USING ERRCODE='40001';
        END IF;
        v_delta := (v_change->'row'->>'quantity')::numeric-COALESCE((v_batch_before->>'quantity')::numeric,0);
        v_rebased := v_rebased || jsonb_build_array(jsonb_build_object('expected_version',COALESCE((v_batch_current->>'version')::int,0),
          'row',v_change->'row' || jsonb_build_object('quantity',COALESCE((v_batch_current->>'quantity')::numeric,0)+v_delta,
            'version',COALESCE((v_batch_current->>'version')::int,0)+1)));
      END LOOP;
      v_args := jsonb_set(v_args,'{p_payload,stock_batch_changes}',v_rebased);
      v_result := public.apply_inventory_transfer_batch((v_args->>'p_operation_id')::uuid,v_args->'p_payload');
      IF COALESCE((v_result->>'conflict')::boolean,false) THEN RAISE EXCEPTION 'offline_stock_record_changed' USING ERRCODE='40001'; END IF;
      v_stock_handled := true;
    ELSIF v_kind='exchange' AND v_rpc='process_sale_product_exchange_with_account'
      AND EXISTS (SELECT 1 FROM public.sales WHERE id=(v_args->>'p_sale_id')::uuid AND workspace_id=v_workspace) THEN
      v_result := public.process_sale_product_exchange_with_account(
        (v_args->>'p_exchange_id')::uuid,(v_args->>'p_return_id')::uuid,(v_args->>'p_sale_id')::uuid,
        (v_args->>'p_return_sale_item_id')::uuid,(v_args->>'p_return_quantity')::numeric,
        (v_args->>'p_replacement_product_id')::uuid,(v_args->>'p_replacement_storage_id')::uuid,
        (v_args->>'p_replacement_quantity')::numeric,(v_args->>'p_replacement_unit_amount')::numeric,
        v_args->>'p_settlement_method',(v_args->>'p_account_id')::uuid,v_args->>'p_account_name_snapshot',
        v_args->>'p_note',v_args->>'p_return_reason');
      v_stock_handled := true;
    ELSIF v_kind='return' AND v_rpc='process_sale_return_with_loan'
      AND EXISTS (SELECT 1 FROM public.sales WHERE id=(v_args->>'p_sale_id')::uuid AND workspace_id=v_workspace) THEN
      v_result := public.process_sale_return_with_loan((v_args->>'p_return_id')::uuid,(v_args->>'p_sale_id')::uuid,
        v_args->'p_items',v_args->>'p_return_reason',v_args->>'p_refund_method');
      FOR v_effect IN SELECT value FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table'='payment_transactions'
        AND value->'after'->>'source_type'='pos_sale' LOOP
        v_after := v_effect->'after';
        IF (v_after->>'source_record_id')::uuid IS DISTINCT FROM (v_args->>'p_sale_id')::uuid
          OR (v_after->>'source_subrecord_id')::uuid IS DISTINCT FROM (v_args->>'p_return_id')::uuid THEN
          RAISE EXCEPTION 'invalid_offline_stock_refund' USING ERRCODE='23514';
        END IF;
        IF (v_after->>'amount')::numeric IS DISTINCT FROM -(SELECT refund_amount FROM public.sale_returns WHERE id=(v_args->>'p_return_id')::uuid AND workspace_id=v_workspace)
          OR v_after->>'direction' IS DISTINCT FROM 'incoming'
          OR v_after->>'currency' IS DISTINCT FROM (SELECT settlement_currency FROM public.sales WHERE id=(v_args->>'p_sale_id')::uuid AND workspace_id=v_workspace) THEN
          RAISE EXCEPTION 'invalid_offline_stock_refund_amount' USING ERRCODE='23514';
        END IF;
        INSERT INTO public.payment_transactions SELECT (jsonb_populate_record(NULL::public.payment_transactions,v_after)).*;
      END LOOP;
      v_stock_handled := true;
    ELSIF v_kind IN ('sales_order','purchase_order') AND v_rpc='cancel_order_with_financing'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table' IN ('sales_orders','purchase_orders') AND value->>'id'=v_args->>'p_order_id') THEN
      v_result := public.cancel_order_with_financing(v_args->>'p_order_type',(v_args->>'p_order_id')::uuid);
      v_stock_handled := true;
    ELSE
      RAISE EXCEPTION 'invalid_offline_stock_rpc' USING ERRCODE='23514';
    END IF;
  ELSE
    -- Create/update parent documents before payments. Derived inventory, audit
    -- entries and balances are committed only through their existing handlers.
    FOR v_effect IN SELECT value FROM jsonb_array_elements(p_operation->'effects')
      ORDER BY CASE value->>'table' WHEN 'business_partners' THEN 0 WHEN 'storages' THEN 0 WHEN 'customers' THEN 1 WHEN 'suppliers' THEN 1 WHEN 'products' THEN 1 WHEN 'sales_orders' THEN 2 WHEN 'purchase_orders' THEN 2 WHEN 'loans' THEN 3 WHEN 'loan_installments' THEN 5 WHEN 'loan_payments' THEN 6 WHEN 'payment_transactions' THEN 4 ELSE 3 END LOOP
      v_table := v_effect->>'table';
      IF v_table IN ('inventory','inventory_transactions') OR (v_table='sales_orders' AND v_effect->>'id'=v_completion->>'id' AND v_effect->'before'->>'status'='pending' AND v_activation IS NULL) THEN CONTINUE; END IF;
      IF v_activation IS NOT NULL AND (v_table IN ('loans','loan_installments','loan_payments') OR (v_table='payment_transactions' AND v_effect->'after'->>'source_type' IN ('loan_payment','simple_loan','loan','installment_payment'))) THEN CONTINUE; END IF;
      IF v_purchase IS NOT NULL AND v_table='stock_batches' THEN CONTINUE; END IF;
      v_after := NULLIF(v_effect->'after','null'::jsonb);
      v_before := NULLIF(v_effect->'before','null'::jsonb);
      IF v_table IN ('products','storages') AND COALESCE((v_after->>'is_deleted')::boolean,false) THEN CONTINUE; END IF;
      IF v_after IS NULL THEN
        -- Business deletions must be tombstones so their audit history survives.
        RAISE EXCEPTION 'offline_stock_hard_delete_not_supported' USING ERRCODE='23514';
      END IF;
      IF v_before IS NOT NULL AND v_after - ARRAY['version','updated_at'] = v_before - ARRAY['version','updated_at'] THEN CONTINUE; END IF;
      IF v_table='products' AND v_before IS NOT NULL THEN
        SELECT to_jsonb(row) INTO v_current FROM public.products row WHERE id=(v_effect->>'id')::uuid AND workspace_id=v_workspace FOR UPDATE;
        IF EXISTS (SELECT 1 FROM jsonb_each(v_after) change WHERE key NOT IN ('id','workspace_id','version','updated_at')
          AND v_before->key IS DISTINCT FROM value AND v_current->key IS DISTINCT FROM v_before->key) THEN
          RAISE EXCEPTION 'offline_stock_product_changed' USING ERRCODE='40001';
        END IF;
        -- Stock snapshot updates must not overwrite newer catalog edits.
        SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO v_after FROM jsonb_each(v_after)
          WHERE v_before->key IS DISTINCT FROM value OR key IN ('id','workspace_id');
        IF v_after - ARRAY['id','workspace_id','version','updated_at'] = '{}'::jsonb THEN CONTINUE; END IF;
        v_after := jsonb_set(v_after,'{version}',to_jsonb((v_current->>'version')::int+1));
      END IF;
      IF v_table='sales_orders' AND v_effect->>'id'=v_completion->>'id' AND v_activation IS NULL THEN
        v_after := jsonb_set(jsonb_set(v_after,'{status}','"pending"'::jsonb),'{version}',to_jsonb((v_effect->'after'->>'version')::int-1));
      END IF;
      IF v_effect=v_purchase THEN v_after := jsonb_set(jsonb_set(v_after,'{status}','"ordered"'::jsonb),'{version}',to_jsonb(GREATEST(1,(v_after->>'version')::int-1))); END IF;
      IF v_effect=v_activation THEN
        v_after := jsonb_set(jsonb_set(jsonb_set(v_after,'{status}','"draft"'::jsonb),'{linked_loan_id}','null'::jsonb),
          '{version}',to_jsonb((v_effect->'after'->>'version')::int-CASE WHEN v_completion IS NOT NULL OR v_purchase IS NOT NULL THEN 2 ELSE 1 END));
      END IF;
      -- These are assigned by the authoritative source, never by an offline counter.
      v_after := v_after - ARRAY['sequence_id','order_number','transfer_number','voucher_number'];
      v_schema := CASE WHEN v_table IN ('business_partners','customers','suppliers','sales_orders','purchase_orders','order_installments') THEN 'crm' ELSE 'public' END;
      v_relation := format('%I.%I',v_schema,v_table)::regclass;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_after) supplied(name) WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=v_relation AND attname=supplied.name AND attnum>0 AND NOT attisdropped AND attgenerated='')) THEN
        RAISE EXCEPTION 'invalid_offline_stock_field' USING ERRCODE='23514';
      END IF;
      SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),
        string_agg(format('%I=EXCLUDED.%I',attname,attname),',' ORDER BY attnum) FILTER (WHERE attname NOT IN ('id','workspace_id','created_at'))
      INTO v_columns,v_updates FROM pg_catalog.pg_attribute
      WHERE attrelid=v_relation AND attnum>0 AND NOT attisdropped AND attgenerated='' AND v_after ? attname;
      EXECUTE format('INSERT INTO %I.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::%I.%I,$1) ON CONFLICT (id) DO UPDATE SET %s RETURNING to_jsonb(%I.*)',
        v_schema,v_table,v_columns,v_columns,v_schema,v_table,v_updates,v_table) INTO v_row USING v_after;
    END LOOP;

    IF v_activation IS NOT NULL THEN
      v_result := public.activate_financed_order(CASE WHEN v_activation->>'table'='sales_orders' THEN 'sales' ELSE 'purchase' END,
        (v_activation->>'id')::uuid,CASE WHEN v_activation->>'table'='sales_orders' THEN 'pending' ELSE 'ordered' END);
      v_loan_id := (v_result->>'loan_id')::uuid;
      IF v_loan_id IS DISTINCT FROM (v_activation->'after'->>'linked_loan_id')::uuid THEN
        RAISE EXCEPTION 'offline_stock_loan_identity_conflict' USING ERRCODE='23514';
      END IF;
    END IF;

    IF v_purchase IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id',value->'after'->>'id','item_index',(SELECT (line.ordinality-1)::int FROM jsonb_array_elements(v_purchase->'after'->'items') WITH ORDINALITY line(value,ordinality) WHERE line.value->>'id'=value->'after'->>'source_purchase_order_item_id' LIMIT 1),
        'product_id',value->'after'->>'product_id','storage_id',value->'after'->>'storage_id','quantity',value->'after'->'quantity',
        'source_item_id',value->'after'->>'source_purchase_order_item_id','batch_number',value->'after'->>'batch_number',
        'price',value->'after'->'price','cost_price',value->'after'->'cost_price','currency',value->'after'->>'currency',
        'expiry_date',value->'after'->>'expiry_date','manufacturing_date',value->'after'->>'manufacturing_date')),'[]'::jsonb)
      INTO v_batches FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table'='stock_batches';
      v_result := public.receive_purchase_order((v_purchase->>'id')::uuid,v_purchase->'after'->>'status',v_batches);
      v_stock_handled := true;
    END IF;

    IF NOT v_stock_handled THEN
      FOR v_effect IN SELECT value FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table'='inventory' ORDER BY value->'after'->>'product_id',value->'after'->>'storage_id' LOOP
        v_before := NULLIF(v_effect->'before','null'::jsonb); v_after := v_effect->'after';
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('inventory:'||v_workspace::text||':'||(v_after->>'product_id')||':'||(v_after->>'storage_id'),0));
        SELECT * INTO v_inventory FROM public.inventory WHERE workspace_id=v_workspace AND product_id=(v_after->>'product_id')::uuid AND storage_id=(v_after->>'storage_id')::uuid FOR UPDATE;
        IF p_operation ? 'count' AND (p_operation->'count'->>'productId')=v_after->>'product_id'
          AND (p_operation->'count'->>'storageId')=v_after->>'storage_id'
          AND COALESCE(v_inventory.version,0) IS DISTINCT FROM (p_operation->'count'->>'version')::bigint THEN
          RAISE EXCEPTION 'offline_stock_count_changed' USING ERRCODE='40001';
        END IF;
        v_delta := COALESCE((v_after->>'quantity')::numeric,0)-COALESCE((v_before->>'quantity')::numeric,0);
        SELECT value->'after' INTO v_movement FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table'='inventory_transactions'
          AND value->'after'->>'product_id'=v_after->>'product_id' AND value->'after'->>'storage_id'=v_after->>'storage_id' LIMIT 1;
        v_changes := v_changes || jsonb_build_array(jsonb_build_object('id',COALESCE(v_inventory.id,(v_after->>'id')::uuid),
          'product_id',v_after->>'product_id','storage_id',v_after->>'storage_id','quantity',COALESCE(v_inventory.quantity,0)+v_delta,
          'expected_version',COALESCE(v_inventory.version,0),'audit_transaction_type',COALESCE(v_movement->>'transaction_type','inventory_change'),
          'audit_reference_id',COALESCE(v_movement->>'reference_id',v_id::text),'audit_reference_type',COALESCE(v_movement->>'reference_type','offline_stock_operation'),
          'audit_notes',v_movement->>'notes','audit_created_by',auth.uid()));
      END LOOP;
      IF v_completion IS NOT NULL THEN
        v_result := public.complete_sales_order_with_inventory((v_completion->>'id')::uuid,v_workspace,
          (SELECT version::bigint FROM crm.sales_orders WHERE id=(v_completion->>'id')::uuid AND workspace_id=v_workspace),
          extensions.uuid_generate_v5('29a34eb1-80c0-5cf9-8bc1-0bbb71fd718b'::uuid,v_completion->>'id'),
          v_completion->'after'->'items',(v_completion->'after'->>'actual_delivery_date')::timestamptz,v_changes);
      ELSIF jsonb_array_length(v_changes)>0 THEN
        v_result := public.apply_inventory_snapshot_changes(v_id,v_workspace,'inventory_movement',v_changes);
      END IF;
      IF COALESCE((v_result->>'conflict')::boolean,false) THEN RAISE EXCEPTION 'offline_stock_record_changed' USING ERRCODE='40001'; END IF;
    END IF;
  END IF;

  IF v_kind IN ('product','storage') THEN
    FOR v_effect IN SELECT value FROM jsonb_array_elements(p_operation->'effects')
      WHERE value->>'table' IN ('products','storages') AND value->'after'->>'is_deleted'='true' LOOP
      IF EXISTS (SELECT 1 FROM public.inventory WHERE workspace_id=v_workspace AND NOT is_deleted AND quantity<>0
        AND CASE WHEN v_effect->>'table'='products' THEN product_id=(v_effect->>'id')::uuid ELSE storage_id=(v_effect->>'id')::uuid END) THEN
        RAISE EXCEPTION 'offline_stock_delete_requires_empty_inventory' USING ERRCODE='40001';
      END IF;
      EXECUTE format('UPDATE public.%I SET is_deleted=true,updated_at=now(),version=version+1 WHERE id=$1 AND workspace_id=$2',v_effect->>'table')
        USING (v_effect->>'id')::uuid,v_workspace;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM public.stock_batches b WHERE b.workspace_id=v_workspace AND NOT b.is_deleted
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_operation->'effects') e WHERE e->>'table'='stock_batches' AND e->'after'->>'product_id'=b.product_id::text AND e->'after'->>'storage_id'=b.storage_id::text)
      GROUP BY b.product_id,b.storage_id HAVING sum(b.quantity) > COALESCE((SELECT i.quantity FROM public.inventory i WHERE i.workspace_id=v_workspace AND i.product_id=b.product_id AND i.storage_id=b.storage_id AND NOT i.is_deleted),0)+COALESCE((v_batch_limits->>(b.product_id::text||':'||b.storage_id::text))::numeric,0)+0.000001) THEN
    RAISE EXCEPTION 'offline_stock_batch_quantity_exceeds_inventory' USING ERRCODE='23514';
  END IF;

  -- Flush authoritative deferred audit/payment triggers before collecting the
  -- receipt, so generated child IDs are part of the same durable result.
  SET CONSTRAINTS ALL IMMEDIATE;
  FOR v_effect IN SELECT value FROM jsonb_array_elements(p_operation->'effects') LOOP
    v_table := v_effect->>'table';
    v_schema := CASE WHEN v_table IN ('business_partners','customers','suppliers','sales_orders','purchase_orders','order_installments') THEN 'crm' ELSE 'public' END;
    IF v_table='inventory' THEN
      SELECT to_jsonb(row) INTO v_row FROM public.inventory row WHERE workspace_id=v_workspace
        AND product_id=(v_effect->'after'->>'product_id')::uuid AND storage_id=(v_effect->'after'->>'storage_id')::uuid;
    ELSE
      EXECUTE format('SELECT to_jsonb(row) FROM %I.%I row WHERE id=$1 AND workspace_id=$2',v_schema,v_table) INTO v_row USING (v_effect->>'id')::uuid,v_workspace;
    END IF;
    IF v_row IS NULL AND v_effect->'after' IS NOT NULL THEN
      v_after := v_effect->'after';
      v_candidates := '[]'::jsonb;
      IF v_table='sale_return_items' THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(row)),'[]'::jsonb) INTO v_candidates FROM public.sale_return_items row
          WHERE workspace_id=v_workspace AND return_id=(v_after->>'return_id')::uuid AND sale_item_id=(v_after->>'sale_item_id')::uuid;
      ELSIF v_table='sale_items' AND v_rpc='process_sale_product_exchange_with_account' THEN
        SELECT jsonb_agg(to_jsonb(row)) INTO v_candidates FROM public.sale_items row WHERE workspace_id=v_workspace
          AND id=(SELECT replacement_sale_item_id FROM public.sale_product_exchanges WHERE id=(v_args->>'p_exchange_id')::uuid AND workspace_id=v_workspace);
      ELSIF v_table='loan_payments' AND v_rpc='process_sale_return_with_loan' THEN
        SELECT jsonb_agg(to_jsonb(row)) INTO v_candidates FROM public.loan_payments row WHERE workspace_id=v_workspace
          AND id=(v_args->>'p_return_id')::uuid AND loan_id=(v_after->>'loan_id')::uuid AND amount=(v_after->>'amount')::numeric;
      ELSIF v_table='loan_payments' AND v_rpc='process_sale_product_exchange_with_account' THEN
        SELECT jsonb_agg(to_jsonb(row)) INTO v_candidates FROM public.loan_payments row WHERE workspace_id=v_workspace
          AND loan_id=(v_after->>'loan_id')::uuid AND amount=(v_after->>'amount')::numeric
          AND id IN (SELECT source_subrecord_id FROM public.payment_transactions WHERE workspace_id=v_workspace
            AND source_record_id=(v_after->>'loan_id')::uuid AND metadata->>'saleProductExchangeId'=v_args->>'p_exchange_id');
      ELSIF v_table IN ('inventory_transactions','payment_transactions') THEN
        -- Match a generated child only when its business reference is unique
        -- in this transaction. A missing/ambiguous mapping rolls everything back.
        EXECUTE format($query$SELECT COALESCE(jsonb_agg(candidate),'[]'::jsonb) FROM (
          SELECT to_jsonb(row) candidate FROM public.%I row WHERE workspace_id=$1
            AND (to_jsonb(row)->>'created_at')::timestamptz>=transaction_timestamp()
            AND CASE WHEN $2='inventory_transactions' THEN
              to_jsonb(row)->>'product_id'=$3->>'product_id' AND to_jsonb(row)->>'storage_id'=$3->>'storage_id'
              AND to_jsonb(row)->>'reference_id' IS NOT DISTINCT FROM $3->>'reference_id'
              AND to_jsonb(row)->>'transaction_type'=$3->>'transaction_type'
              AND (to_jsonb(row)->>'quantity_delta')::numeric=($3->>'quantity_delta')::numeric
            ELSE to_jsonb(row)->>'source_record_id'=$3->>'source_record_id'
              AND to_jsonb(row)->>'reversal_of_transaction_id' IS NOT DISTINCT FROM $3->>'reversal_of_transaction_id'
              AND to_jsonb(row)->>'source_type'=$3->>'source_type'
              AND (to_jsonb(row)->>'amount')::numeric=($3->>'amount')::numeric
              AND to_jsonb(row)->>'currency'=$3->>'currency' END LIMIT 2) matches$query$,v_table)
          INTO v_candidates USING v_workspace,v_table,v_after;
      END IF;
      IF jsonb_array_length(COALESCE(v_candidates,'[]'::jsonb))=1 THEN v_row := v_candidates->0; END IF;
    END IF;
    IF v_row IS NULL THEN RAISE EXCEPTION 'offline_stock_authoritative_child_missing' USING ERRCODE='23514'; END IF;
    IF v_row->>'id' IS DISTINCT FROM v_effect->>'id' THEN
      v_aliases := v_aliases || jsonb_build_array(jsonb_build_object('table',v_table,'from',v_effect->>'id','to',v_row->>'id'));
    END IF;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('table',v_table,'row',v_row));
  END LOOP;
  SELECT COALESCE(jsonb_agg(position),'[]'::jsonb) INTO v_positions FROM (
    SELECT DISTINCT jsonb_build_object('productId',value->'after'->>'product_id','storageId',value->'after'->>'storage_id') position
    FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table'='inventory'
  ) positions;
  IF to_regprocedure('public.get_stock_reservation_availability(uuid,jsonb,uuid)') IS NOT NULL THEN
    FOR v_position_batch IN SELECT jsonb_agg(value) FROM jsonb_array_elements(v_positions) WITH ORDINALITY position(value,ordinality) GROUP BY (ordinality-1)/200 LOOP
      v_availability := v_availability||public.get_stock_reservation_availability(v_workspace,v_position_batch,NULL);
    END LOOP;
  END IF;
  v_result := jsonb_build_object('id',v_id,'rows',v_rows,'aliases',v_aliases,'availability',v_availability);
  INSERT INTO public.offline_stock_operation_receipts(id,workspace_id,actor_id,operation,result) VALUES(v_id,v_workspace,auth.uid(),p_operation,v_result);
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_offline_stock_operation(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_offline_stock_operation(jsonb) TO authenticated;

-- Stable line identities allow a return queued after an offline checkout to
-- reference the same sale item after the checkout's authoritative replay.
DO $migration$
DECLARE definition text; original text;
BEGIN
  IF to_regprocedure('private.complete_sale_once(jsonb)') IS NULL THEN RETURN; END IF;
  SELECT pg_get_functiondef('private.complete_sale_once(jsonb)'::regprocedure) INTO definition;
  IF position('atlas_offline_line_id' IN definition)>0 THEN RETURN; END IF;
  original := definition;
  definition := regexp_replace(definition,
    $pattern$INSERT INTO public.sale_items \(\s*sale_id,$pattern$,
    'INSERT INTO public.sale_items (id, sale_id,','i');
  definition := regexp_replace(definition,
    $pattern$VALUES \(\s*new_sale_id,\s*v_product_id,$pattern$,
    $replacement$VALUES (COALESCE(NULLIF(item->>'id','')::uuid, pg_catalog.gen_random_uuid()) /* atlas_offline_line_id */, new_sale_id, v_product_id,$replacement$,'i');
  IF definition=original OR position('atlas_offline_line_id' IN definition)=0 THEN
    RAISE EXCEPTION 'Could not install stable offline sale line identities';
  END IF;
  EXECUTE definition;
END;
$migration$;

-- Existing linked loans retain their IDs. New order loans/installments use
-- stable business identities so an offline activation can be replayed once.
DO $migration$
DECLARE definition text; signature regprocedure;
BEGIN
  signature := to_regprocedure('public.create_order_financing_loan(uuid,text,uuid,text,uuid,text,text,numeric,text,jsonb,integer,text,date,uuid)');
  IF signature IS NULL THEN RETURN; END IF;
  SELECT pg_get_functiondef(signature) INTO definition;
  IF position('offline-order-loan:' IN definition)>0 THEN RETURN; END IF;
  definition := replace(definition,'v_loan_id uuid := gen_random_uuid();',
    $replacement$v_loan_id uuid := extensions.uuid_generate_v5('6ba7b811-9dad-11d1-80b4-00c04fd430c8'::uuid,'offline-order-loan:'||p_order_type||':'||p_order_id::text);$replacement$);
  definition := replace(definition,'gen_random_uuid(), v_loan_id, p_workspace_id, v_index,',
    $replacement$extensions.uuid_generate_v5('6ba7b811-9dad-11d1-80b4-00c04fd430c8'::uuid,v_loan_id::text||':'||v_index::text), v_loan_id, p_workspace_id, v_index,$replacement$);
  IF position('offline-order-loan:' IN definition)=0 THEN RAISE EXCEPTION 'Could not install replayable order financing identities'; END IF;
  EXECUTE definition;
END;
$migration$;

DO $migration$
DECLARE definition text; signature regprocedure;
BEGIN
  signature := to_regprocedure('public.activate_financed_order(text,uuid,text)');
  IF signature IS NULL THEN RETURN; END IF;
  SELECT pg_get_functiondef(signature) INTO definition;
  definition := replace(definition,'v_loan_payment_id := gen_random_uuid();',
    $replacement$v_loan_payment_id := extensions.uuid_generate_v5('6ba7b811-9dad-11d1-80b4-00c04fd430c8'::uuid,'offline-order-repayment:'||p_order_type||':'||p_order_id::text);$replacement$);
  definition := replace(definition,'v_loan_transaction_id := gen_random_uuid();',
    $replacement$v_loan_transaction_id := extensions.uuid_generate_v5('6ba7b811-9dad-11d1-80b4-00c04fd430c8'::uuid,'offline-order-repayment-ledger:'||p_order_type||':'||p_order_id::text);$replacement$);
  EXECUTE definition;
END;
$migration$;

-- Cancelling an unconfirmed physical count fences delayed retries with the same
-- operation ID. This endpoint cannot discard a sale, payment, or relative move.
CREATE OR REPLACE FUNCTION public.cancel_offline_stock_count(p_operation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE
  operation_id uuid := (p_operation->>'id')::uuid;
  workspace uuid := (p_operation->>'workspaceId')::uuid;
  receipt public.offline_stock_operation_receipts%ROWTYPE;
  effect jsonb; confirmed jsonb; rows jsonb := '[]'::jsonb; positions jsonb := '[]'::jsonb;
  availability jsonb := '[]'::jsonb; result jsonb;
BEGIN
  IF auth.uid() IS NULL OR (p_operation->>'actorId')::uuid IS DISTINCT FROM auth.uid()
    OR workspace IS DISTINCT FROM public.current_workspace_id() OR COALESCE(public.current_user_role(),'') NOT IN ('admin','staff') THEN
    RAISE EXCEPTION 'offline_stock_actor_access_denied' USING ERRCODE='42501';
  END IF;
  IF operation_id IS NULL OR (p_operation->>'version')::int IS DISTINCT FROM 1 OR p_operation->>'kind' IS DISTINCT FROM 'adjustment'
    OR NOT p_operation ? 'count' OR jsonb_typeof(p_operation->'effects') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_operation->'effects')>2000
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table' NOT IN ('products','inventory','inventory_transactions')
      OR (COALESCE(value->'after',value->'before')->>'workspace_id')::uuid IS DISTINCT FROM workspace
      OR (value->>'table'='inventory_transactions' AND value->'before'<>'null'::jsonb)) THEN
    RAISE EXCEPTION 'offline_stock_count_discard_unavailable' USING ERRCODE='23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('offline-stock:'||operation_id::text,0));
  SELECT * INTO receipt FROM public.offline_stock_operation_receipts WHERE id=operation_id;
  IF FOUND THEN
    IF receipt.operation IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'offline_stock_operation_identity_conflict' USING ERRCODE='23514'; END IF;
    RETURN receipt.result;
  END IF;
  FOR effect IN SELECT value FROM jsonb_array_elements(p_operation->'effects') WHERE value->>'table' IN ('products','inventory') LOOP
    IF effect->>'table'='inventory' THEN
      SELECT to_jsonb(row) INTO confirmed FROM public.inventory row WHERE workspace_id=workspace
        AND product_id=(effect->'after'->>'product_id')::uuid AND storage_id=(effect->'after'->>'storage_id')::uuid FOR UPDATE;
      IF confirmed IS NULL THEN confirmed := effect->'after'||jsonb_build_object('quantity',0,'version',0,'is_deleted',true); END IF;
      positions := positions||jsonb_build_array(jsonb_build_object('productId',effect->'after'->>'product_id','storageId',effect->'after'->>'storage_id'));
    ELSE
      SELECT to_jsonb(row) INTO confirmed FROM public.products row WHERE workspace_id=workspace AND id=(effect->>'id')::uuid FOR UPDATE;
      IF confirmed IS NULL THEN RAISE EXCEPTION 'offline_stock_actor_access_denied' USING ERRCODE='42501'; END IF;
    END IF;
    rows := rows||jsonb_build_array(jsonb_build_object('table',effect->>'table','row',confirmed));
  END LOOP;
  IF to_regprocedure('public.get_stock_reservation_availability(uuid,jsonb,uuid)') IS NOT NULL THEN availability := public.get_stock_reservation_availability(workspace,positions,NULL); END IF;
  result := jsonb_build_object('id',operation_id,'discarded',true,'rows',rows,'availability',availability);
  INSERT INTO public.offline_stock_operation_receipts(id,workspace_id,actor_id,operation,result) VALUES(operation_id,workspace,auth.uid(),p_operation,result);
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_offline_stock_count(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.cancel_offline_stock_count(jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';

-- The owner is never a table owner or a BYPASSRLS role. It has exactly the
-- authenticated role's business permissions plus the ability to seal receipts.
-- Supabase's migration role may have CREATEROLE without SUPERUSER. Explicit
-- membership permits ownership transfer on PostgreSQL versions where newly
-- created roles do not automatically grant SET ROLE to their creator.
DO $owner$
BEGIN
  EXECUTE format('GRANT atlas_offline_stock_executor TO %I',current_user);
END;
$owner$;
GRANT CREATE ON SCHEMA public TO atlas_offline_stock_executor;
ALTER FUNCTION public.apply_offline_stock_operation(jsonb) OWNER TO atlas_offline_stock_executor;
ALTER FUNCTION public.cancel_offline_stock_count(jsonb) OWNER TO atlas_offline_stock_executor;
REVOKE CREATE ON SCHEMA public FROM atlas_offline_stock_executor;
