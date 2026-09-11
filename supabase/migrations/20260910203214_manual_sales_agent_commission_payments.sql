-- Sales-agent commission is an explicit payable/receivable.  Saving an order
-- creates or reconciles the earned amount; it never posts a cash payment.

ALTER TABLE crm.agent_commission_entries
  DROP CONSTRAINT IF EXISTS agent_commission_entries_kind_check,
  DROP CONSTRAINT IF EXISTS agent_commission_entries_kind_status_check,
  ADD CONSTRAINT agent_commission_entries_kind_check CHECK (
    kind IN ('estimate', 'accrual', 'approval', 'reversal', 'payout', 'recovery', 'adjustment')
  ),
  ADD CONSTRAINT agent_commission_entries_kind_status_check CHECK (
    (kind = 'estimate' AND status = 'estimated' AND amount >= 0)
    OR (kind = 'accrual' AND status = 'earned' AND amount >= 0)
    OR (kind = 'approval' AND status = 'approved' AND amount = 0)
    OR (kind = 'reversal' AND status = 'reversed' AND amount <= 0)
    OR (kind = 'payout' AND status = 'paid' AND amount <= 0 AND NULLIF(btrim(payout_reference), '') IS NOT NULL)
    OR (kind = 'recovery' AND status = 'paid' AND amount >= 0 AND NULLIF(btrim(payout_reference), '') IS NOT NULL)
    OR (kind = 'adjustment' AND status IN ('earned', 'approved', 'reversed'))
  );

CREATE INDEX IF NOT EXISTS agent_commission_entries_recovery_order_idx
  ON crm.agent_commission_entries (workspace_id, agent_id, currency, order_id, occurred_at DESC)
  WHERE kind = 'recovery';

-- The automatic settlement trigger and reconciliation wrapper were introduced
-- for the previous policy.  Remove both paths so reconciliation is ledger-only.
DROP TRIGGER IF EXISTS settle_paid_sales_agent_commission_after_entry
  ON crm.agent_commission_entries;
DROP TRIGGER IF EXISTS validate_automatic_agent_commission_payment
  ON public.payment_transactions;

-- Retain the private signatures for old callers, but make an accidental call
-- harmless. The only supported settlement writers below require a payment
-- dialog and create both the commission entry and payment transaction.
CREATE OR REPLACE FUNCTION private.settle_paid_sales_agent_commissions_for_order(
  p_workspace_id uuid,
  p_order_id uuid,
  p_created_by uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN 0;
END;
$function$;

CREATE OR REPLACE FUNCTION private.settle_paid_sales_agent_commission_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_sales_agent_commission(
  p_order_id uuid,
  p_order_return_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_changed integer := 0;
BEGIN
  v_changed := public.reconcile_sales_agent_commission_core(p_order_id, p_order_return_id);
  v_changed := v_changed + private.ensure_order_creator_product_commission_assignment(p_order_id);
  v_changed := v_changed + private.reconcile_product_sales_agent_commission(p_order_id, p_order_return_id);
  RETURN v_changed;
END;
$function$;

-- An earned commission no longer depends on collecting the customer order.
-- Keep the existing, well-tested calculation bodies and replace only their
-- eligibility predicate, preserving every basis, currency, and rounding rule.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
BEGIN
  SELECT pg_get_functiondef('private.calculate_sales_agent_commission_order_target(uuid, uuid, uuid, text, boolean, boolean, numeric)'::regprocedure)
  INTO v_definition;
  v_replaced := regexp_replace(
    v_definition,
    'sales_order\.status = ''completed''[[:space:]]+AND \(COALESCE\(sales_order\.is_paid, false\) OR sales_order\.payment_status = ''paid''\)[[:space:]]+AND COALESCE\(sales_order\.is_deleted, false\) = false',
    'COALESCE(sales_order.is_deleted, false) = false AND sales_order.status <> ''cancelled'''
  );
  IF v_replaced = v_definition THEN
    RAISE EXCEPTION 'Could not update sales-agent commission eligibility';
  END IF;
  EXECUTE v_replaced;

  SELECT pg_get_functiondef('private.calculate_manual_sales_agent_commission_order_target(uuid, uuid, uuid)'::regprocedure)
  INTO v_definition;
  v_replaced := regexp_replace(
    v_definition,
    'sales_order\.status = ''completed''[[:space:]]+AND \(COALESCE\(sales_order\.is_paid, false\) OR sales_order\.payment_status = ''paid''\)[[:space:]]+AND COALESCE\(sales_order\.is_deleted, false\) = false',
    'COALESCE(sales_order.is_deleted, false) = false AND sales_order.status <> ''cancelled'''
  );
  IF v_replaced = v_definition THEN
    RAISE EXCEPTION 'Could not update manual sales-agent commission eligibility';
  END IF;
  EXECUTE v_replaced;

  SELECT pg_get_functiondef('private.reconcile_product_sales_agent_commission(uuid, uuid)'::regprocedure)
  INTO v_definition;
  v_replaced := regexp_replace(
    v_definition,
    'v_order\.status = ''completed''[[:space:]]+AND \(COALESCE\(v_order\.is_paid, false\) OR v_order\.payment_status = ''paid''\)[[:space:]]+AND COALESCE\(v_order\.return_status, ''none''\) <> ''full''[[:space:]]+AND COALESCE\(v_order\.is_deleted, false\) = false',
    'COALESCE(v_order.is_deleted, false) = false AND v_order.status <> ''cancelled'' AND COALESCE(v_order.return_status, ''none'') <> ''full'''
  );
  -- Some deployed revisions wrap or align the assignment differently. In
  -- that form replace the full assignment rather than only its expression.
  IF v_replaced = v_definition THEN
    v_replaced := regexp_replace(
      v_definition,
      'v_eligible[[:space:]]*:=[[:space:]]*v_order\.status[[:space:]]*=[[:space:]]*''completed''[[:space:]]+AND[[:space:]]+\(COALESCE\(v_order\.is_paid,[[:space:]]*false\)[[:space:]]+OR[[:space:]]+v_order\.payment_status[[:space:]]*=[[:space:]]*''paid''\)([[:space:]]+AND[[:space:]]+COALESCE\(v_order\.return_status,[[:space:]]*''none''\)[[:space:]]*<>[[:space:]]*''full'')?([[:space:]]+AND[[:space:]]+COALESCE\(v_order\.is_deleted,[[:space:]]*false\)[[:space:]]*=[[:space:]]*false)?[[:space:]]*;',
      'v_eligible := COALESCE(v_order.is_deleted, false) = false AND v_order.status <> ''cancelled'' AND COALESCE(v_order.return_status, ''none'') <> ''full'';'
    );
  END IF;
  IF v_replaced = v_definition THEN
    v_replaced := regexp_replace(
      v_definition,
      'v_eligible[[:space:]]*:=[^;]+;',
      'v_eligible := COALESCE(v_order.is_deleted, false) = false AND v_order.status <> ''cancelled'' AND COALESCE(v_order.return_status, ''none'') <> ''full'';'
    );
  END IF;
  IF v_replaced = v_definition
    AND position('v_order.status <> ''cancelled''' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Could not update product sales-agent commission eligibility';
  END IF;
  EXECUTE v_replaced;
END;
$block$;

-- Protect both balance-clearing entry kinds, including retries from an offline
-- local workspace. The RPC below is the normal cloud writer, but the trigger
-- is the invariant boundary.
CREATE OR REPLACE FUNCTION private.enforce_order_linked_agent_commission_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_number text;
  v_outstanding numeric := 0;
BEGIN
  IF NEW.kind NOT IN ('payout', 'recovery') THEN
    RETURN NEW;
  END IF;
  IF NEW.order_id IS NULL OR NEW.assignment_id IS NULL THEN
    RAISE EXCEPTION 'Commission settlements require a linked sales order and assignment'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'commission-assignment:' || NEW.workspace_id::text || ':' || NEW.assignment_id::text || ':' || NEW.currency,
      0
    )
  );

  SELECT NULLIF(btrim(sales_order.order_number), '')
  INTO v_order_number
  FROM crm.sales_orders AS sales_order
  JOIN crm.sales_order_agent_assignments AS assignment
    ON assignment.id = NEW.assignment_id
   AND assignment.order_id = sales_order.id
   AND assignment.agent_id = NEW.agent_id
   AND assignment.workspace_id = NEW.workspace_id
   AND assignment.is_deleted = false
  WHERE sales_order.id = NEW.order_id
    AND sales_order.workspace_id = NEW.workspace_id
    AND sales_order.is_deleted = false;
  IF v_order_number IS NULL THEN
    RAISE EXCEPTION 'Commission settlement order and assignment must belong to the same workspace'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(entry.amount), 0)
  INTO v_outstanding
  FROM crm.agent_commission_entries AS entry
  WHERE entry.workspace_id = NEW.workspace_id
    AND entry.agent_id = NEW.agent_id
    AND entry.assignment_id = NEW.assignment_id
    AND entry.order_id = NEW.order_id
    AND lower(entry.currency) = lower(NEW.currency)
    AND entry.kind NOT IN ('estimate', 'approval')
    AND entry.is_deleted = false;

  IF NEW.kind = 'payout' AND -NEW.amount > GREATEST(v_outstanding, 0) + 0.000001 THEN
    RAISE EXCEPTION 'Commission payout exceeds the selected order''s outstanding commission'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'recovery' AND NEW.amount > GREATEST(-v_outstanding, 0) + 0.000001 THEN
    RAISE EXCEPTION 'Commission recovery exceeds the selected order''s recoverable commission'
      USING ERRCODE = '23514';
  END IF;

  NEW.payout_reference := v_order_number;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.record_sales_agent_commission_settlement(
  p_order_id uuid,
  p_assignment_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_paid_at timestamptz,
  p_note text,
  p_account_id uuid,
  p_account_name_snapshot text,
  p_kind text
)
RETURNS TABLE(entry_id uuid, payment_transaction_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
  v_assignment crm.sales_order_agent_assignments%ROWTYPE;
  v_agent crm.agents%ROWTYPE;
  v_partner_name text;
  v_workspace_plan text;
  v_outstanding numeric := 0;
  v_entry_id uuid;
  v_payment_id uuid;
  v_amount numeric;
  v_currency text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('payout', 'recovery') THEN
    RAISE EXCEPTION 'Invalid commission settlement type' USING ERRCODE = '23514';
  END IF;
  IF p_payment_method IN ('credit', 'unknown', 'loan_adjustment', 'loan') THEN
    RAISE EXCEPTION 'Select a settlement payment method' USING ERRCODE = '23514';
  END IF;
  v_amount := round(COALESCE(p_amount, 0), 6);
  IF v_amount <= 0.000001 THEN
    RAISE EXCEPTION 'Commission settlement amount must be greater than zero' USING ERRCODE = '23514';
  END IF;
  IF p_paid_at IS NULL THEN
    RAISE EXCEPTION 'Enter a valid settlement date' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_order
  FROM crm.sales_orders
  WHERE id = p_order_id AND is_deleted = false
  FOR UPDATE;
  IF NOT FOUND OR v_order.workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Sales order not found in the current workspace' USING ERRCODE = '42501';
  END IF;
  SELECT plan::text INTO v_workspace_plan FROM public.workspaces WHERE id = v_order.workspace_id AND deleted_at IS NULL;
  IF v_workspace_plan IS NULL OR NOT public.workspace_module_allowed(v_order.workspace_id, v_workspace_plan, 'sales_agent_commissions') THEN
    RAISE EXCEPTION 'Sales Agent Commissions is not enabled for this workspace' USING ERRCODE = '42501';
  END IF;
  IF public.current_user_role() <> 'admin' AND NOT (
    EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS permission
      WHERE permission.workspace_id = v_order.workspace_id
        AND permission.user_uuid = auth.uid()
        AND permission.key = 'salesAgentCommissions.pay'
    )
    AND EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS permission
      WHERE permission.workspace_id = v_order.workspace_id
        AND permission.user_uuid = auth.uid()
        AND permission.key = 'agents.access'
    )
    AND EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS permission
      WHERE permission.workspace_id = v_order.workspace_id
        AND permission.user_uuid = auth.uid()
        AND permission.key = 'orders.saleOrdersAccess'
    )
  ) THEN
    RAISE EXCEPTION 'Sales Agent Commission settlement permission is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_assignment
  FROM crm.sales_order_agent_assignments
  WHERE id = p_assignment_id
    AND workspace_id = v_order.workspace_id
    AND order_id = v_order.id
    AND is_deleted = false
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales agent commission assignment not found' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_agent
  FROM crm.agents
  WHERE id = v_assignment.agent_id
    AND workspace_id = v_order.workspace_id
    AND agent_type = 'field_agent'
    AND is_deleted = false
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Field sales agent not found' USING ERRCODE = '23514';
  END IF;
  SELECT partner_name INTO v_partner_name
  FROM crm.business_partners
  WHERE id = v_agent.business_partner_id AND workspace_id = v_order.workspace_id AND is_deleted = false;
  IF v_partner_name IS NULL THEN
    RAISE EXCEPTION 'Sales agent business partner not found' USING ERRCODE = '23514';
  END IF;
  IF p_kind = 'payout' AND (v_order.status = 'cancelled' OR COALESCE(v_order.return_status, 'none') = 'full') THEN
    RAISE EXCEPTION 'Commission cannot be paid from a cancelled or fully returned order' USING ERRCODE = '23514';
  END IF;

  v_currency := lower(v_order.currency);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('commission-assignment:' || v_order.workspace_id::text || ':' || v_assignment.id::text || ':' || v_currency, 0)
  );
  SELECT COALESCE(sum(amount), 0) INTO v_outstanding
  FROM crm.agent_commission_entries
  WHERE workspace_id = v_order.workspace_id
    AND agent_id = v_agent.id
    AND assignment_id = v_assignment.id
    AND order_id = v_order.id
    AND lower(currency) = v_currency
    AND kind NOT IN ('estimate', 'approval')
    AND is_deleted = false;
  IF p_kind = 'payout' AND v_amount > GREATEST(v_outstanding, 0) + 0.000001 THEN
    RAISE EXCEPTION 'Commission payout cannot exceed the outstanding balance' USING ERRCODE = '23514';
  END IF;
  IF p_kind = 'recovery' AND v_amount > GREATEST(-v_outstanding, 0) + 0.000001 THEN
    RAISE EXCEPTION 'Commission recovery cannot exceed the recoverable balance' USING ERRCODE = '23514';
  END IF;

  INSERT INTO crm.agent_commission_entries (
    id, workspace_id, order_id, assignment_id, agent_id, membership_id, plan_id,
    order_return_id, related_entry_id, kind, status, currency, calculation_basis,
    include_tax, include_delivery_charge, basis_amount, revenue_amount, cost_amount,
    tax_amount, delivery_charge_amount, rate_percent, amount, occurred_at,
    payout_reference, settlement_source, notes, created_by, created_at, updated_at,
    version, is_deleted
  ) VALUES (
    gen_random_uuid(), v_order.workspace_id, v_order.id, v_assignment.id, v_agent.id,
    NULL, NULL, NULL, NULL, p_kind, 'paid', v_currency, 'net_profit', false, false,
    0, 0, 0, 0, 0, 0,
    CASE WHEN p_kind = 'payout' THEN -v_amount ELSE v_amount END,
    p_paid_at, v_order.order_number, 'manual', NULLIF(btrim(p_note), ''), auth.uid(), now(), now(), 1, false
  ) RETURNING id INTO v_entry_id;

  INSERT INTO public.payment_transactions (
    id, workspace_id, source_module, source_type, source_record_id, source_subrecord_id,
    direction, amount, currency, payment_method, paid_at, account_id, account_name_snapshot,
    counterparty_name, reference_label, note, created_by, metadata, created_at, updated_at, version, is_deleted
  ) VALUES (
    gen_random_uuid(), v_order.workspace_id, 'orders',
    CASE WHEN p_kind = 'payout' THEN 'agent_commission_payout' ELSE 'agent_commission_recovery' END,
    v_agent.id, v_entry_id,
    CASE WHEN p_kind = 'payout' THEN 'outgoing' ELSE 'incoming' END,
    v_amount, v_currency, p_payment_method, p_paid_at, p_account_id, p_account_name_snapshot,
    v_partner_name, v_order.order_number, NULLIF(btrim(p_note), ''), auth.uid(),
    jsonb_build_object('agentCommissionEntryId', v_entry_id, 'agentId', v_agent.id, 'orderId', v_order.id,
      'businessPartnerId', v_agent.business_partner_id), now(), now(), 1, false
  ) RETURNING id INTO v_payment_id;

  RETURN QUERY SELECT v_entry_id, v_payment_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_sales_agent_commission_payout(
  p_order_id uuid, p_assignment_id uuid, p_amount numeric, p_payment_method text,
  p_paid_at timestamptz DEFAULT now(), p_note text DEFAULT NULL, p_account_id uuid DEFAULT NULL,
  p_account_name_snapshot text DEFAULT NULL
)
RETURNS TABLE(entry_id uuid, payment_transaction_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT * FROM private.record_sales_agent_commission_settlement(
    p_order_id, p_assignment_id, p_amount, p_payment_method, p_paid_at, p_note,
    p_account_id, p_account_name_snapshot, 'payout'
  );
$function$;

CREATE OR REPLACE FUNCTION public.record_sales_agent_commission_recovery(
  p_order_id uuid, p_assignment_id uuid, p_amount numeric, p_payment_method text,
  p_paid_at timestamptz DEFAULT now(), p_note text DEFAULT NULL, p_account_id uuid DEFAULT NULL,
  p_account_name_snapshot text DEFAULT NULL
)
RETURNS TABLE(entry_id uuid, payment_transaction_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT * FROM private.record_sales_agent_commission_settlement(
    p_order_id, p_assignment_id, p_amount, p_payment_method, p_paid_at, p_note,
    p_account_id, p_account_name_snapshot, 'recovery'
  );
$function$;

REVOKE ALL ON FUNCTION private.record_sales_agent_commission_settlement(uuid, uuid, numeric, text, timestamptz, text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_order_linked_agent_commission_payout() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_sales_agent_commission(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_sales_agent_commission_payout(uuid, uuid, numeric, text, timestamptz, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_sales_agent_commission_recovery(uuid, uuid, numeric, text, timestamptz, text, uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
