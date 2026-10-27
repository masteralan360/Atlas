REVOKE EXECUTE ON FUNCTION public.consume_storefront_promo_code_order_submit()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_storefront_promo_code_order_submit()
  TO service_role;
