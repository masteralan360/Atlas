ALTER TABLE public.postal_branches
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT postal_branches_primary_must_be_active
    CHECK (NOT is_primary OR active);

CREATE UNIQUE INDEX postal_branches_one_primary_per_workspace
  ON public.postal_branches(workspace_id)
  WHERE is_primary;

CREATE FUNCTION postal_private.normalize_primary_branch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=''
AS $$
BEGIN
  IF NOT NEW.active THEN
    NEW.is_primary := false;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION postal_private.normalize_primary_branch()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER postal_branches_primary_active
BEFORE INSERT OR UPDATE OF active, is_primary ON public.postal_branches
FOR EACH ROW EXECUTE FUNCTION postal_private.normalize_primary_branch();

CREATE FUNCTION public.postal_save_branch(
  p_payload jsonb,
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
  target public.postal_branches%ROWTYPE;
  previous_primary public.postal_branches%ROWTYPE;
  previous_after public.postal_branches%ROWTYPE;
  before_data jsonb;
  result jsonb;
  branch_id uuid;
  branch_name text := btrim(COALESCE(p_payload->>'name', ''));
  branch_active boolean := COALESCE(NULLIF(p_payload->>'active', '')::boolean, true);
  branch_is_primary boolean := COALESCE(NULLIF(p_payload->>'is_primary', '')::boolean, false)
    AND COALESCE(NULLIF(p_payload->>'active', '')::boolean, true);
BEGIN
  role_name := postal_private.access_role(w);
  IF actor IS NULL OR w IS NULL OR p_request_id IS NULL
     OR role_name IS DISTINCT FROM 'admin'
     OR p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR (p_payload ? 'workspace_id' AND (p_payload->>'workspace_id')::uuid IS DISTINCT FROM w) THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501';
  END IF;

  request_payload := p_payload || jsonb_build_object('workspace_id', w);
  PERFORM pg_advisory_xact_lock(
    hashtextextended(w::text || actor::text || p_request_id::text, 0)
  );
  SELECT * INTO cached
  FROM postal_private.requests
  WHERE workspace_id = w AND actor_id = actor AND request_id = p_request_id;
  IF FOUND THEN
    IF cached.command <> 'save_branch' OR cached.payload <> request_payload THEN
      RAISE EXCEPTION 'postal_request_conflict';
    END IF;
    RETURN cached.response;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(w::text || ':postal-primary-branch', 0)
  );

  IF branch_is_primary THEN
    IF NULLIF(p_payload->>'id', '') IS NOT NULL THEN
      branch_id := (p_payload->>'id')::uuid;
      PERFORM id FROM public.postal_branches
      WHERE workspace_id = w AND id = branch_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'postal_unavailable' USING ERRCODE='42501';
      END IF;
    END IF;

    SELECT * INTO previous_primary
    FROM public.postal_branches
    WHERE workspace_id = w
      AND is_primary
      AND (branch_id IS NULL OR id <> branch_id)
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.postal_branches
      SET is_primary = false, updated_at = now()
      WHERE id = previous_primary.id
      RETURNING * INTO previous_after;

      INSERT INTO public.postal_admin_audit(
        workspace_id, actor_id, action, entity_id, before_data, after_data
      ) VALUES (
        w, actor, 'unset_branch_primary', previous_primary.id,
        to_jsonb(previous_primary), to_jsonb(previous_after)
      );
    END IF;
  END IF;

  IF NULLIF(p_payload->>'id', '') IS NULL THEN
    INSERT INTO public.postal_branches(
      workspace_id, name, governorate, area, address, active, is_primary
    ) VALUES (
      w,
      branch_name,
      p_payload->>'governorate',
      p_payload->>'area',
      p_payload->>'address',
      branch_active,
      branch_is_primary
    ) RETURNING * INTO target;
  ELSE
    branch_id := (p_payload->>'id')::uuid;
    SELECT * INTO target
    FROM public.postal_branches
    WHERE workspace_id = w AND id = branch_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'postal_unavailable' USING ERRCODE='42501';
    END IF;
    before_data := to_jsonb(target);
    UPDATE public.postal_branches
    SET name = branch_name,
        governorate = p_payload->>'governorate',
        area = p_payload->>'area',
        address = p_payload->>'address',
        active = branch_active,
        is_primary = branch_is_primary,
        updated_at = now()
    WHERE workspace_id = w AND id = branch_id
    RETURNING * INTO target;
  END IF;

  INSERT INTO public.postal_admin_audit(
    workspace_id, actor_id, action, entity_id, before_data, after_data
  ) VALUES (
    w,
    actor,
    'save_branch',
    target.id,
    before_data,
    to_jsonb(target)
  );

  result := to_jsonb(target);
  INSERT INTO postal_private.requests(
    workspace_id, actor_id, request_id, command, payload, response
  ) VALUES (
    w, actor, p_request_id, 'save_branch', request_payload, result
  );
  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.postal_save_branch(jsonb, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_save_branch(jsonb, uuid)
  TO authenticated, service_role;
