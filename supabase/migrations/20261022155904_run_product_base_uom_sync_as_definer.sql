-- The products RLS policy can hide a product from the caller while its AFTER trigger
-- maintains the corresponding base UoM. Run this trusted trigger function as its
-- postgres owner so its nested UoM validator can verify the newly written parent.
-- The function already pins an empty search_path and schema-qualifies its objects.
ALTER FUNCTION public.sync_product_base_uom() SECURITY DEFINER;
