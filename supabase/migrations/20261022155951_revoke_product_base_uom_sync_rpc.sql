-- The base-UoM synchronizer is a trigger function, not a client RPC.
-- Its trigger already exists and runs as the owner; remove API-role execute grants.
REVOKE EXECUTE ON FUNCTION public.sync_product_base_uom()
  FROM PUBLIC, anon, authenticated, service_role;
