CREATE TABLE IF NOT EXISTS payment_accounts.account_member_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES payment_accounts.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT payment_account_member_restrictions_account_user_unique UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS payment_account_member_restrictions_workspace_account
  ON payment_accounts.account_member_restrictions (workspace_id, account_id)
  WHERE NOT is_deleted;

CREATE INDEX IF NOT EXISTS payment_account_member_restrictions_workspace_user
  ON payment_accounts.account_member_restrictions (workspace_id, user_id)
  WHERE NOT is_deleted;

ALTER TABLE payment_accounts.account_member_restrictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_account_member_restrictions_workspace_access
  ON payment_accounts.account_member_restrictions
  FOR ALL TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND payment_accounts.module_allowed(workspace_id, 'payment_accounts')
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND payment_accounts.module_allowed(workspace_id, 'payment_accounts')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_accounts.account_member_restrictions TO authenticated, service_role;

COMMENT ON TABLE payment_accounts.account_member_restrictions IS
  'Application-level payment-account visibility preferences. Existing account RLS remains workspace-scoped and unchanged.';

NOTIFY pgrst, 'reload schema';
