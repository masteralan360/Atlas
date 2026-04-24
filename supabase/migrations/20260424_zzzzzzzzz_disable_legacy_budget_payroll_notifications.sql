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
  v_notification_type text;
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

        IF v_event.entity_type = 'budget_payroll'
          OR (
            v_event.entity_type = 'payroll_overdue'
            AND v_payload ? 'status_id'
          ) THEN
          DELETE FROM notifications.inbox
          WHERE event_id = v_event.id;

          PERFORM public.update_notification_event_status(
            v_event.id,
            'sent'::text,
            NULL::text,
            NULL::integer
          );

          v_processed := v_processed + 1;
          v_batch_processed := v_batch_processed + 1;
          CONTINUE;
        END IF;

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
        v_notification_type := CASE
          WHEN v_event.entity_type = 'budget_payroll' THEN 'payroll_overdue'
          ELSE v_event.entity_type
        END;
        v_priority := NULLIF(BTRIM(COALESCE(v_payload ->> 'priority', '')), '');

        v_scope := CASE
          WHEN v_scope IN ('user', 'workspace', 'system') THEN v_scope
          WHEN v_notification_type = 'marketplace_order_pending' THEN 'workspace'
          ELSE 'user'
        END;

        v_priority := CASE
          WHEN v_priority IN ('low', 'normal', 'high', 'urgent') THEN v_priority
          ELSE 'normal'
        END;

        v_dedupe_key := concat_ws(
          ':',
          v_event.user_id::text,
          v_notification_type,
          v_event.entity_id,
          COALESCE(v_due_date, to_char(v_event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
        );

        IF v_notification_type = 'marketplace_order_pending' THEN
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
        ELSIF v_notification_type = 'payroll_overdue' THEN
          v_amount := CASE
            WHEN COALESCE(v_payload ->> 'amount', '') ~ '^-?\d+(\.\d+)?$' THEN (v_payload ->> 'amount')::numeric
            ELSE NULL
          END;

          v_currency := UPPER(NULLIF(BTRIM(COALESCE(v_payload ->> 'currency', '')), ''));
          v_customer_name := COALESCE(
            NULLIF(BTRIM(COALESCE(v_payload ->> 'employee_name', '')), ''),
            CASE
              WHEN v_event.entity_type = 'budget_payroll' THEN NULLIF(BTRIM(COALESCE(v_payload ->> 'title', '')), '')
              ELSE NULL
            END
          );

          v_title := COALESCE(
            CASE
              WHEN v_customer_name IS NOT NULL THEN format('Payroll overdue for %s', v_customer_name)
              ELSE NULL
            END,
            v_title,
            'Payroll overdue'
          );

          IF v_body IS NULL THEN
            v_body := concat_ws(
              ' | ',
              COALESCE(NULLIF(BTRIM(COALESCE(v_payload ->> 'employee_role', '')), ''), 'Employee'),
              CASE
                WHEN v_amount IS NOT NULL
                  THEN concat_ws(' ', trim(to_char(v_amount, 'FM999999999990.##')), NULLIF(v_currency, ''))
                ELSE NULL
              END,
              NULLIF(BTRIM(COALESCE(v_payload ->> 'month', '')), '')
            );
          END IF;

          v_scope := 'workspace';
          IF NULLIF(BTRIM(COALESCE(v_payload ->> 'priority', '')), '') IS NULL THEN
            v_priority := 'high';
          END IF;
          v_action_url := COALESCE(v_action_url, '/budget');
          v_action_label := COALESCE(v_action_label, 'Open budget');
          v_payload := jsonb_strip_nulls(
            v_payload || jsonb_build_object(
              'entity_type', 'payroll_overdue',
              'employee_name', v_customer_name,
              'employee_role', COALESCE(NULLIF(BTRIM(COALESCE(v_payload ->> 'employee_role', '')), ''), 'Employee'),
              'route', v_action_url,
              'action_label', v_action_label,
              'scope', v_scope,
              'priority', v_priority,
              'title', v_title,
              'body', v_body
            )
          );
        ELSE
          v_title := COALESCE(
            v_title,
            INITCAP(REPLACE(REPLACE(v_notification_type, '_', ' '), '-', ' '))
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
          p_notification_type => v_notification_type,
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

DO $do$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'overdue_notifications_hourly'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END;
$do$;

DROP FUNCTION IF EXISTS notifications.cron_overdue_job();
DROP FUNCTION IF EXISTS notifications.detect_overdue_events();

DELETE FROM notifications.inbox
WHERE notification_type = 'budget_payroll'
   OR (
     notification_type = 'payroll_overdue'
     AND COALESCE(payload, '{}'::jsonb) ? 'status_id'
   );

DELETE FROM notifications.events
WHERE entity_type = 'budget_payroll'
   OR (
     entity_type = 'payroll_overdue'
     AND COALESCE(payload, '{}'::jsonb) ? 'status_id'
   );
