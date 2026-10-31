ALTER TABLE public.postal_shipments
  DROP CONSTRAINT IF EXISTS postal_shipments_backup_phone_check;

ALTER TABLE public.postal_shipments
  ADD CONSTRAINT postal_shipments_backup_phone_check
  CHECK (
    backup_phone = ''
    OR backup_phone ~ '^(07[0-9]{9}|7[0-9]{9}|9647[0-9]{9}|009647[0-9]{9})$'
  );
