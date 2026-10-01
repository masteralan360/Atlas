ALTER TABLE travel_transportation.travel_passengers
  ADD COLUMN IF NOT EXISTS phone_number text NULL;

NOTIFY pgrst, 'reload schema';
