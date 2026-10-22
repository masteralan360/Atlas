-- Remove the legacy creator-only policy, which otherwise bypasses the
-- storage-aware products_select policy for products created by the user.
DROP POLICY IF EXISTS "Users can view own products" ON public.products;
