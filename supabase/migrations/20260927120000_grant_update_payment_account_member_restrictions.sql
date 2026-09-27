-- The sync client writes restrictions with upsert(), which needs UPDATE
-- privilege for PostgreSQL's conflict handling, including retried writes.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON payment_accounts.account_member_restrictions
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
