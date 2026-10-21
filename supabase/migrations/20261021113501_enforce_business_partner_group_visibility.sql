-- Apply the same group rules at the authorization boundary used by directory
-- readers, account statements, linked records, and partner sync writes.
-- Users without active memberships retain access to non_grouped groups.
CREATE OR REPLACE FUNCTION crm.can_access_business_partner(
  p_workspace_id uuid,
  p_business_partner_id uuid,
  p_scope text DEFAULT 'customer'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND p_workspace_id = public.current_workspace_id()
    AND p_business_partner_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM crm.business_partners AS partner
      WHERE partner.id = p_business_partner_id
        AND partner.workspace_id = p_workspace_id
        AND COALESCE(partner.is_deleted, false) = false
        AND (COALESCE(p_scope, 'customer') <> 'supplier' OR partner.role <> 'customer')
        AND (
          public.current_user_role() = 'admin'
          OR COALESCE(public.workspace_get_override_value(
            p_workspace_id, 'capability', 'businessPartnerGroupPrivacy'
          ), 'revoke') <> 'grant'
          OR EXISTS (
            SELECT 1
            FROM crm.business_partner_group_partners AS assignment
            JOIN crm.business_partner_groups AS partner_group
              ON partner_group.id = assignment.group_id
             AND partner_group.workspace_id = assignment.workspace_id
            WHERE assignment.workspace_id = p_workspace_id
              AND assignment.business_partner_id = partner.id
              AND assignment.is_deleted = false
              AND partner_group.is_deleted = false
              AND (
                EXISTS (
                  SELECT 1
                  FROM crm.business_partner_group_users AS membership
                  WHERE membership.workspace_id = p_workspace_id
                    AND membership.group_id = partner_group.id
                    AND membership.user_id = auth.uid()
                    AND membership.is_deleted = false
                )
                OR (
                  partner_group.access_type = 'non_grouped'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM crm.business_partner_group_users AS any_membership
                    JOIN crm.business_partner_groups AS any_group
                      ON any_group.id = any_membership.group_id
                     AND any_group.workspace_id = any_membership.workspace_id
                    WHERE any_membership.workspace_id = p_workspace_id
                      AND any_membership.user_id = auth.uid()
                      AND any_membership.is_deleted = false
                      AND any_group.is_deleted = false
                  )
                )
              )
          )
        )
    );
$function$;

REVOKE ALL ON FUNCTION crm.can_access_business_partner(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.can_access_business_partner(uuid, uuid, text) TO authenticated, service_role;

-- The existing can_manage_business_partner helper delegates to can_access,
-- so sync_business_partner and the customer/supplier write policies now
-- reject attempts to modify partners outside the caller's permitted groups.
-- Keep direct reads protected too if table SELECT is granted in the future.
DROP POLICY IF EXISTS crm_business_partners_select ON crm.business_partners;
CREATE POLICY crm_business_partners_select
  ON crm.business_partners
  FOR SELECT TO authenticated
  USING (
    crm.can_access_business_partner(
      workspace_id, id, CASE WHEN role = 'supplier' THEN 'supplier' ELSE 'customer' END
    )
    AND (
      role <> 'agent'
      OR public.workspace_module_allowed(
        workspace_id,
        (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = business_partners.workspace_id),
        'agents'
      )
      OR delivery.module_allowed(workspace_id)
    )
  );

CREATE INDEX IF NOT EXISTS business_partner_group_partners_visibility_idx
  ON crm.business_partner_group_partners (workspace_id, business_partner_id, group_id)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS business_partner_group_users_visibility_idx
  ON crm.business_partner_group_users (workspace_id, user_id, group_id)
  WHERE is_deleted = false;

NOTIFY pgrst, 'reload schema';
