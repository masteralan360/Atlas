-- These legacy helpers are implementation details. They continue to run from
-- their trigger/security-definer owners, but must not be callable over PostgREST.

REVOKE ALL ON FUNCTION public.cancel_pos_loan_after_full_sale_return()
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_order_financing_loan(
  uuid, text, uuid, text, uuid, text, text, numeric, text, jsonb,
  integer, text, date, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_order_financing_loan(
  uuid, text, uuid, text, uuid, text, text, numeric, text, jsonb,
  integer, text, date, uuid
) TO service_role;

NOTIFY pgrst, 'reload schema';
