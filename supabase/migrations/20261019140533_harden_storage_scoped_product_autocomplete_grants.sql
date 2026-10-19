-- New functions inherit project default grants, which include anon.
REVOKE ALL ON FUNCTION public.search_products_for_autocomplete_in_storage(
  uuid, text, text, boolean, uuid[], uuid[], integer
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.search_products_for_autocomplete_in_storage(
  uuid, text, text, boolean, uuid[], uuid[], integer
) TO authenticated;
