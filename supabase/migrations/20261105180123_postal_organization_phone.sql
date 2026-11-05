ALTER TABLE public.postal_organizations
  ADD COLUMN phone text,
  ADD CONSTRAINT postal_organizations_phone_check
    CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 32);

CREATE FUNCTION postal_private.require_organization_phone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF length(btrim(COALESCE(NEW.phone, ''))) NOT BETWEEN 1 AND 32 THEN
      RAISE EXCEPTION 'postal_invalid_organization_phone';
    END IF;
  ELSIF NEW.phone IS DISTINCT FROM OLD.phone
    AND length(btrim(COALESCE(NEW.phone, ''))) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'postal_invalid_organization_phone';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION postal_private.require_organization_phone()
  FROM PUBLIC, anon, authenticated;
CREATE TRIGGER postal_organizations_phone_required
  BEFORE INSERT OR UPDATE ON public.postal_organizations
  FOR EACH ROW EXECUTE FUNCTION postal_private.require_organization_phone();

CREATE FUNCTION postal_private.create_organization_record(
  p_workspace_id uuid,
  p_name text,
  p_phone text,
  p_leader_id uuid
) RETURNS public.postal_organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
  v_code text;
  v_organization public.postal_organizations;
  i integer;
BEGIN
  IF length(btrim(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'postal_invalid_organization';
  END IF;
  IF length(btrim(COALESCE(p_phone, ''))) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'postal_invalid_organization_phone';
  END IF;

  LOOP
    v_code := '';
    FOR i IN 1..8 LOOP
      v_code := v_code || substr(
        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
        1 + (get_byte(uuid_send(gen_random_uuid()), 0) % 32),
        1
      );
    END LOOP;

    BEGIN
      INSERT INTO public.postal_organizations(workspace_id, name, phone, code, leader_id)
      VALUES (p_workspace_id, btrim(p_name), btrim(p_phone), v_code, p_leader_id)
      RETURNING * INTO v_organization;
      RETURN v_organization;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION postal_private.create_organization_record(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION postal_private.enroll_merchant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
  e jsonb := NEW.raw_app_meta_data->'postal_enrollment';
  w uuid;
  actor uuid;
  org uuid;
  created_organization public.postal_organizations;
BEGIN
  IF e IS NULL THEN RETURN NEW; END IF;
  w := (e->>'workspace_id')::uuid;
  actor := (e->>'actor_id')::uuid;
  IF NOT postal_private.module_granted(w)
    OR NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = actor AND p.role = 'admin' AND p.current_workspace = w
    )
  THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.profiles(id, name, role, workspace_id, current_workspace)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'name', 'staff', w, w)
  ON CONFLICT (id) DO UPDATE SET role = 'staff', workspace_id = w, current_workspace = w;

  IF e->>'mode' = 'create' THEN
    created_organization := postal_private.create_organization_record(
      w, e->>'name', e->>'phone', NEW.id
    );
    org := created_organization.id;
  ELSIF e->>'mode' = 'join' THEN
    SELECT id INTO org
    FROM public.postal_organizations
    WHERE workspace_id = w
      AND code = upper(replace(btrim(e->>'code'), '-', ''))
    FOR UPDATE;
    IF org IS NULL THEN RAISE EXCEPTION 'postal_invalid_organization'; END IF;
  ELSE
    RAISE EXCEPTION 'postal_invalid_organization';
  END IF;

  INSERT INTO public.postal_memberships(user_id, workspace_id, organization_id)
  VALUES (NEW.id, w, org);

  IF e->>'mode' = 'join' THEN
    UPDATE public.postal_organizations
    SET leader_id = NEW.id, updated_at = now()
    WHERE workspace_id = w AND id = org AND leader_id IS NULL;
  END IF;

  INSERT INTO public.workspace_permissions(workspace_id, user_uuid, key, module)
  VALUES (w, NEW.id, 'postService.merchant', 'postService');

  UPDATE auth.users
  SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}') - 'passkey',
      raw_app_meta_data = COALESCE(raw_app_meta_data, '{}') - 'postal_enrollment'
  WHERE id = NEW.id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION postal_private.create_organization_command(
  p_payload jsonb,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
  w uuid := public.current_workspace_id();
  actor uuid := auth.uid();
  cached postal_private.requests;
  v_name text := btrim(COALESCE(p_payload->>'name', ''));
  v_phone text := btrim(COALESCE(p_payload->>'phone', ''));
  v_organization public.postal_organizations;
  result jsonb;
BEGIN
  IF actor IS NULL OR p_request_id IS NULL
    OR postal_private.access_role(w) IS DISTINCT FROM 'admin'
  THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  IF (p_payload->>'workspace_id')::uuid IS DISTINCT FROM w THEN
    RAISE EXCEPTION 'postal_workspace_changed' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'postal_invalid_organization';
  END IF;
  IF length(v_phone) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'postal_invalid_organization_phone';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(w::text || actor::text || p_request_id::text, 0)
  );
  SELECT * INTO cached
  FROM postal_private.requests
  WHERE workspace_id = w AND actor_id = actor AND request_id = p_request_id;
  IF FOUND THEN
    IF cached.command <> 'create_organization'
      OR cached.payload IS DISTINCT FROM p_payload
    THEN
      RAISE EXCEPTION 'postal_request_conflict';
    END IF;
    RETURN cached.response;
  END IF;

  v_organization := postal_private.create_organization_record(w, v_name, v_phone, NULL);
  result := to_jsonb(v_organization);
  INSERT INTO public.postal_admin_audit(
    workspace_id, actor_id, action, entity_id, before_data, after_data
  ) VALUES (
    w, actor, 'create_organization', v_organization.id, NULL, result
  );
  INSERT INTO postal_private.requests(
    workspace_id, actor_id, request_id, command, payload, response
  ) VALUES (
    w, actor, p_request_id, 'create_organization', p_payload, result
  );
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION postal_private.create_organization_command(jsonb, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION postal_private.create_organization_command(jsonb, uuid)
  TO authenticated, service_role;

DO $$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT prosrc INTO v_source
  FROM pg_proc
  WHERE oid = 'postal_private.command(text,jsonb,uuid)'::regprocedure;

  v_updated := replace(
    v_source,
    $find$  UPDATE public.postal_organizations SET name=btrim(p_payload->>'name'),leader_id=(p_payload->>'leader_id')::uuid,updated_at=now()$find$,
    $replace$  IF length(btrim(COALESCE(p_payload->>'phone',''))) NOT BETWEEN 1 AND 32 THEN
   RAISE EXCEPTION 'postal_invalid_organization_phone';
  END IF;
  UPDATE public.postal_organizations SET name=btrim(p_payload->>'name'),phone=btrim(p_payload->>'phone'),leader_id=(p_payload->>'leader_id')::uuid,updated_at=now()$replace$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not add organization phone validation';
  END IF;

  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION postal_private.command(
      p_command text, p_payload jsonb, p_request_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS %L$ddl$,
    v_updated
  );
END
$$;
