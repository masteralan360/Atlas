-- Exclude recipient-side collection cash rows from the organization statement's
-- default list. The records and collection summaries remain available.
DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(
    'public.postal_organization_statement(uuid,uuid,integer,integer,timestamptz,timestamptz,text,text)'::regprocedure
  ) INTO v_definition;

  IF position('p_kind NOT IN (''all'', ''delivery_accrual'', ''collection'', ''settlement'', ''delivery_fee'')' IN v_definition) = 0
    OR position('WHERE (p_kind = ''all'' OR p.kind = p_kind)' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate the expected postal organization statement filters';
  END IF;

  v_updated := replace(
    v_definition,
    'p_kind NOT IN (''all'', ''delivery_accrual'', ''collection'', ''settlement'', ''delivery_fee'')',
    'p_kind NOT IN (''all'', ''organization'', ''delivery_accrual'', ''collection'', ''settlement'', ''delivery_fee'')'
  );
  v_updated := replace(
    v_updated,
    'WHERE (p_kind = ''all'' OR p.kind = p_kind)',
    'WHERE (p_kind = ''all'' OR p.kind = p_kind OR (p_kind = ''organization'' AND p.kind <> ''collection''))'
  );

  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'Could not update postal organization statement filters';
  END IF;
  EXECUTE v_updated;
END $$;
