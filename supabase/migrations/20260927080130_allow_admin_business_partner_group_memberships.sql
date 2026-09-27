-- Admins may be group members for creator auto-assignment, but membership
-- remains limited to users whose profile resolves to the group's workspace.
CREATE OR REPLACE FUNCTION crm.validate_business_partner_group_relationship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'business_partner_group_users' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.profiles AS profile
      WHERE profile.id = NEW.user_id
        AND profile.role IN ('staff', 'viewer', 'admin')
        AND (
          profile.workspace_id = NEW.workspace_id
          OR profile.current_workspace = NEW.workspace_id
          OR EXISTS (
            SELECT 1
            FROM public.workspace_branches AS branch
            WHERE branch.source_workspace_id = profile.workspace_id
              AND branch.branch_workspace_id = NEW.workspace_id
          )
        )
    ) THEN
      RAISE EXCEPTION 'Group users must belong to the same workspace'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'business_partner_group_partners' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM crm.business_partners AS partner
      WHERE partner.id = NEW.business_partner_id
        AND partner.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'Group partners must belong to the same workspace'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION crm.validate_business_partner_group_relationship() FROM PUBLIC;
