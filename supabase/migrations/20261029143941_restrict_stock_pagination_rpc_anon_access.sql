REVOKE ALL ON FUNCTION public.get_stock_adjustments_list_page(
  uuid, integer, integer, timestamptz, timestamptz, uuid, uuid, text, text, uuid[]
) FROM anon;

REVOKE ALL ON FUNCTION public.get_stock_batch_groups_page(
  uuid, integer, integer, text, uuid[]
) FROM anon;
