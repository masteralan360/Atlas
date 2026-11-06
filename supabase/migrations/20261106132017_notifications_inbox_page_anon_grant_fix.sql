REVOKE ALL ON FUNCTION public.list_notifications_inbox_page(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications_inbox_page(text, integer, integer) TO authenticated, service_role;
