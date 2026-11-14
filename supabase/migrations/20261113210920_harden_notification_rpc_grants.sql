REVOKE ALL ON FUNCTION public.upsert_notification_inbox(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_notification_inbox(
  uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.get_pending_push_notification_targets(integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notification_targets(integer, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.mark_notification_inbox_read(uuid, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_inbox_read(uuid, boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.mark_notification_inbox_archived(uuid, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_inbox_archived(uuid, boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.mark_all_notifications_inbox_read()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_inbox_read()
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.list_notifications_inbox(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications_inbox(integer)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.list_notifications_inbox_page(text, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_notifications_inbox_page(text, integer, integer)
  TO authenticated, service_role;
