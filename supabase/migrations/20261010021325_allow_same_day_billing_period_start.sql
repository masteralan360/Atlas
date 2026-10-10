-- Billing adjustments may start and renew on the same calendar day, provided
-- the full period-start timestamp is earlier than the renewal timestamp.
DO $allow_same_day_billing_period_start$
DECLARE
  v_definition text := pg_get_functiondef(
    'billing.apply_admin_billing_snapshot(uuid,text,jsonb,text,boolean,uuid)'::regprocedure
  );
  v_declaration_anchor text := '  v_start text;';
  v_start_parse_anchor text := 'v_start := NULLIF(p_snapshot->>''usage_start_date'', '''');';
  v_start_validation_anchor text := 'IF v_start::date >= v_renewal::timestamptz::date THEN';
BEGIN
  IF strpos(v_definition, v_declaration_anchor) = 0
    OR strpos(v_definition, v_start_parse_anchor) = 0
    OR strpos(v_definition, v_start_validation_anchor) = 0 THEN
    RAISE EXCEPTION 'billing_adjustment_period_validation_definition_changed';
  END IF;

  v_definition := replace(
    v_definition,
    v_declaration_anchor,
    v_declaration_anchor || chr(10) || '  v_start_at text;'
  );
  v_definition := replace(
    v_definition,
    v_start_parse_anchor,
    v_start_parse_anchor || chr(10) || '    v_start_at := NULLIF(p_snapshot->>''usage_start_at'', '''');'
  );
  v_definition := replace(
    v_definition,
    v_start_validation_anchor,
    'IF COALESCE(v_start_at, v_start)::timestamptz >= v_renewal::timestamptz THEN'
  );

  EXECUTE v_definition;
END;
$allow_same_day_billing_period_start$;
