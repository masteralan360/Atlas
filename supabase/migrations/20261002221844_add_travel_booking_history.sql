ALTER TABLE travel_transportation.travel_bookings
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS travel_bookings_workspace_archive_idx
  ON travel_transportation.travel_bookings (workspace_id, is_archived, created_at DESC)
  WHERE is_deleted = false;

NOTIFY pgrst, 'reload schema';
