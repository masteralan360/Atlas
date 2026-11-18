-- Store Sales Order-specific restrictions in the existing per-member
-- workspace_permissions system. Payment method rows are deny entries; a
-- missing row preserves the legacy unrestricted behavior.

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION public.set_sales_order_payment_method_hide_permissions(
  p_member_id uuid,
  p_prohibited_methods text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_method text;
BEGIN
  IF auth.uid() IS NULL
     OR v_workspace_id IS NULL
     OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'sales_order_hide_permissions_admin_required'
      USING ERRCODE = '42501';
  END IF;

  IF p_member_id = auth.uid()
     OR NOT EXISTS (
       SELECT 1
       FROM public.profiles AS profile
       WHERE profile.id = p_member_id
         AND profile.workspace_id = v_workspace_id
         AND profile.role = 'staff'
     ) THEN
    RAISE EXCEPTION 'sales_order_hide_permissions_member_unavailable'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(COALESCE(p_prohibited_methods, ARRAY[]::text[])) AS method(value)
    WHERE method.value !~ '^[A-Za-z][A-Za-z0-9_]*$'
  ) THEN
    RAISE EXCEPTION 'sales_order_hide_permissions_invalid_payment_method'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.workspace_permissions AS permission
  WHERE permission.workspace_id = v_workspace_id
    AND permission.user_uuid = p_member_id
    AND permission.key LIKE 'orders.salesOrderPaymentMethod.%';

  FOR v_method IN
    SELECT DISTINCT lower(regexp_replace(method.value, '_', '', 'g'))
    FROM unnest(COALESCE(p_prohibited_methods, ARRAY[]::text[])) AS method(value)
  LOOP
    INSERT INTO public.workspace_permissions (workspace_id, user_uuid, key, module)
    VALUES (
      v_workspace_id,
      p_member_id,
      'orders.salesOrderPaymentMethod.' || v_method,
      'orders'
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_sales_order_maximum_status_permission(
  p_member_id uuid,
  p_maximum_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
BEGIN
  IF auth.uid() IS NULL
     OR v_workspace_id IS NULL
     OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'sales_order_hide_permissions_admin_required'
      USING ERRCODE = '42501';
  END IF;

  IF p_member_id = auth.uid()
     OR NOT EXISTS (
       SELECT 1
       FROM public.profiles AS profile
       WHERE profile.id = p_member_id
         AND profile.workspace_id = v_workspace_id
         AND profile.role = 'staff'
     ) THEN
    RAISE EXCEPTION 'sales_order_hide_permissions_member_unavailable'
      USING ERRCODE = '42501';
  END IF;

  IF p_maximum_status IS NULL
     OR p_maximum_status NOT IN ('draft', 'pending', 'completed') THEN
    RAISE EXCEPTION 'sales_order_hide_permissions_invalid_status'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.workspace_permissions AS permission
  WHERE permission.workspace_id = v_workspace_id
    AND permission.user_uuid = p_member_id
    AND permission.key LIKE 'orders.salesOrderMaxStatus.%';

  INSERT INTO public.workspace_permissions (workspace_id, user_uuid, key, module)
  VALUES (
    v_workspace_id,
    p_member_id,
    'orders.salesOrderMaxStatus.' || p_maximum_status,
    'orders'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.set_sales_order_payment_method_hide_permissions(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_sales_order_maximum_status_permission(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sales_order_payment_method_hide_permissions(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_sales_order_maximum_status_permission(uuid, text) TO authenticated;

-- The trigger runs with table-owner visibility so restrictions remain
-- authoritative inside SECURITY DEFINER RPC workflows as well as direct
-- PostgREST writes. It always derives the actor from auth.uid().
CREATE OR REPLACE FUNCTION private.enforce_sales_order_staff_hide_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_maximum_status_rank integer := 2;
  v_target_status_rank integer;
  v_payment_method_key text;
  v_check_payment_method boolean;
  v_check_status boolean;
  v_existing_payment_method text;
  v_existing_status text;
BEGIN
  -- Service-role jobs are trusted server workflows. Authenticated requests
  -- always have an actor and are checked against that actor's profile.
  IF v_actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.current_workspace_id() IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'sales_order_permission_workspace_mismatch'
      USING ERRCODE = '42501';
  END IF;
  v_actor_role := public.current_user_role();

  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'sales_order_permission_workspace_mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor_role = 'admin' THEN
    RETURN NEW;
  END IF;

  IF v_actor_role <> 'staff' THEN
    RAISE EXCEPTION 'sales_order_mutation_staff_required'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The sync layer uses INSERT ... ON CONFLICT for existing orders. A
    -- BEFORE INSERT trigger runs before PostgreSQL resolves that conflict, so
    -- compare against the existing row to preserve unchanged historical values.
    SELECT order_row.payment_method::text, order_row.status::text
      INTO v_existing_payment_method, v_existing_status
    FROM crm.sales_orders AS order_row
    WHERE order_row.id = NEW.id;

    IF FOUND THEN
      v_check_payment_method := NEW.payment_method::text IS DISTINCT FROM v_existing_payment_method;
      v_check_status := NEW.status::text IS DISTINCT FROM v_existing_status;
    ELSE
      v_check_payment_method := true;
      v_check_status := true;
    END IF;
  ELSE
    v_check_payment_method := NEW.payment_method IS DISTINCT FROM OLD.payment_method;
    v_check_status := NEW.status IS DISTINCT FROM OLD.status;
  END IF;

  IF v_check_payment_method AND NEW.payment_method IS NOT NULL THEN
    v_payment_method_key := 'orders.salesOrderPaymentMethod.'
      || regexp_replace(lower(NEW.payment_method::text), '_', '', 'g');

    IF EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS permission
      WHERE permission.workspace_id = NEW.workspace_id
        AND permission.user_uuid = v_actor_id
        AND permission.key = v_payment_method_key
    ) THEN
      RAISE EXCEPTION 'sales_order_payment_method_not_allowed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_check_status THEN
    SELECT COALESCE(MIN(
      CASE permission.key
        WHEN 'orders.salesOrderMaxStatus.draft' THEN 0
        WHEN 'orders.salesOrderMaxStatus.pending' THEN 1
        WHEN 'orders.salesOrderMaxStatus.completed' THEN 2
      END
    ), 2)
    INTO v_maximum_status_rank
    FROM public.workspace_permissions AS permission
    WHERE permission.workspace_id = NEW.workspace_id
      AND permission.user_uuid = v_actor_id
      AND permission.key IN (
        'orders.salesOrderMaxStatus.draft',
        'orders.salesOrderMaxStatus.pending',
        'orders.salesOrderMaxStatus.completed'
      );

    v_target_status_rank := CASE NEW.status::text
      WHEN 'draft' THEN 0
      WHEN 'pending' THEN 1
      WHEN 'completed' THEN 2
      ELSE NULL
    END;

    IF v_target_status_rank IS NOT NULL AND v_target_status_rank > v_maximum_status_rank THEN
      RAISE EXCEPTION 'sales_order_status_advancement_not_allowed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.enforce_sales_order_staff_hide_permissions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_sales_order_staff_hide_permissions ON crm.sales_orders;
CREATE TRIGGER enforce_sales_order_staff_hide_permissions
  BEFORE INSERT OR UPDATE OF payment_method, status
  ON crm.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_sales_order_staff_hide_permissions();

-- Sales Order settlement creates a payment transaction and then rebuilds the
-- order's payment_method from that transaction. Protect that scoped write path
-- too, while leaving all other transaction sources and reversal entries alone.
CREATE OR REPLACE FUNCTION private.enforce_sales_order_payment_transaction_method()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_payment_method_key text;
  v_check_payment_method boolean;
  v_existing_payment_method text;
  v_existing_source_module text;
  v_existing_source_type text;
  v_existing_reversal_id uuid;
BEGIN
  -- Service-role jobs and reversal counter-entries are trusted workflows.
  IF v_actor_id IS NULL OR NEW.reversal_of_transaction_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.source_module IS DISTINCT FROM 'orders'
     OR NEW.source_type IS DISTINCT FROM 'sales_order' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Idempotent retries may use INSERT ... ON CONFLICT. Preserve unchanged
    -- historical payment information but validate any changed method.
    SELECT payment.payment_method::text, payment.source_module::text,
      payment.source_type::text, payment.reversal_of_transaction_id
      INTO v_existing_payment_method, v_existing_source_module,
        v_existing_source_type, v_existing_reversal_id
    FROM public.payment_transactions AS payment
    WHERE payment.id = NEW.id;

    IF FOUND THEN
      v_check_payment_method := NEW.payment_method::text IS DISTINCT FROM v_existing_payment_method
        OR NEW.source_module::text IS DISTINCT FROM v_existing_source_module
        OR NEW.source_type::text IS DISTINCT FROM v_existing_source_type
        OR NEW.reversal_of_transaction_id IS DISTINCT FROM v_existing_reversal_id;
    ELSE
      v_check_payment_method := true;
    END IF;
  ELSE
    v_check_payment_method := NEW.payment_method IS DISTINCT FROM OLD.payment_method
      OR NEW.source_module IS DISTINCT FROM OLD.source_module
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.reversal_of_transaction_id IS DISTINCT FROM OLD.reversal_of_transaction_id;
  END IF;

  IF NOT v_check_payment_method THEN
    RETURN NEW;
  END IF;

  IF public.current_workspace_id() IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'sales_order_permission_workspace_mismatch'
      USING ERRCODE = '42501';
  END IF;

  v_actor_role := public.current_user_role();
  IF v_actor_role = 'admin' THEN
    RETURN NEW;
  END IF;
  IF v_actor_role IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'sales_order_mutation_staff_required'
      USING ERRCODE = '42501';
  END IF;

  -- Installment creation records its initial cash down payment separately
  -- from the selected Sales Order method. Permit that one leg only when it
  -- matches the order's saved installment deposit and no copy already exists.
  IF NEW.payment_method::text = 'cash'
     AND NEW.metadata->>'isFinancingInitialPayment' = 'true'
     AND NEW.metadata->>'isDownPayment' = 'true'
     AND EXISTS (
       SELECT 1
       FROM crm.sales_orders AS order_row
       WHERE order_row.id = NEW.source_record_id
         AND order_row.workspace_id = NEW.workspace_id
         AND order_row.payment_method = 'installments'
         AND order_row.initial_payment_amount = NEW.amount
         AND order_row.paid_amount = NEW.amount
         AND order_row.initial_payment_account_id IS NOT DISTINCT FROM NEW.account_id
         AND NOT EXISTS (
           SELECT 1
           FROM public.payment_transactions AS existing_payment
           WHERE existing_payment.workspace_id = NEW.workspace_id
             AND existing_payment.source_module = 'orders'
             AND existing_payment.source_type = 'sales_order'
             AND existing_payment.source_record_id = NEW.source_record_id
             AND existing_payment.metadata->>'isFinancingInitialPayment' = 'true'
             AND existing_payment.reversal_of_transaction_id IS NULL
             AND NOT COALESCE(existing_payment.is_deleted, false)
         )
     ) THEN
    RETURN NEW;
  END IF;

  -- The Sales Order settlement selector exposes the standard transaction
  -- methods. Loan and Installments are order modes handled by financing flows.
  IF NEW.payment_method::text NOT IN (
    'cash', 'fib', 'qicard', 'zaincash', 'fastpay', 'bank_transfer'
  ) THEN
    RAISE EXCEPTION 'sales_order_payment_method_not_allowed'
      USING ERRCODE = '42501';
  END IF;

  v_payment_method_key := 'orders.salesOrderPaymentMethod.'
    || regexp_replace(lower(NEW.payment_method::text), '_', '', 'g');

  IF EXISTS (
    SELECT 1
    FROM public.workspace_permissions AS permission
    WHERE permission.workspace_id = NEW.workspace_id
      AND permission.user_uuid = v_actor_id
      AND permission.key = v_payment_method_key
  ) THEN
    RAISE EXCEPTION 'sales_order_payment_method_not_allowed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.enforce_sales_order_payment_transaction_method()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_sales_order_payment_transaction_method
  ON public.payment_transactions;
CREATE TRIGGER enforce_sales_order_payment_transaction_method
  BEFORE INSERT OR UPDATE OF payment_method, source_module, source_type, reversal_of_transaction_id
  ON public.payment_transactions
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_sales_order_payment_transaction_method();
