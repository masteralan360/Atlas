WITH ranked_events AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, entity_type, entity_id, due_date
      ORDER BY created_at ASC, id ASC
    ) AS row_number
  FROM notifications.events
)
DELETE FROM notifications.events e
USING ranked_events r
WHERE e.id = r.id
  AND r.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_events_dedupe
  ON notifications.events (user_id, entity_type, entity_id, due_date);

CREATE OR REPLACE FUNCTION public.upsert_notification_event(
  p_workspace_id uuid,
  p_user_id uuid,
  p_entity_type text,
  p_entity_id text,
  p_due_date date,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_event_id uuid;
BEGIN
  INSERT INTO notifications.events (
    workspace_id,
    user_id,
    entity_type,
    entity_id,
    due_date,
    payload,
    status,
    attempt_count,
    last_attempt_at,
    error
  )
  VALUES (
    p_workspace_id,
    p_user_id,
    p_entity_type,
    p_entity_id,
    p_due_date,
    COALESCE(p_payload, '{}'::jsonb),
    'pending',
    0,
    NULL,
    NULL
  )
  ON CONFLICT (user_id, entity_type, entity_id, due_date) DO UPDATE
  SET
    workspace_id = EXCLUDED.workspace_id,
    payload = EXCLUDED.payload,
    status = 'pending',
    attempt_count = 0,
    last_attempt_at = NULL,
    error = NULL,
    updated_at = now()
  WHERE notifications.events.workspace_id IS DISTINCT FROM EXCLUDED.workspace_id
     OR notifications.events.payload IS DISTINCT FROM EXCLUDED.payload
     OR notifications.events.status IN ('failed', 'pending')
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT e.id
    INTO v_event_id
    FROM notifications.events e
    WHERE e.user_id = p_user_id
      AND e.entity_type = p_entity_type
      AND e.entity_id = p_entity_id
      AND e.due_date = p_due_date;
  END IF;

  RETURN v_event_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_notification_event(uuid, uuid, text, text, date, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_notification_event(uuid, uuid, text, text, date, jsonb) TO service_role;

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
    AND p.role IN ('admin', 'staff');
END;
$function$;

REVOKE ALL ON FUNCTION public.queue_marketplace_pending_order_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.queue_marketplace_pending_order_notifications(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_notification_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_event record;
  v_payload jsonb;
  v_processed integer := 0;
  v_batch_processed integer;
  v_title text;
  v_body text;
  v_action_url text;
  v_action_label text;
  v_scope text;
  v_priority text;
  v_dedupe_key text;
  v_due_date text;
  v_order_id text;
  v_order_number text;
  v_customer_name text;
  v_item_count integer;
  v_amount numeric;
  v_currency text;
BEGIN
  LOOP
    v_batch_processed := 0;

    FOR v_event IN
      SELECT *
      FROM public.get_pending_notification_events()
    LOOP
      BEGIN
        v_payload := COALESCE(v_event.payload, '{}'::jsonb);
        v_due_date := NULLIF(BTRIM(COALESCE(v_payload ->> 'due_date', '')), '');
        v_title := NULLIF(BTRIM(COALESCE(v_payload ->> 'title', '')), '');
        v_body := COALESCE(
          NULLIF(BTRIM(COALESCE(v_payload ->> 'body', '')), ''),
          NULLIF(BTRIM(COALESCE(v_payload ->> 'preview', '')), ''),
          NULLIF(BTRIM(COALESCE(v_payload ->> 'summary', '')), '')
        );
        v_action_url := NULLIF(BTRIM(COALESCE(v_payload ->> 'route', '')), '');
        v_action_label := NULLIF(BTRIM(COALESCE(v_payload ->> 'action_label', '')), '');
        v_scope := NULLIF(BTRIM(COALESCE(v_payload ->> 'scope', '')), '');
        v_priority := NULLIF(BTRIM(COALESCE(v_payload ->> 'priority', '')), '');

        v_scope := CASE
          WHEN v_scope IN ('user', 'workspace', 'system') THEN v_scope
          WHEN v_event.entity_type = 'marketplace_order_pending' THEN 'workspace'
          ELSE 'user'
        END;

        v_priority := CASE
          WHEN v_priority IN ('low', 'normal', 'high', 'urgent') THEN v_priority
          ELSE 'normal'
        END;

        v_dedupe_key := concat_ws(
          ':',
          v_event.user_id::text,
          v_event.entity_type,
          v_event.entity_id,
          COALESCE(v_due_date, to_char(v_event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
        );

        IF v_event.entity_type = 'marketplace_order_pending' THEN
          v_order_id := COALESCE(NULLIF(BTRIM(COALESCE(v_payload ->> 'order_id', '')), ''), v_event.entity_id);
          v_order_number := NULLIF(BTRIM(COALESCE(v_payload ->> 'order_number', '')), '');
          v_customer_name := NULLIF(BTRIM(COALESCE(v_payload ->> 'customer_name', '')), '');

          v_item_count := CASE
            WHEN COALESCE(v_payload ->> 'item_count', '') ~ '^-?\d+$' THEN (v_payload ->> 'item_count')::integer
            ELSE NULL
          END;

          v_amount := CASE
            WHEN COALESCE(v_payload ->> 'amount', '') ~ '^-?\d+(\.\d+)?$' THEN (v_payload ->> 'amount')::numeric
            ELSE NULL
          END;

          v_currency := UPPER(NULLIF(BTRIM(COALESCE(v_payload ->> 'currency', '')), ''));
          v_title := COALESCE(
            v_title,
            CASE
              WHEN v_order_number IS NOT NULL THEN format('Pending marketplace order %s', v_order_number)
              ELSE 'Pending marketplace order'
            END
          );

          IF v_body IS NULL THEN
            v_body := concat_ws(
              ' | ',
              v_customer_name,
              CASE
                WHEN v_item_count IS NOT NULL AND v_item_count > 0
                  THEN format('%s item%s', v_item_count, CASE WHEN v_item_count = 1 THEN '' ELSE 's' END)
                ELSE NULL
              END,
              CASE
                WHEN v_amount IS NOT NULL
                  THEN concat_ws(' ', trim(to_char(v_amount, 'FM999999999990.##')), NULLIF(v_currency, ''))
                ELSE NULL
              END
            );
          END IF;

          v_action_url := COALESCE(v_action_url, CASE WHEN v_order_id IS NOT NULL THEN format('/ecommerce/%s', v_order_id) ELSE '/ecommerce' END);
          v_action_label := COALESCE(v_action_label, 'Open order');
        ELSE
          v_title := COALESCE(
            v_title,
            INITCAP(REPLACE(REPLACE(v_event.entity_type, '_', ' '), '-', ' '))
          );
          v_body := COALESCE(
            v_body,
            NULLIF(BTRIM(COALESCE(v_payload ->> 'content', '')), ''),
            NULLIF(BTRIM(COALESCE(v_payload ->> 'message', '')), '')
          );
        END IF;

        PERFORM public.upsert_notification_inbox(
          p_event_id => v_event.id,
          p_workspace_id => v_event.workspace_id,
          p_user_id => v_event.user_id,
          p_notification_type => v_event.entity_type,
          p_scope => v_scope,
          p_priority => v_priority,
          p_dedupe_key => v_dedupe_key,
          p_title => v_title,
          p_body => v_body,
          p_action_url => v_action_url,
          p_action_label => v_action_label,
          p_payload => v_payload,
          p_created_at => v_event.created_at
        );

        PERFORM public.update_notification_event_status(
          v_event.id,
          'sent'::text,
          NULL::text,
          NULL::integer
        );
      EXCEPTION
        WHEN OTHERS THEN
          PERFORM public.update_notification_event_status(
            v_event.id,
            'failed'::text,
            SQLERRM::text,
            NULL::integer
          );
      END;

      v_processed := v_processed + 1;
      v_batch_processed := v_batch_processed + 1;
    END LOOP;

    EXIT WHEN v_batch_processed = 0;
  END LOOP;

  RETURN v_processed;
END;
$function$;


REVOKE ALL ON FUNCTION public.dispatch_notification_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_notification_events() TO service_role;

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
      AND p.role = 'admin'
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
      AND p.role = 'admin'
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
      AND p.role = 'admin'
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

  v_dispatched_count := public.dispatch_notification_events();
  RETURN COALESCE(v_dispatched_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.detect_and_dispatch_notification_events(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_and_dispatch_notification_events(uuid) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'detect-and-dispatch-notifications',
  '*/5 * * * *',
  $$SELECT public.detect_and_dispatch_notification_events();$$
);
