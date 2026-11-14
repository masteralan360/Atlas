-- Organization shipment status changes are pushed to merchant staff in the
-- shipment's organization. Other organization notifications remain inbox-only.
DO $migration$
DECLARE
  v_definition text;
  v_old_push_status text := 'v_push_status := CASE WHEN v_scope = ''organization'' THEN ''skipped'' ELSE ''pending'' END;';
BEGIN
  v_definition := pg_get_functiondef(
    'public.upsert_notification_inbox(uuid,uuid,uuid,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone)'::regprocedure
  );
  IF position(v_old_push_status IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate organization notification push status rule';
  END IF;

  v_definition := replace(
    v_definition,
    v_old_push_status,
    'v_push_status := CASE WHEN v_scope = ''organization'' AND p_notification_type <> ''postal_shipment_status_changed'' THEN ''skipped'' ELSE ''pending'' END;'
  );
  EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
  v_definition text;
  v_old_scope_filter text := 'AND notification.scope <> ''organization''';
  v_old_merchant_filter text := E'AND (\n        NOT postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)\n        OR notification.scope = ''user''\n      )';
BEGIN
  v_definition := pg_get_functiondef(
    'public.get_pending_push_notification_targets(integer,uuid)'::regprocedure
  );
  IF position(v_old_scope_filter IN v_definition) = 0
    OR position(v_old_merchant_filter IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Could not locate pending notification push scope filters';
  END IF;

  v_definition := replace(
    v_definition,
    v_old_scope_filter,
    E'AND (\n        notification.scope <> ''organization''\n        OR (\n          notification.notification_type = ''postal_shipment_status_changed''\n          AND postal_private.notification_organization_access(\n            notification.workspace_id,\n            notification.user_id,\n            notification.organization_id\n          )\n        )\n      )'
  );
  v_definition := replace(
    v_definition,
    v_old_merchant_filter,
    E'AND (\n        NOT postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)\n        OR notification.scope = ''user''\n        OR (\n          notification.scope = ''organization''\n          AND notification.notification_type = ''postal_shipment_status_changed''\n          AND postal_private.notification_organization_access(\n            notification.workspace_id,\n            notification.user_id,\n            notification.organization_id\n          )\n        )\n      )'
  );
  EXECUTE v_definition;
END;
$migration$;

CREATE OR REPLACE FUNCTION postal_private.notify_organization_on_shipment_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_organization_id uuid;
  v_shipment_number bigint;
  v_shipment_year integer;
  v_member record;
  v_recipient_count integer := 0;
BEGIN
  IF NEW.previous_state IS NULL
    OR NEW.resulting_state IS NULL
    OR NEW.previous_state IS NOT DISTINCT FROM NEW.resulting_state
  THEN
    RETURN NEW;
  END IF;

  SELECT
    shipment.organization_id,
    shipment.shipment_number,
    EXTRACT(YEAR FROM shipment.created_at AT TIME ZONE 'UTC')::integer
  INTO v_organization_id, v_shipment_number, v_shipment_year
  FROM public.postal_shipments AS shipment
  WHERE shipment.workspace_id = NEW.workspace_id
    AND shipment.id = NEW.shipment_id;

  IF v_organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  FOR v_member IN
    SELECT DISTINCT membership.user_id
    FROM public.postal_memberships AS membership
    JOIN public.profiles AS profile
      ON profile.id = membership.user_id
     AND profile.workspace_id = membership.workspace_id
    JOIN public.workspace_permissions AS permission
      ON permission.workspace_id = profile.workspace_id
     AND permission.user_uuid = profile.id
     AND permission.key = 'postService.merchant'
    WHERE membership.workspace_id = NEW.workspace_id
      AND membership.organization_id = v_organization_id
      AND profile.role = 'staff'
    ORDER BY membership.user_id
  LOOP
    PERFORM public.upsert_notification_event(
      p_workspace_id => NEW.workspace_id,
      p_user_id => v_member.user_id,
      p_entity_type => 'postal_shipment_status_changed',
      p_entity_id => NEW.id::text,
      p_due_date => COALESCE(NEW.created_at::date, now()::date),
      p_payload => jsonb_build_object(
        'scope', 'organization',
        'organization_id', v_organization_id,
        'shipment_id', NEW.shipment_id,
        'shipment_number', v_shipment_number,
        'previous_state', NEW.previous_state,
        'resulting_state', NEW.resulting_state,
        'route', format(
          '/post-service/shipments/PS-%s-%s',
          v_shipment_year,
          lpad(v_shipment_number::text, 6, '0')
        ),
        'action_label', 'Open shipment',
        'title', 'Shipment status updated',
        'body', format('Shipment #%s: %s → %s', v_shipment_number, NEW.previous_state, NEW.resulting_state),
        'priority', 'normal'
      )
    );
    v_recipient_count := v_recipient_count + 1;
  END LOOP;

  IF v_recipient_count > 0 THEN
    BEGIN
      PERFORM public.request_dispatch_notifications(NEW.workspace_id);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'Immediate postal notification dispatch request failed for workspace %: %',
          NEW.workspace_id,
          SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION postal_private.notify_organization_on_shipment_status_change()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS postal_organization_shipment_status_notification
  ON public.postal_events;
CREATE TRIGGER postal_organization_shipment_status_notification
AFTER INSERT ON public.postal_events
FOR EACH ROW
EXECUTE FUNCTION postal_private.notify_organization_on_shipment_status_change();
