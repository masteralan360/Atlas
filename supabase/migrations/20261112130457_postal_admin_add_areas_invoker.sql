GRANT INSERT ON public.postal_locations TO authenticated;

CREATE POLICY postal_locations_admin_insert
  ON public.postal_locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND public.current_user_role() = 'admin'
  );

ALTER FUNCTION public.postal_admin_add_area(text, text, text, text, text, text)
  SECURITY INVOKER;
