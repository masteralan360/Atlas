-- Snapshot of the deployed product reconciler before the 2026-09-16 recovery.
-- Used to execute the migration's actual function patch in isolated PostgreSQL.
CREATE OR REPLACE FUNCTION private.reconcile_product_sales_agent_commission(p_order_id uuid, p_order_return_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
  v_assignment crm.sales_order_agent_assignments%ROWTYPE;
  v_accrual crm.agent_commission_entries%ROWTYPE;
  v_rule crm.product_commission_rules%ROWTYPE;
  v_line jsonb;
  v_item_id text;
  v_product_id uuid;
  v_quantity numeric;
  v_returned numeric;
  v_net_quantity numeric;
  v_unit_price numeric;
  v_line_gross numeric;
  v_total_gross numeric;
  v_adjustment_net numeric;
  v_basis_per_unit numeric;
  v_per_unit numeric;
  v_fixed_converted numeric;
  v_product_total numeric := 0;
  v_product_basis numeric := 0;
  v_product_plan_share numeric := 0;
  v_normal_recognized numeric := 0;
  v_current_product_component numeric := 0;
  v_current_plan_component numeric := 0;
  v_product_delta numeric := 0;
  v_plan_delta numeric := 0;
  v_delta numeric;
  v_event_at timestamptz;
  v_eligible boolean;
  v_rule_agent_selected boolean;
  v_actor uuid := (SELECT auth.uid());
  v_changed integer := 0;
  v_source crm.agent_product_commission_entries%ROWTYPE;
  v_current_quantity numeric;
  v_target_quantity numeric;
  v_has_accrual boolean := false;
BEGIN
  -- The aggregate entry trigger remains authoritative for ordinary entries.
  -- Product-derived aggregate rows are admitted only while this server-side
  -- reconciler is running; clients have no INSERT grant on the snapshot table.
  PERFORM set_config('atlas.reconciling_product_commission', 'on', true);
  SELECT * INTO v_order FROM crm.sales_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF (SELECT auth.uid()) IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM v_order.workspace_id
    OR NOT EXISTS (
      SELECT 1 FROM public.workspaces AS workspace
      WHERE workspace.id = v_order.workspace_id
        AND workspace.deleted_at IS NULL
        AND public.workspace_module_allowed(workspace.id, workspace.plan::text, 'sales_agent_commissions')
    )
  THEN
    RAISE EXCEPTION 'Sales order is not available for product commission reconciliation'
      USING ERRCODE = '42501';
  END IF;
  v_eligible := COALESCE(v_order.commission_enabled, true) AND COALESCE(v_order.is_deleted, false) = false AND v_order.status <> 'cancelled' AND COALESCE(v_order.return_status, 'none') <> 'full';

  SELECT COALESCE(sum(
    CASE WHEN adjustment.value->>'type' = 'addition' THEN 1 ELSE -1 END
    * COALESCE(NULLIF(adjustment.value->>'converted_amount', '')::numeric, NULLIF(adjustment.value->>'convertedAmount', '')::numeric, 0)
  ), 0)
  INTO v_adjustment_net
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_order.order_adjustments) = 'array' THEN v_order.order_adjustments ELSE '[]'::jsonb END) AS adjustment(value);

  SELECT COALESCE(sum(
    GREATEST(COALESCE(NULLIF(value->>'quantity', '')::numeric, 0)
      - LEAST(
        GREATEST(COALESCE(NULLIF(value->>'quantity', '')::numeric, 0)
          + COALESCE(NULLIF(value->>'free_bonus_quantity', '')::numeric, NULLIF(value->>'freeBonusQuantity', '')::numeric, 0), 0),
        GREATEST(COALESCE(NULLIF(value->>'returned_quantity', '')::numeric, NULLIF(value->>'returnedQuantity', '')::numeric, 0), 0)
      ), 0)
    * GREATEST(COALESCE(NULLIF(value->>'converted_unit_price', '')::numeric, NULLIF(value->>'convertedUnitPrice', '')::numeric, 0), 0)
  ), 0)
  INTO v_total_gross
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_order.items) = 'array' THEN v_order.items ELSE '[]'::jsonb END) AS item(value);

  FOR v_assignment IN
    SELECT * FROM crm.sales_order_agent_assignments
    WHERE workspace_id = v_order.workspace_id AND order_id = v_order.id AND is_deleted = false
    ORDER BY id
  LOOP
    SELECT * INTO v_accrual FROM crm.agent_commission_entries
    WHERE workspace_id = v_order.workspace_id AND assignment_id = v_assignment.id AND kind = 'accrual' AND is_deleted = false
    ORDER BY occurred_at, created_at, id LIMIT 1;
    v_has_accrual := FOUND;
    v_event_at := GREATEST(v_assignment.assigned_at, COALESCE(v_order.actual_delivery_date, v_order.paid_at, v_order.updated_at));
    v_product_total := 0;
    v_product_basis := 0;
    v_product_plan_share := 0;

    FOR v_line IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_order.items) = 'array' THEN v_order.items ELSE '[]'::jsonb END)
    LOOP
      v_item_id := COALESCE(NULLIF(v_line->>'id', ''), NULLIF(v_line->>'line_id', ''), NULLIF(v_line->>'lineId', ''));
      IF v_item_id IS NULL THEN CONTINUE; END IF;
      BEGIN v_product_id := COALESCE(NULLIF(v_line->>'product_id', '')::uuid, NULLIF(v_line->>'productId', '')::uuid); EXCEPTION WHEN invalid_text_representation THEN CONTINUE; END;
      v_quantity := GREATEST(COALESCE(NULLIF(v_line->>'quantity', '')::numeric, 0), 0);
      v_returned := GREATEST(COALESCE(NULLIF(v_line->>'returned_quantity', '')::numeric, NULLIF(v_line->>'returnedQuantity', '')::numeric, 0), 0);
      v_net_quantity := GREATEST(v_quantity - v_returned, 0);
      v_unit_price := GREATEST(COALESCE(NULLIF(v_line->>'converted_unit_price', '')::numeric, NULLIF(v_line->>'convertedUnitPrice', '')::numeric, 0), 0);
      v_line_gross := v_net_quantity * v_unit_price;

      SELECT * INTO v_source FROM crm.agent_product_commission_entries
      WHERE workspace_id = v_order.workspace_id AND assignment_id = v_assignment.id AND order_id = v_order.id
        AND order_item_id = v_item_id AND kind = 'accrual' AND is_deleted = false
      ORDER BY occurred_at, created_at, id LIMIT 1;

      IF FOUND THEN
        SELECT COALESCE(sum(quantity), 0) INTO v_current_quantity
        FROM crm.agent_product_commission_entries
        WHERE workspace_id = v_order.workspace_id AND assignment_id = v_assignment.id AND order_id = v_order.id
          AND order_item_id = v_item_id AND is_deleted = false;
        v_target_quantity := CASE WHEN v_eligible AND v_assignment.unassigned_at IS NULL THEN v_net_quantity ELSE 0 END;
        IF abs(v_target_quantity - v_current_quantity) > 0.000001 THEN
          INSERT INTO crm.agent_product_commission_entries (
            id, workspace_id, order_id, assignment_id, agent_id, order_item_id, product_id,
            product_name_snapshot, product_sku_snapshot, unit_snapshot, rule_id, order_return_id,
            related_entry_id, kind, status, currency, commission_type, rate_percent,
            fixed_source_amount, fixed_source_currency, fixed_conversion_rate, fixed_exchange_rate_source,
            fixed_exchange_rate_timestamp, fixed_exchange_rates, quantity, basis_amount_per_unit,
            commission_per_unit, amount, occurred_at, notes, created_by, created_at, updated_at, sync_status, version, is_deleted
          ) VALUES (
            gen_random_uuid(), v_order.workspace_id, v_order.id, v_assignment.id, v_assignment.agent_id, v_source.order_item_id, v_source.product_id,
            v_source.product_name_snapshot, v_source.product_sku_snapshot, v_source.unit_snapshot, v_source.rule_id,
            CASE WHEN v_target_quantity < v_current_quantity THEN p_order_return_id ELSE NULL END,
            v_source.id, CASE WHEN v_target_quantity < v_current_quantity THEN 'reversal' ELSE 'adjustment' END,
            CASE WHEN v_target_quantity < v_current_quantity THEN 'reversed' ELSE 'earned' END,
            v_source.currency, v_source.commission_type, v_source.rate_percent,
            v_source.fixed_source_amount, v_source.fixed_source_currency, v_source.fixed_conversion_rate, v_source.fixed_exchange_rate_source,
            v_source.fixed_exchange_rate_timestamp, v_source.fixed_exchange_rates, v_target_quantity - v_current_quantity,
            v_source.basis_amount_per_unit, v_source.commission_per_unit,
            round((v_target_quantity - v_current_quantity) * v_source.commission_per_unit, 6), now(),
            'Product commission reconciled to committed sales order state', v_actor, now(), now(), 'synced', 1, false
          );
          v_changed := v_changed + 1;
        END IF;
        CONTINUE;
      END IF;

      CONTINUE WHEN NOT v_eligible OR v_assignment.unassigned_at IS NOT NULL OR v_net_quantity <= 0;
      SELECT * INTO v_rule FROM crm.product_commission_rules
      WHERE workspace_id = v_order.workspace_id AND product_id = v_product_id AND is_deleted = false AND is_active = true
        AND effective_from <= v_event_at AND (effective_to IS NULL OR v_event_at < effective_to)
      ORDER BY effective_from DESC LIMIT 1;
      CONTINUE WHEN NOT FOUND;
      SELECT EXISTS(SELECT 1 FROM crm.product_commission_rule_agents WHERE rule_id = v_rule.id AND agent_id = v_assignment.agent_id AND is_deleted = false)
      INTO v_rule_agent_selected;
      CONTINUE WHEN v_rule.recipient_scope = 'selected_assigned' AND NOT v_rule_agent_selected;

      v_basis_per_unit := round(GREATEST((v_line_gross
        - GREATEST(COALESCE(v_order.discount, 0), 0) * CASE WHEN v_total_gross > 0 THEN v_line_gross / v_total_gross ELSE 0 END
        + v_adjustment_net * CASE WHEN v_total_gross > 0 THEN v_line_gross / v_total_gross ELSE 0 END) / v_net_quantity, 0), 6);
      IF v_rule.commission_type = 'percentage' THEN
        v_per_unit := round(v_basis_per_unit * v_rule.rate_percent / 100, 6);
      ELSE
        v_fixed_converted := private.convert_sales_agent_commission_amount(v_rule.fixed_amount, v_rule.fixed_currency, v_order.currency, v_order.exchange_rates);
        IF v_fixed_converted IS NULL THEN
          RAISE EXCEPTION 'Exchange rate unavailable for the product commission currency on this sales order' USING ERRCODE = '23514';
        END IF;
        v_per_unit := round(v_fixed_converted, 6);
      END IF;
      INSERT INTO crm.agent_product_commission_entries (
        id, workspace_id, order_id, assignment_id, agent_id, order_item_id, product_id,
        product_name_snapshot, product_sku_snapshot, unit_snapshot, rule_id, order_return_id,
        related_entry_id, kind, status, currency, commission_type, rate_percent,
        fixed_source_amount, fixed_source_currency, fixed_conversion_rate, fixed_exchange_rate_source,
        fixed_exchange_rate_timestamp, fixed_exchange_rates, quantity, basis_amount_per_unit,
        commission_per_unit, amount, occurred_at, notes, created_by, created_at, updated_at, sync_status, version, is_deleted
      ) VALUES (
        gen_random_uuid(), v_order.workspace_id, v_order.id, v_assignment.id, v_assignment.agent_id, v_item_id, v_product_id,
        COALESCE(v_line->>'product_name', v_line->>'productName', 'Product'), COALESCE(v_line->>'product_sku', v_line->>'productSku'), COALESCE(v_line->>'unit'), v_rule.id,
        NULL, NULL, 'accrual', 'earned', v_order.currency, v_rule.commission_type,
        CASE WHEN v_rule.commission_type = 'percentage' THEN v_rule.rate_percent ELSE 0 END,
        CASE WHEN v_rule.commission_type = 'fixed_amount' THEN v_rule.fixed_amount ELSE NULL END,
        CASE WHEN v_rule.commission_type = 'fixed_amount' THEN v_rule.fixed_currency ELSE NULL END,
        CASE WHEN v_rule.commission_type = 'fixed_amount' AND v_rule.fixed_amount > 0 THEN v_fixed_converted / v_rule.fixed_amount ELSE NULL END,
        CASE WHEN v_rule.commission_type = 'fixed_amount' THEN 'order_snapshot' ELSE NULL END,
        CASE WHEN v_rule.commission_type = 'fixed_amount' THEN v_event_at ELSE NULL END,
        CASE WHEN v_rule.commission_type = 'fixed_amount' THEN v_order.exchange_rates ELSE NULL END,
        v_net_quantity, v_basis_per_unit, v_per_unit, round(v_net_quantity * v_per_unit, 6), v_event_at,
        'Product commission accrued from committed sales order state', v_actor, now(), now(), 'synced', 1, false
      );
      v_changed := v_changed + 1;
    END LOOP;

    SELECT
      COALESCE(sum(entry.amount), 0),
      COALESCE(sum(entry.quantity * entry.basis_amount_per_unit), 0)
    INTO v_product_total, v_product_basis
    FROM crm.agent_product_commission_entries AS entry
    WHERE entry.workspace_id = v_order.workspace_id
      AND entry.assignment_id = v_assignment.id
      AND entry.order_id = v_order.id
      AND entry.is_deleted = false;

    -- The normal reconciler has already brought the aggregate commission to
    -- zero for a full return. Product-line reversals above remain the audit
    -- detail; a second aggregate correction would overstate recovery due.
    IF COALESCE(v_order.return_status, 'none') = 'full' THEN
      CONTINUE;
    END IF;

    -- An agent can be product-commission-only. The normal reconciler has no
    -- plan/manual terms to accrue in that case, so create the one payable
    -- aggregate entry here. The immutable line rows above remain the detail.
    IF NOT v_has_accrual THEN
      IF abs(v_product_total) <= 0.000001 THEN
        CONTINUE;
      END IF;
      INSERT INTO crm.agent_commission_entries (
        id, workspace_id, order_id, assignment_id, agent_id, membership_id, plan_id, order_return_id, related_entry_id,
        kind, status, currency, calculation_basis, include_tax, include_delivery_charge,
        basis_amount, revenue_amount, cost_amount, tax_amount, delivery_charge_amount, rate_percent,
        plan_commission_amount, product_commission_amount, amount, occurred_at, payout_reference, settlement_source,
        notes, created_by, created_at, updated_at, sync_status, version, is_deleted
      ) VALUES (
        gen_random_uuid(), v_order.workspace_id, v_order.id, v_assignment.id, v_assignment.agent_id,
        NULL, NULL, NULL, NULL, 'accrual', 'earned', lower(v_order.currency::text), 'net_revenue', false, false,
        v_product_basis, v_product_basis, 0, 0, 0, 0,
        0, v_product_total, v_product_total, v_event_at, NULL, 'automatic',
        'Product commission accrued from committed sales order state', v_actor, now(), now(), 'synced', 1, false
      );
      v_changed := v_changed + 1;
      CONTINUE;
    END IF;

    -- The normal reconciler has already produced the whole-order target. A
    -- product rule replaces only its line's normal-plan share. This mirrors
    -- the client calculation: plan terms are apportioned by merchandise value
    -- and manual terms by the order total.
    SELECT COALESCE(sum(entry.amount), 0)
    INTO v_normal_recognized
    FROM crm.agent_commission_entries AS entry
    WHERE entry.workspace_id = v_order.workspace_id
      AND entry.assignment_id = v_assignment.id
      AND entry.order_id = v_order.id
      AND entry.currency = v_accrual.currency
      AND entry.kind IN ('accrual', 'reversal', 'adjustment')
      AND (entry.kind <> 'adjustment' OR entry.related_entry_id IS NOT NULL)
      AND entry.is_deleted = false;
    v_product_plan_share := CASE
      WHEN v_accrual.membership_id IS NULL AND v_accrual.plan_id IS NULL
        THEN CASE WHEN GREATEST(COALESCE(v_order.total, 0), 0) > 0
          THEN round(v_normal_recognized * LEAST(v_product_basis / GREATEST(v_order.total, 0), 1), 6)
          ELSE 0 END
      ELSE CASE WHEN GREATEST(v_total_gross - GREATEST(COALESCE(v_order.discount, 0), 0) + v_adjustment_net, 0) > 0
        THEN round(v_normal_recognized * LEAST(
          v_product_basis / GREATEST(v_total_gross - GREATEST(COALESCE(v_order.discount, 0), 0) + v_adjustment_net, 0),
          1
        ), 6)
        ELSE 0 END
    END;

    -- The core routine has just normalized the aggregate ledger to the
    -- current normal-plan target. Apply only this run's product replacement
    -- (product target less its normal-plan share); never subtract historical
    -- product components a second time after a return.
    v_product_delta := round(v_product_total, 6);
    v_plan_delta := round(-v_product_plan_share, 6);
    v_delta := round(v_product_delta + v_plan_delta, 6);
    IF abs(v_delta) > 0.000001 THEN
      INSERT INTO crm.agent_commission_entries (
        id, workspace_id, order_id, assignment_id, agent_id, membership_id, plan_id, order_return_id, related_entry_id,
        kind, status, currency, calculation_basis, include_tax, include_delivery_charge,
        basis_amount, revenue_amount, cost_amount, tax_amount, delivery_charge_amount, rate_percent,
        plan_commission_amount, product_commission_amount, amount, occurred_at, payout_reference, settlement_source,
        notes, created_by, created_at, updated_at, sync_status, version, is_deleted
      ) VALUES (
        gen_random_uuid(), v_order.workspace_id, v_order.id, v_assignment.id, v_assignment.agent_id,
        v_accrual.membership_id, v_accrual.plan_id, NULL, v_accrual.id,
        'adjustment', CASE WHEN v_delta < 0 THEN 'reversed' ELSE 'earned' END, v_accrual.currency, v_accrual.calculation_basis, v_accrual.include_tax, v_accrual.include_delivery_charge,
        v_accrual.basis_amount, v_accrual.revenue_amount, v_accrual.cost_amount, v_accrual.tax_amount, v_accrual.delivery_charge_amount, v_accrual.rate_percent,
        v_plan_delta, v_product_delta, v_delta, now(), NULL, 'automatic',
        'Product commission reconciled from immutable order-line snapshots', v_actor, now(), now(), 'synced', 1, false
      );
      v_changed := v_changed + 1;
    END IF;
  END LOOP;
  RETURN v_changed;
END;
$function$;
