ALTER TABLE crm.business_partner_group_users
  ADD COLUMN IF NOT EXISTS auto_assign_on_create boolean NOT NULL DEFAULT true;

-- Preserve group membership for visibility while letting admins opt users out
-- of automatically placing newly-created partners in each membership group.
CREATE OR REPLACE FUNCTION crm.assign_new_business_partner_to_creator_groups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR public.current_user_role() = 'admin' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(
    public.workspace_get_override_value(NEW.workspace_id, 'capability', 'businessPartnerGroupPrivacy'),
    'revoke'
  ) <> 'grant' THEN
    RETURN NEW;
  END IF;

  INSERT INTO crm.business_partner_group_partners (
    id,
    workspace_id,
    group_id,
    business_partner_id,
    created_at,
    updated_at,
    version,
    is_deleted,
    sync_status
  )
  SELECT
    partner_group.id::text || ':' || NEW.id::text,
    NEW.workspace_id,
    partner_group.id,
    NEW.id,
    NEW.created_at,
    NEW.created_at,
    1,
    false,
    'synced'
  FROM crm.business_partner_groups AS partner_group
  LEFT JOIN crm.business_partner_group_users AS group_user
    ON group_user.group_id = partner_group.id
   AND group_user.workspace_id = partner_group.workspace_id
   AND group_user.user_id = auth.uid()
   AND group_user.is_deleted = false
   AND group_user.auto_assign_on_create = true
  WHERE partner_group.workspace_id = NEW.workspace_id
    AND partner_group.is_deleted = false
    AND (
      group_user.user_id IS NOT NULL
      OR (
        partner_group.access_type = 'non_grouped'
        AND NOT EXISTS (
          SELECT 1
          FROM crm.business_partner_group_users AS any_group_user
          JOIN crm.business_partner_groups AS any_group
            ON any_group.id = any_group_user.group_id
           AND any_group.workspace_id = any_group_user.workspace_id
          WHERE any_group_user.workspace_id = NEW.workspace_id
            AND any_group_user.user_id = auth.uid()
            AND any_group_user.is_deleted = false
            AND any_group.is_deleted = false
        )
      )
    )
  ON CONFLICT (workspace_id, group_id, business_partner_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
