CREATE FUNCTION postal_private.prevent_duplicate_branch_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  IF TG_OP = 'UPDATE' THEN
    IF lower(NEW.name) = lower(btrim(OLD.name)) THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.workspace_id::text || ':postal-branch-names', 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.postal_branches branch
    WHERE branch.workspace_id = NEW.workspace_id
      AND lower(btrim(branch.name)) = lower(NEW.name)
      AND branch.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'postal_duplicate_branch_name' USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION postal_private.prevent_duplicate_branch_name()
  FROM PUBLIC, anon, authenticated;

CREATE INDEX postal_branches_normalized_name
ON public.postal_branches(workspace_id, lower(btrim(name)));

CREATE TRIGGER postal_branches_unique_name
BEFORE INSERT OR UPDATE OF name ON public.postal_branches
FOR EACH ROW EXECUTE FUNCTION postal_private.prevent_duplicate_branch_name();

CREATE FUNCTION public.postal_add_governorate_branches(
  p_locale text,
  p_branches jsonb,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  w uuid := public.current_workspace_id();
  actor uuid := auth.uid();
  role_name text;
  cached postal_private.requests%ROWTYPE;
  request_payload jsonb;
  result jsonb;
  item jsonb;
  created public.postal_branches%ROWTYPE;
  branch_rows jsonb := '[]'::jsonb;
  item_count integer;
  distinct_governorates integer;
  distinct_names integer;
  expected_governorates integer;
BEGIN
  role_name := postal_private.access_role(w);
  IF actor IS NULL OR p_request_id IS NULL OR role_name IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;

  request_payload := jsonb_build_object(
    'workspace_id', w,
    'locale', p_locale,
    'branches', p_branches
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(w::text || actor::text || p_request_id::text, 0)
  );
  SELECT * INTO cached
  FROM postal_private.requests
  WHERE workspace_id = w AND actor_id = actor AND request_id = p_request_id;
  IF FOUND THEN
    IF cached.command <> 'bulk_add_governorate_branches'
       OR cached.payload <> request_payload THEN
      RAISE EXCEPTION 'postal_request_conflict';
    END IF;
    RETURN cached.response;
  END IF;

  IF p_locale IS NULL OR p_locale NOT IN ('en', 'ar', 'ku') THEN
    RAISE EXCEPTION 'postal_invalid_governorates';
  END IF;
  IF p_branches IS NULL OR jsonb_typeof(p_branches) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'postal_invalid_governorates';
  END IF;

  SELECT
    count(*),
    count(DISTINCT branch_item.value->>'governorate'),
    count(DISTINCT lower(btrim(branch_item.value->>'name')))
  INTO item_count, distinct_governorates, distinct_names
  FROM jsonb_array_elements(p_branches) AS branch_item(value);

  IF item_count < 1 OR item_count > 50
     OR distinct_governorates <> item_count
     OR distinct_names <> item_count
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_branches) AS branch_item(value)
       WHERE jsonb_typeof(branch_item.value) IS DISTINCT FROM 'object'
          OR jsonb_typeof(branch_item.value->'name') IS DISTINCT FROM 'string'
          OR jsonb_typeof(branch_item.value->'governorate') IS DISTINCT FROM 'string'
          OR jsonb_typeof(branch_item.value->'area') IS DISTINCT FROM 'string'
          OR length(btrim(branch_item.value->>'name')) NOT BETWEEN 1 AND 120
          OR length(btrim(branch_item.value->>'governorate')) = 0
          OR length(btrim(branch_item.value->>'area')) = 0
     ) THEN
    RAISE EXCEPTION 'postal_invalid_governorates';
  END IF;

  SELECT count(DISTINCT governorate)
  INTO expected_governorates
  FROM public.postal_locations;
  IF item_count <> expected_governorates
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_branches) AS branch_item(value)
       WHERE NOT EXISTS (
         SELECT 1
         FROM public.postal_locations location
         WHERE location.governorate = branch_item.value->>'governorate'
           AND location.area = branch_item.value->>'area'
       )
     ) THEN
    RAISE EXCEPTION 'postal_invalid_governorates';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(w::text || ':postal-branch-names', 0)
  );
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_branches) AS branch_item(value)
    JOIN public.postal_branches branch
      ON branch.workspace_id = w
     AND lower(btrim(branch.name)) = lower(btrim(branch_item.value->>'name'))
  ) THEN
    RAISE EXCEPTION 'postal_duplicate_branch_name' USING ERRCODE = '23505';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_branches) AS branch_item(value)
  LOOP
    INSERT INTO public.postal_branches(
      workspace_id, name, governorate, area, address, active
    )
    VALUES (
      w,
      btrim(item->>'name'),
      item->>'governorate',
      item->>'area',
      NULL,
      true
    )
    RETURNING * INTO created;

    branch_rows := branch_rows || jsonb_build_array(to_jsonb(created));
    INSERT INTO public.postal_admin_audit(
      workspace_id, actor_id, action, entity_id, before_data, after_data
    )
    VALUES (
      w,
      actor,
      'bulk_add_governorate_branches',
      created.id,
      NULL,
      to_jsonb(created)
    );
  END LOOP;

  result := jsonb_build_object('count', item_count, 'branches', branch_rows);
  INSERT INTO postal_private.requests(
    workspace_id, actor_id, request_id, command, payload, response
  )
  VALUES (
    w,
    actor,
    p_request_id,
    'bulk_add_governorate_branches',
    request_payload,
    result
  );

  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.postal_add_governorate_branches(text, jsonb, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_add_governorate_branches(text, jsonb, uuid)
  TO authenticated, service_role;
