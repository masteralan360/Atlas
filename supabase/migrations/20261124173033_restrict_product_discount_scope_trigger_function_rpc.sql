-- Trigger functions execute through their attached trigger, so API roles do not
-- need direct EXECUTE permission for this SECURITY DEFINER function.
REVOKE ALL ON FUNCTION public.enforce_product_discount_scope_separation()
  FROM PUBLIC, anon, authenticated, service_role;
