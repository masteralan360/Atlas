CREATE OR REPLACE FUNCTION public.detect_and_dispatch_notification_events(
  p_target_workspace_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications, budget
AS $function$
DECLARE
  v_dispatched_count integer;
BEGIN
  PERFORM public.queue_marketplace_pending_order_notifications(o.id)
  FROM public.marketplace_orders o
  WHERE o.status = 'pending'
    AND COALESCE(o.is_deleted, false) = false
    AND (p_target_workspace_id IS NULL OR o.workspace_id = p_target_workspace_id);

  PERFORM public.upsert_notification_event(
    c.workspace_id,
    r.user_id,
    'loan_installment_overdue',
    c.loan_id::text,
    c.due_date,
    jsonb_build_object(
      'entity_type', 'loan_installment_overdue',
      'title', format('Loan %s has overdue installments', c.loan_no),
      'body', concat_ws(' | ',
        COALESCE(NULLIF(c.borrower_name, ''), 'Unknown borrower'),
        format('%s overdue installment%s', c.overdue_installment_count, CASE WHEN c.overdue_installment_count = 1 THEN '' ELSE 's' END),
        c.overdue_amount::text || ' ' || upper(c.currency)
      ),
      'route', format('/installments/%s', c.loan_id),
      'action_label', 'Open installments',
      'scope', 'workspace',
      'priority', 'high',
      'loan_id', c.loan_id,
      'loan_no', c.loan_no,
      'borrower_name', c.borrower_name,
      'linked_party_name', c.linked_party_name,
      'currency', c.currency,
      'amount', c.overdue_amount,
      'due_date', c.due_date,
      'overdue_installment_count', c.overdue_installment_count
    )
  )
  FROM (
    SELECT p.id AS user_id, p.workspace_id
    FROM public.profiles p
    WHERE p.workspace_id IS NOT NULL
      AND LOWER(BTRIM(COALESCE(p.role, ''))) = 'admin'
      AND (p_target_workspace_id IS NULL OR p.workspace_id = p_target_workspace_id)
  ) r
  JOIN (
    SELECT *
    FROM (
      SELECT
        l.workspace_id,
        l.id AS loan_id,
        l.loan_no,
        l.borrower_name,
        l.linked_party_name,
        COALESCE(NULLIF(l.settlement_currency, ''), 'usd') AS currency,
        MIN(li.due_date) AS due_date,
        SUM(li.balance_amount) AS overdue_amount,
        COUNT(*)::integer AS overdue_installment_count,
        l.overdue_reminder_snoozed_at,
        l.overdue_reminder_snoozed_for_due_date
      FROM public.loans l
      JOIN public.loan_installments li
        ON li.loan_id = l.id
       AND li.workspace_id = l.workspace_id
      WHERE (p_target_workspace_id IS NULL OR l.workspace_id = p_target_workspace_id)
        AND COALESCE(l.is_deleted, false) = false
        AND COALESCE(li.is_deleted, false) = false
        AND COALESCE(l.balance_amount, 0) > 0
        AND COALESCE(li.balance_amount, 0) > 0
        AND COALESCE(li.status, 'pending') <> 'paid'
        AND li.due_date < current_date
      GROUP BY
        l.workspace_id,
        l.id,
        l.loan_no,
        l.borrower_name,
        l.linked_party_name,
        l.settlement_currency,
        l.overdue_reminder_snoozed_at,
        l.overdue_reminder_snoozed_for_due_date
    ) loan_overdue
    WHERE NOT (
      overdue_reminder_snoozed_at IS NOT NULL
      AND overdue_reminder_snoozed_for_due_date = due_date
    )
  ) c
    ON r.workspace_id = c.workspace_id;

  PERFORM public.upsert_notification_event(
    c.workspace_id,
    r.user_id,
    'expense_item_overdue',
    c.expense_item_id::text,
    c.due_date,
    jsonb_build_object(
      'entity_type', 'expense_item_overdue',
      'title', format('Overdue expense: %s', c.series_name),
      'body', concat_ws(' | ',
        COALESCE(NULLIF(c.subcategory, ''), NULLIF(c.category, ''), 'Expense'),
        c.amount::text || ' ' || upper(c.currency),
        'Due ' || c.due_date::text
      ),
      'route', '/budget',
      'action_label', 'Open budget',
      'scope', 'workspace',
      'priority', 'high',
      'expense_item_id', c.expense_item_id,
      'series_id', c.series_id,
      'series_name', c.series_name,
      'category', c.category,
      'subcategory', c.subcategory,
      'month', c.month,
      'currency', c.currency,
      'amount', c.amount,
      'due_date', c.due_date
    )
  )
  FROM (
    SELECT p.id AS user_id, p.workspace_id
    FROM public.profiles p
    WHERE p.workspace_id IS NOT NULL
      AND LOWER(BTRIM(COALESCE(p.role, ''))) = 'admin'
      AND (p_target_workspace_id IS NULL OR p.workspace_id = p_target_workspace_id)
  ) r
  JOIN (
    SELECT *
    FROM (
      SELECT
        ei.workspace_id,
        ei.id AS expense_item_id,
        ei.series_id,
        ei.month,
        ei.due_date,
        ei.amount,
        COALESCE(NULLIF(ei.currency, ''), 'usd') AS currency,
        COALESCE(NULLIF(es.name, ''), 'Expense') AS series_name,
        es.category,
        es.subcategory,
        COALESCE(ei.status, 'pending') AS status,
        ei.snoozed_until,
        COALESCE(ei.snoozed_indefinite, false) AS snoozed_indefinite
      FROM budget.expense_items ei
      JOIN budget.expense_series es
        ON es.id = ei.series_id
       AND es.workspace_id = ei.workspace_id
      WHERE (p_target_workspace_id IS NULL OR ei.workspace_id = p_target_workspace_id)
        AND COALESCE(ei.is_deleted, false) = false
        AND COALESCE(es.is_deleted, false) = false
        AND ei.due_date < current_date
        AND COALESCE(ei.status, 'pending') <> 'paid'
    ) expense_candidates
    WHERE NOT (
      status = 'snoozed'
      AND (
        snoozed_indefinite = true
        OR (snoozed_until IS NOT NULL AND snoozed_until > now())
      )
    )
  ) c
    ON r.workspace_id = c.workspace_id;

  PERFORM public.upsert_notification_event(
    c.workspace_id,
    r.user_id,
    'payroll_overdue',
    (c.employee_id::text || ':' || c.month),
    c.due_date,
    jsonb_build_object(
      'entity_type', 'payroll_overdue',
      'title', format('Payroll overdue for %s', c.employee_name),
      'body', concat_ws(' | ',
        COALESCE(NULLIF(c.employee_role, ''), 'Employee'),
        c.amount::text || ' ' || upper(c.currency),
        c.month
      ),
      'route', '/budget',
      'action_label', 'Open budget',
      'scope', 'workspace',
      'priority', 'high',
      'employee_id', c.employee_id,
      'employee_name', c.employee_name,
      'employee_role', c.employee_role,
      'month', c.month,
      'currency', c.currency,
      'amount', c.amount,
      'due_date', c.due_date
    )
  )
  FROM (
    SELECT p.id AS user_id, p.workspace_id
    FROM public.profiles p
    WHERE p.workspace_id IS NOT NULL
      AND LOWER(BTRIM(COALESCE(p.role, ''))) = 'admin'
      AND (p_target_workspace_id IS NULL OR p.workspace_id = p_target_workspace_id)
  ) r
  JOIN (
    SELECT *
    FROM (
      SELECT
        e.workspace_id,
        e.id AS employee_id,
        e.name AS employee_name,
        e.role AS employee_role,
        pm.month,
        COALESCE(e.salary, 0) AS amount,
        COALESCE(NULLIF(e.salary_currency, ''), 'usd') AS currency,
        make_date(
          split_part(pm.month, '-', 1)::integer,
          split_part(pm.month, '-', 2)::integer,
          LEAST(
            GREATEST(COALESCE(e.salary_payday, 30), 1),
            EXTRACT(
              DAY FROM (
                date_trunc('month', make_date(split_part(pm.month, '-', 1)::integer, split_part(pm.month, '-', 2)::integer, 1))
                + interval '1 month - 1 day'
              )
            )::integer
          )
        ) AS due_date,
        COALESCE(ps.status, 'pending') AS status,
        ps.snoozed_until,
        COALESCE(ps.snoozed_indefinite, false) AS snoozed_indefinite
      FROM public.employees e
      JOIN (
        SELECT to_char(current_date, 'YYYY-MM') AS month
        UNION
        SELECT ps.month
        FROM budget.payroll_statuses ps
        WHERE COALESCE(ps.is_deleted, false) = false
          AND (p_target_workspace_id IS NULL OR ps.workspace_id = p_target_workspace_id)
      ) pm ON true
      LEFT JOIN budget.payroll_statuses ps
        ON ps.workspace_id = e.workspace_id
       AND ps.employee_id = e.id
       AND ps.month = pm.month
       AND COALESCE(ps.is_deleted, false) = false
      WHERE (p_target_workspace_id IS NULL OR e.workspace_id = p_target_workspace_id)
        AND COALESCE(e.is_deleted, false) = false
        AND COALESCE(e.is_fired, false) = false
        AND COALESCE(e.salary, 0) > 0
    ) payroll_base
    WHERE due_date < current_date
      AND status <> 'paid'
      AND NOT (
        status = 'snoozed'
        AND (
          snoozed_indefinite = true
          OR (snoozed_until IS NOT NULL AND snoozed_until > now())
        )
      )
  ) c
    ON r.workspace_id = c.workspace_id;

  PERFORM public.upsert_notification_event(
    c.workspace_id,
    r.user_id,
    'inventory_low_stock',
    (c.product_id::text || ':' || c.storage_id::text),
    current_date,
    jsonb_build_object(
      'entity_type', 'inventory_low_stock',
      'title', format('Low stock: %s', c.product_name),
      'body', concat_ws(' | ',
        c.storage_name,
        format('%s %s remaining', c.quantity, upper(c.unit)),
        format('Min %s', c.min_stock_level)
      ),
      'route', '/storages',
      'action_label', 'Open storages',
      'scope', 'workspace',
      'priority', 'high',
      'product_id', c.product_id,
      'storage_id', c.storage_id,
      'product_name', c.product_name,
      'sku', c.sku,
      'storage_name', c.storage_name,
      'quantity', c.quantity,
      'min_stock_level', c.min_stock_level,
      'unit', c.unit
    )
  )
  FROM (
    SELECT p.id AS user_id, p.workspace_id
    FROM public.profiles p
    WHERE p.workspace_id IS NOT NULL
      AND LOWER(BTRIM(COALESCE(p.role, ''))) = 'admin'
      AND (p_target_workspace_id IS NULL OR p.workspace_id = p_target_workspace_id)
  ) r
  JOIN (
    SELECT
      i.workspace_id,
      i.product_id,
      i.storage_id,
      COALESCE(NULLIF(BTRIM(p.name), ''), 'Unnamed product') AS product_name,
      COALESCE(NULLIF(BTRIM(p.sku), ''), 'NO-SKU') AS sku,
      COALESCE(NULLIF(BTRIM(s.name), ''), 'Unknown storage') AS storage_name,
      GREATEST(COALESCE(i.quantity, 0), 0) AS quantity,
      GREATEST(COALESCE(p.min_stock_level, 0), 0) AS min_stock_level,
      COALESCE(NULLIF(BTRIM(p.unit), ''), 'pcs') AS unit
    FROM public.inventory i
    JOIN public.products p
      ON p.id = i.product_id
     AND p.workspace_id = i.workspace_id
    JOIN public.storages s
      ON s.id = i.storage_id
     AND s.workspace_id = i.workspace_id
    WHERE (p_target_workspace_id IS NULL OR i.workspace_id = p_target_workspace_id)
      AND COALESCE(i.is_deleted, false) = false
      AND COALESCE(p.is_deleted, false) = false
      AND COALESCE(s.is_deleted, false) = false
      AND GREATEST(COALESCE(p.min_stock_level, 0), 0) > 0
      AND GREATEST(COALESCE(i.quantity, 0), 0) < GREATEST(COALESCE(p.min_stock_level, 0), 0)
  ) c
    ON r.workspace_id = c.workspace_id;

  v_dispatched_count := public.dispatch_notification_events();
  RETURN COALESCE(v_dispatched_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.detect_and_dispatch_notification_events(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_and_dispatch_notification_events(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.queue_marketplace_pending_order_notifications(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_due_date date;
  v_item_count integer := 0;
BEGIN
  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE id = p_order_id
    AND status = 'pending'
    AND COALESCE(is_deleted, false) = false;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_due_date := timezone('utc', v_order.created_at)::date;

  SELECT COALESCE(SUM(GREATEST(COALESCE((item.value ->> 'quantity')::integer, 1), 1)), 0)
  INTO v_item_count
  FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item(value);

  PERFORM public.upsert_notification_event(
    v_order.workspace_id,
    p.id,
    'marketplace_order_pending',
    v_order.id::text,
    v_due_date,
    jsonb_build_object(
      'entity_type', 'marketplace_order_pending',
      'title', format('Pending marketplace order %s', v_order.order_number),
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'customer_name', v_order.customer_name,
      'customer_phone', v_order.customer_phone,
      'customer_city', v_order.customer_city,
      'amount', v_order.total,
      'currency', COALESCE(NULLIF(v_order.currency, ''), 'iqd'),
      'created_at', v_order.created_at,
      'due_date', v_due_date,
      'item_count', v_item_count
    )
  )
  FROM public.profiles p
  WHERE p.workspace_id = v_order.workspace_id
    AND LOWER(BTRIM(COALESCE(p.role, ''))) IN ('admin', 'staff');
END;
$function$;

REVOKE ALL ON FUNCTION public.queue_marketplace_pending_order_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_marketplace_pending_order_notifications(uuid) TO service_role;
