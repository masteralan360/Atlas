ALTER TABLE public.postal_organizations
  ALTER COLUMN leader_id DROP NOT NULL;

CREATE FUNCTION postal_private.create_organization_record(
  p_workspace_id uuid,
  p_name text,
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
      INSERT INTO public.postal_organizations(workspace_id, name, code, leader_id)
      VALUES (p_workspace_id, btrim(p_name), v_code, p_leader_id)
      RETURNING * INTO v_organization;
      RETURN v_organization;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION postal_private.create_organization_record(uuid, text, uuid)
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
      w, e->>'name', NEW.id
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

  -- An organization created without a merchant gets its first leader when a
  -- merchant later joins through the existing organization-code enrollment flow.
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

CREATE FUNCTION postal_private.create_organization_command(
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

  v_organization := postal_private.create_organization_record(w, v_name, NULL);
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

CREATE OR REPLACE FUNCTION public.postal_command(
  p_command text,
  p_payload jsonb,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = '' AS $$
BEGIN
  IF p_command = 'create_organization' THEN
    RETURN postal_private.create_organization_command(p_payload, p_request_id);
  ELSIF p_command = 'receive' THEN
    PERFORM set_config('postal.tariff_authorized', 'true', true);
    PERFORM set_config('postal.tariff_size', COALESCE(p_payload->>'tariff_size', ''), true);
    PERFORM set_config('postal.tariff_fee', COALESCE(p_payload->>'delivery_fee', ''), true);
  ELSIF p_command = 'delivery_fee_collection' THEN
    RETURN postal_private.delivery_fee_collection(p_payload, p_request_id);
  END IF;
  RETURN postal_private.command(p_command, p_payload, p_request_id);
END $$;

REVOKE ALL ON FUNCTION public.postal_command(text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text, jsonb, uuid)
  TO authenticated, service_role;
