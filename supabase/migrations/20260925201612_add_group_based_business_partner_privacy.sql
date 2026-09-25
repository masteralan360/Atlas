-- Admin-granted, workspace-local business-partner visibility groups.
-- Visibility is applied by the Atlas client; RLS here only preserves workspace
-- isolation and restricts group administration to workspace administrators.

CREATE TABLE IF NOT EXISTS crm.business_partner_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  access_type text NOT NULL CHECK (access_type IN ('non_grouped', 'protected')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced',
  UNIQUE (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS crm.business_partner_group_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced',
  UNIQUE (workspace_id, group_id, user_id),
  FOREIGN KEY (group_id, workspace_id)
    REFERENCES crm.business_partner_groups(id, workspace_id) ON DELETE CASCADE
);

-- IDs are deterministic for (group, partner), allowing the client cache and
-- the insert trigger below to converge on the same relationship row.
CREATE TABLE IF NOT EXISTS crm.business_partner_group_partners (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  business_partner_id uuid NOT NULL REFERENCES crm.business_partners(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  sync_status text NOT NULL DEFAULT 'synced',
  UNIQUE (workspace_id, group_id, business_partner_id),
  FOREIGN KEY (group_id, workspace_id)
    REFERENCES crm.business_partner_groups(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_business_partner_groups_workspace_active
  ON crm.business_partner_groups (workspace_id, name)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_business_partner_group_users_workspace_user
  ON crm.business_partner_group_users (workspace_id, user_id)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_business_partner_group_partners_workspace_partner
  ON crm.business_partner_group_partners (workspace_id, business_partner_id)
  WHERE is_deleted = false;

-- Keep user and partner relationships inside the same workspace even when a
-- workspace administrator submits malformed IDs through a direct API request.
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
        AND profile.role IN ('staff', 'viewer')
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

DROP TRIGGER IF EXISTS validate_business_partner_group_users_workspace
  ON crm.business_partner_group_users;
CREATE TRIGGER validate_business_partner_group_users_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, group_id, user_id
  ON crm.business_partner_group_users
  FOR EACH ROW EXECUTE FUNCTION crm.validate_business_partner_group_relationship();

DROP TRIGGER IF EXISTS validate_business_partner_group_partners_workspace
  ON crm.business_partner_group_partners;
CREATE TRIGGER validate_business_partner_group_partners_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, group_id, business_partner_id
  ON crm.business_partner_group_partners
  FOR EACH ROW EXECUTE FUNCTION crm.validate_business_partner_group_relationship();

ALTER TABLE crm.business_partner_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.business_partner_group_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.business_partner_group_partners ENABLE ROW LEVEL SECURITY;

DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_partner_groups',
    'business_partner_group_users',
    'business_partner_group_partners'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON crm.%I', table_name || '_workspace_read', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON crm.%I FOR SELECT TO authenticated USING (
        workspace_id = public.current_workspace_id()
        AND COALESCE(public.workspace_get_override_value(workspace_id, ''capability'', ''businessPartnerGroupPrivacy''), ''revoke'') = ''grant''
      )',
      table_name || '_workspace_read', table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON crm.%I', table_name || '_admin_insert', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON crm.%I FOR INSERT TO authenticated WITH CHECK (
        workspace_id = public.current_workspace_id()
        AND public.current_user_role() = ''admin''
        AND COALESCE(public.workspace_get_override_value(workspace_id, ''capability'', ''businessPartnerGroupPrivacy''), ''revoke'') = ''grant''
      )',
      table_name || '_admin_insert', table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON crm.%I', table_name || '_admin_update', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON crm.%I FOR UPDATE TO authenticated USING (
        workspace_id = public.current_workspace_id()
        AND public.current_user_role() = ''admin''
        AND COALESCE(public.workspace_get_override_value(workspace_id, ''capability'', ''businessPartnerGroupPrivacy''), ''revoke'') = ''grant''
      ) WITH CHECK (
        workspace_id = public.current_workspace_id()
        AND public.current_user_role() = ''admin''
        AND COALESCE(public.workspace_get_override_value(workspace_id, ''capability'', ''businessPartnerGroupPrivacy''), ''revoke'') = ''grant''
      )',
      table_name || '_admin_update', table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON crm.%I', table_name || '_admin_delete', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON crm.%I FOR DELETE TO authenticated USING (
        workspace_id = public.current_workspace_id()
        AND public.current_user_role() = ''admin''
        AND COALESCE(public.workspace_get_override_value(workspace_id, ''capability'', ''businessPartnerGroupPrivacy''), ''revoke'') = ''grant''
      )',
      table_name || '_admin_delete', table_name
    );
  END LOOP;
END;
$policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON crm.business_partner_groups,
     crm.business_partner_group_users,
     crm.business_partner_group_partners
  TO authenticated, service_role;

-- New non-admin business partners inherit all of their active groups. The
-- client mirrors this locally for offline visibility; this trigger provides
-- the same assignment when the partner reaches Supabase.
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
    group_user.group_id,
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

REVOKE ALL ON FUNCTION crm.assign_new_business_partner_to_creator_groups() FROM PUBLIC;

DROP TRIGGER IF EXISTS assign_new_business_partner_to_creator_groups
  ON crm.business_partners;
CREATE TRIGGER assign_new_business_partner_to_creator_groups
  AFTER INSERT ON crm.business_partners
  FOR EACH ROW EXECUTE FUNCTION crm.assign_new_business_partner_to_creator_groups();

NOTIFY pgrst, 'reload schema';
