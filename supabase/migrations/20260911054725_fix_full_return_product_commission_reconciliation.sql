-- The normal core first restores the aggregate ledger to the current
-- normal-plan target. Product reconciliation then supplies only the current
-- product replacement delta. This avoids replaying historical product
-- components during full or partial returns.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
  v_anchor text := E'    -- An agent can be product-commission-only. The normal reconciler has no\n';
  v_guard text := E'    -- The normal reconciler has already brought the aggregate commission to\n    -- zero for a full return. Product-line reversals above remain the audit\n    -- detail; a second aggregate correction would overstate recovery due.\n    IF COALESCE(v_order.return_status, ''none'') = ''full'' THEN\n      CONTINUE;\n    END IF;\n\n';
  v_component_logic text := E'    SELECT\n      COALESCE(sum(entry.product_commission_amount), 0),\n      COALESCE(sum(entry.plan_commission_amount), 0)\n    INTO v_current_product_component, v_current_plan_component\n    FROM crm.agent_commission_entries AS entry\n    WHERE entry.workspace_id = v_order.workspace_id\n      AND entry.assignment_id = v_assignment.id\n      AND entry.order_id = v_order.id\n      AND entry.product_commission_amount IS NOT NULL\n      AND entry.is_deleted = false;\n    v_product_delta := round(v_product_total - v_current_product_component, 6);\n    v_plan_delta := round(-v_product_plan_share - v_current_plan_component, 6);\n    v_delta := round(v_product_delta + v_plan_delta, 6);\n';
  v_component_replacement text := E'    -- The core routine has just normalized the aggregate ledger to the\n    -- current normal-plan target. Apply only this run''s product replacement\n    -- (product target less its normal-plan share); never subtract historical\n    -- product components a second time after a return.\n    v_product_delta := round(v_product_total, 6);\n    v_plan_delta := round(-v_product_plan_share, 6);\n    v_delta := round(v_product_delta + v_plan_delta, 6);\n';
BEGIN
  SELECT pg_get_functiondef('private.reconcile_product_sales_agent_commission(uuid, uuid)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');

  IF position('a second aggregate correction would overstate recovery due' IN v_definition) = 0 THEN
    v_replaced := replace(v_definition, v_anchor, v_guard || v_anchor);
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not add the full-return guard to product commission reconciliation';
    END IF;
    v_definition := v_replaced;
  END IF;

  IF position('never subtract historical' IN v_definition) = 0 THEN
    v_replaced := replace(
      v_definition,
      E'      AND entry.product_commission_amount IS NULL\n',
      ''
    );
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not use the core-normalized target for product commission reconciliation';
    END IF;
    v_definition := replace(v_replaced, v_component_logic, v_component_replacement);
    IF position('never subtract historical' IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Could not replace historical product-component reconciliation';
    END IF;
  END IF;

  -- The core entry owns the return link and is the one reversal permitted for
  -- an assignment/return pair. A product replacement can itself be negative
  -- (for example, when its configured rate is below the normal-plan share),
  -- so it remains an unlinked aggregate adjustment.
  IF position('CASE WHEN v_delta < 0 THEN p_order_return_id ELSE NULL END' IN v_definition) > 0 THEN
    v_replaced := replace(
      v_definition,
      'CASE WHEN v_delta < 0 THEN p_order_return_id ELSE NULL END',
      'NULL'
    );
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not detach product aggregate adjustments from order returns';
    END IF;
    v_definition := v_replaced;
  END IF;

  EXECUTE v_definition;
END;
$block$;

-- Do not rewrite immutable history. If an older deployment already accepted a
-- duplicate product correction for a fully returned order, append one
-- balancing adjustment so its recognized commission returns to zero. Payouts
-- and recoveries are intentionally excluded: this restores the obligation,
-- leaving only the actual amount paid recoverable from the agent.
DO $block$
DECLARE
  v_balance record;
BEGIN
  FOR v_balance IN
    SELECT
      accrual.workspace_id,
      accrual.order_id,
      accrual.assignment_id,
      accrual.agent_id,
      accrual.membership_id,
      accrual.plan_id,
      accrual.id AS accrual_id,
      accrual.currency,
      accrual.calculation_basis,
      accrual.include_tax,
      accrual.include_delivery_charge,
      accrual.basis_amount,
      accrual.revenue_amount,
      accrual.cost_amount,
      accrual.tax_amount,
      accrual.delivery_charge_amount,
      accrual.rate_percent,
      round(COALESCE(sum(entry.amount), 0), 6) AS recognized_amount
    FROM crm.sales_orders AS sales_order
    JOIN crm.agent_commission_entries AS accrual
      ON accrual.workspace_id = sales_order.workspace_id
      AND accrual.order_id = sales_order.id
      AND accrual.kind = 'accrual'
      AND accrual.is_deleted = false
    JOIN crm.agent_commission_entries AS entry
      ON entry.workspace_id = accrual.workspace_id
      AND entry.assignment_id = accrual.assignment_id
      AND entry.currency = accrual.currency
      AND entry.kind IN ('accrual', 'reversal', 'adjustment')
      AND (entry.kind <> 'adjustment' OR entry.related_entry_id IS NOT NULL)
      AND entry.is_deleted = false
    WHERE COALESCE(sales_order.return_status, 'none') = 'full'
      AND COALESCE(sales_order.is_deleted, false) = false
    GROUP BY
      accrual.workspace_id,
      accrual.order_id,
      accrual.assignment_id,
      accrual.agent_id,
      accrual.membership_id,
      accrual.plan_id,
      accrual.id,
      accrual.currency,
      accrual.calculation_basis,
      accrual.include_tax,
      accrual.include_delivery_charge,
      accrual.basis_amount,
      accrual.revenue_amount,
      accrual.cost_amount,
      accrual.tax_amount,
      accrual.delivery_charge_amount,
      accrual.rate_percent
    HAVING COALESCE(sum(entry.amount), 0) < -0.000001
  LOOP
    INSERT INTO crm.agent_commission_entries (
      id, workspace_id, order_id, assignment_id, agent_id,
      membership_id, plan_id, order_return_id, related_entry_id,
      kind, status, currency, calculation_basis, include_tax,
      include_delivery_charge, basis_amount, revenue_amount, cost_amount,
      tax_amount, delivery_charge_amount, rate_percent,
      plan_commission_amount, product_commission_amount, amount, occurred_at,
      payout_reference, settlement_source, notes, created_by, created_at,
      updated_at, sync_status, version, is_deleted
    ) VALUES (
      gen_random_uuid(), v_balance.workspace_id, v_balance.order_id,
      v_balance.assignment_id, v_balance.agent_id, v_balance.membership_id,
      v_balance.plan_id, NULL, v_balance.accrual_id,
      'adjustment', 'earned', v_balance.currency,
      v_balance.calculation_basis, v_balance.include_tax,
      v_balance.include_delivery_charge, v_balance.basis_amount,
      v_balance.revenue_amount, v_balance.cost_amount, v_balance.tax_amount,
      v_balance.delivery_charge_amount, v_balance.rate_percent,
      NULL, NULL, round(-v_balance.recognized_amount, 6), now(), NULL,
      'automatic',
      'Correction: restore full-return commission balance after duplicated product reconciliation',
      NULL, now(), now(), 'synced', 1, false
    );
  END LOOP;
END;
$block$;

REVOKE ALL ON FUNCTION private.reconcile_product_sales_agent_commission(uuid, uuid) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
