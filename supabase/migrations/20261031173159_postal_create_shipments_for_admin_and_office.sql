CREATE FUNCTION postal_private.shipment_creation_organization(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_role text,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_organization_id uuid;
BEGIN
  IF p_role = 'merchant' THEN
    SELECT organization_id INTO v_organization_id
    FROM public.postal_memberships
    WHERE workspace_id = p_workspace_id AND user_id = p_actor_id;
    IF v_organization_id IS NULL THEN
      RAISE EXCEPTION 'postal_unavailable' USING ERRCODE = '42501';
    END IF;
  ELSIF p_role IN ('admin', 'office') THEN
    BEGIN
      v_organization_id := NULLIF(p_payload->>'organization_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'postal_invalid_organization';
    END;
    IF v_organization_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.postal_organizations
      WHERE workspace_id = p_workspace_id AND id = v_organization_id
    ) THEN
      RAISE EXCEPTION 'postal_invalid_organization';
    END IF;
  ELSE
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE = '42501';
  END IF;
  RETURN v_organization_id;
END $$;

REVOKE ALL ON FUNCTION postal_private.shipment_creation_organization(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

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
    '(p_command=''create_shipment'' AND r<>''merchant'')',
    '(p_command=''create_shipment'' AND r NOT IN (''merchant'',''admin'',''office''))'
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal command replay authorization';
  END IF;

  v_source := v_updated;
  v_updated := regexp_replace(
    v_source,
    'IF r<>''merchant'' THEN RAISE EXCEPTION ''postal_not_authorized'' USING ERRCODE=''42501''; END IF;[[:space:]]+SELECT organization_id INTO org FROM public[.]postal_memberships WHERE workspace_id=w AND user_id=actor;',
    'org := postal_private.shipment_creation_organization(w,actor,r,p_payload);'
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'Could not update postal command organization assignment';
  END IF;

  EXECUTE format(
    $ddl$CREATE OR REPLACE FUNCTION postal_private.command(
      p_command text,
      p_payload jsonb,
      p_request_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS %L$ddl$,
    v_updated
  );
END $$;
