-- A form needs two existence checks, not a full directory hydration followed
-- by a recalculation of every partner's financial summary.
CREATE INDEX IF NOT EXISTS business_partners_duplicate_name_idx
  ON crm.business_partners (workspace_id, LOWER(BTRIM(partner_name)))
  WHERE COALESCE(is_deleted, false) = false
    AND merged_into_business_partner_id IS NULL;

CREATE INDEX IF NOT EXISTS business_partners_duplicate_phone_idx
  ON crm.business_partners (workspace_id, REGEXP_REPLACE(
    TRANSLATE(COALESCE(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'
  ))
  WHERE COALESCE(is_deleted, false) = false
    AND merged_into_business_partner_id IS NULL;

CREATE OR REPLACE FUNCTION crm.check_business_partner_duplicates(
  p_workspace_id uuid,
  p_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_exclude_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
-- As with the scoped directory reader, authorize explicitly before reading.
-- RLS security barriers prevent normalized expression indexes from being
-- applied in an invoker query. Only existence flags cross this boundary.
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_name text := NULLIF(LOWER(BTRIM(p_name)), '');
  v_phone text := NULLIF(REGEXP_REPLACE(
    TRANSLATE(COALESCE(p_phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'
  ), '');
  v_restricted boolean;
  v_group_ids uuid[];
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NULL AND v_phone IS NULL THEN
    RETURN jsonb_build_object('name', false, 'phone', false);
  END IF;

  v_restricted := public.current_user_role() IS DISTINCT FROM 'admin'
    AND COALESCE(public.workspace_get_override_value(p_workspace_id, 'capability', 'businessPartnerGroupPrivacy'), 'revoke') = 'grant';
  IF v_restricted THEN
    SELECT ARRAY_AGG(g.id) INTO v_group_ids
    FROM crm.business_partner_groups g
    JOIN crm.business_partner_group_users u ON u.group_id = g.id AND u.workspace_id = g.workspace_id
    WHERE g.workspace_id = p_workspace_id AND NOT g.is_deleted
      AND NOT u.is_deleted AND u.user_id = auth.uid();
    IF v_group_ids IS NULL THEN
      SELECT ARRAY_AGG(g.id) INTO v_group_ids
      FROM crm.business_partner_groups g
      WHERE g.workspace_id = p_workspace_id AND NOT g.is_deleted AND g.access_type = 'non_grouped';
    END IF;
  END IF;

  WITH matches AS (
    SELECT LOWER(BTRIM(p.partner_name)) = v_name AS name,
      REGEXP_REPLACE(TRANSLATE(COALESCE(p.phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g') = v_phone AS phone
    FROM crm.business_partners p
    WHERE p.workspace_id = p_workspace_id
      AND COALESCE(p.is_deleted, false) = false
      AND p.merged_into_business_partner_id IS NULL
      AND p.role <> 'witness'
      AND p.id IS DISTINCT FROM p_exclude_id
      AND (
        p.role <> 'agent'
        OR public.workspace_module_allowed(p_workspace_id,
          (SELECT w.plan::text FROM public.workspaces w WHERE w.id = p_workspace_id), 'agents')
        OR delivery.module_allowed(p_workspace_id)
      )
      AND (
        LOWER(BTRIM(p.partner_name)) = v_name
        OR REGEXP_REPLACE(TRANSLATE(COALESCE(p.phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g') = v_phone
      )
      AND (NOT v_restricted OR EXISTS (
        SELECT 1 FROM crm.business_partner_group_partners gp
        WHERE gp.workspace_id = p_workspace_id AND gp.business_partner_id = p.id
          AND NOT gp.is_deleted AND gp.group_id = ANY(v_group_ids)
      ))
  )
  SELECT jsonb_build_object('name', COALESCE(BOOL_OR(name), false), 'phone', COALESCE(BOOL_OR(phone), false))
  INTO v_result FROM matches;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION crm.check_business_partner_duplicates(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.check_business_partner_duplicates(uuid, text, text, uuid) TO authenticated;
