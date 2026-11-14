-- Preserve the merchant-only audience both when organization inbox rows are
-- materialized and when queued pushes are selected for delivery.
DO $migration$
DECLARE
  v_definition text;
  v_anchor text := 'IF v_scope = ''organization'' THEN';
BEGIN
  v_definition := pg_get_functiondef(
    'public.upsert_notification_inbox(uuid,uuid,uuid,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone)'::regprocedure
  );
  IF position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate organization inbox scope validation';
  END IF;

  v_definition := replace(
    v_definition,
    v_anchor,
    E'IF v_scope = ''organization'' THEN\n    IF p_notification_type = ''postal_shipment_status_changed'' AND NOT v_is_merchant THEN\n      RETURN NULL;\n    END IF;'
  );
  EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
  v_definition text;
  v_anchor text := E'AND postal_private.notification_organization_access(';
  v_guarded_anchor text := E'AND postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)\n          AND postal_private.notification_organization_access(';
  v_replacements integer;
BEGIN
  v_definition := pg_get_functiondef(
    'public.get_pending_push_notification_targets(integer,uuid)'::regprocedure
  );
  v_replacements := (
    length(v_definition) - length(replace(v_definition, v_anchor, ''))
  ) / length(v_anchor);
  IF v_replacements <> 2 THEN
    RAISE EXCEPTION 'Could not locate both organization push recipient checks';
  END IF;

  v_definition := replace(v_definition, v_anchor, v_guarded_anchor);
  EXECUTE v_definition;
END;
$migration$;
