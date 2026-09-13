-- Keep the public API wrapper invoker-rights. The private implementation owns
-- the privileged transaction and performs all actor/workspace/role checks.

ALTER FUNCTION public.receive_purchase_order(uuid, text, jsonb)
  SECURITY INVOKER;

REVOKE ALL ON FUNCTION private.receive_purchase_order(uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.receive_purchase_order(uuid, text, jsonb)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.receive_purchase_order(uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(uuid, text, jsonb)
  TO authenticated, service_role;
