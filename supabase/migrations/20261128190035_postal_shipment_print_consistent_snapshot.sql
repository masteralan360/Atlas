-- Gather the server-paged shipment list in one stable database snapshot.
-- The existing page RPC remains the source of filtering, ordering, and access rules.
CREATE FUNCTION public.postal_shipment_print_snapshot(
  p_workspace_id uuid,
  p_search text DEFAULT '',
  p_status text DEFAULT 'all',
  p_start timestamptz DEFAULT NULL,
  p_end timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_page_size constant integer := 100;
  v_page_number integer := 1;
  v_first_page jsonb;
  v_page jsonb;
  v_total integer;
  v_rows jsonb;
  v_page_rows jsonb;
BEGIN
  v_first_page := public.postal_shipment_page(
    p_workspace_id,
    v_page_number,
    v_page_size,
    p_search,
    p_status,
    p_start,
    p_end
  );
  v_total := (v_first_page ->> 'total')::integer;
  v_rows := v_first_page -> 'rows';

  IF v_total IS NULL OR pg_catalog.jsonb_typeof(v_rows) <> 'array' THEN
    RAISE EXCEPTION 'postal_invalid_result';
  END IF;

  WHILE pg_catalog.jsonb_array_length(v_rows) < v_total LOOP
    v_page_number := v_page_number + 1;
    IF v_page_number > 1000000 THEN
      RAISE EXCEPTION 'postal_results_incomplete';
    END IF;

    v_page := public.postal_shipment_page(
      p_workspace_id,
      v_page_number,
      v_page_size,
      p_search,
      p_status,
      p_start,
      p_end
    );

    IF (v_page ->> 'total')::integer <> v_total THEN
      RAISE EXCEPTION 'postal_results_changed';
    END IF;

    v_page_rows := v_page -> 'rows';
    IF pg_catalog.jsonb_typeof(v_page_rows) <> 'array'
      OR pg_catalog.jsonb_array_length(v_page_rows) = 0 THEN
      RAISE EXCEPTION 'postal_results_incomplete';
    END IF;

    v_rows := v_rows || v_page_rows;
  END LOOP;

  IF pg_catalog.jsonb_array_length(v_rows) <> v_total THEN
    RAISE EXCEPTION 'postal_results_changed';
  END IF;

  RETURN pg_catalog.jsonb_build_object('rows', v_rows, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.postal_shipment_print_snapshot(uuid,text,text,timestamptz,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_shipment_print_snapshot(uuid,text,text,timestamptz,timestamptz)
  TO authenticated, service_role;
