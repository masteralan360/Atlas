-- Booking numbers were generated from each device's local cache, so separate
-- devices could enqueue the same workspace number. Validate standard Travel
-- & Transportation numbers atomically on the server, and replace only a
-- conflicting number with the next free workspace number.
CREATE OR REPLACE FUNCTION travel_transportation.assign_booking_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, travel_transportation
AS $function$
DECLARE
  v_year integer;
  v_next_sequence bigint;
  v_existing_number text;
  v_requested_number text := NULLIF(BTRIM(COALESCE(NEW.booking_number, '')), '');
BEGIN
  -- PostgREST upserts run BEFORE INSERT triggers even when they resolve to an
  -- existing id. Preserve the authoritative number for ordinary edits.
  SELECT existing.booking_number
  INTO v_existing_number
  FROM travel_transportation.travel_bookings AS existing
  WHERE existing.id = NEW.id;

  IF v_existing_number IS NOT NULL THEN
    NEW.booking_number := v_existing_number;
    RETURN NEW;
  END IF;

  v_year := EXTRACT(YEAR FROM (COALESCE(NEW.created_at, now()) AT TIME ZONE 'UTC'))::integer;

  -- Preserve unique explicit nonstandard references. A duplicate nonstandard
  -- reference falls through to a standard number instead of blocking sync.
  IF v_requested_number IS NOT NULL
    AND v_requested_number !~ '^TT-[0-9]{4}-[0-9]+$'
    AND v_requested_number !~ '^TT-PENDING-[A-Z0-9-]+$'
  THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        format('travel_transportation.travel_bookings:%s:%s', NEW.workspace_id, v_requested_number),
        0
      )
    );

    IF NOT EXISTS (
      SELECT 1
      FROM travel_transportation.travel_bookings AS existing
      WHERE existing.workspace_id = NEW.workspace_id
        AND existing.booking_number = v_requested_number
    ) THEN
      NEW.booking_number := v_requested_number;
      RETURN NEW;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      format('travel_transportation.travel_bookings:%s:%s', NEW.workspace_id, v_year),
      0
    )
  );

  -- Keep a locally generated number when it is still available. The lock
  -- makes this check atomic across devices creating bookings concurrently.
  IF v_requested_number ~ format('^TT-%s-[0-9]+$', v_year)
    AND NOT EXISTS (
      SELECT 1
      FROM travel_transportation.travel_bookings AS existing
      WHERE existing.workspace_id = NEW.workspace_id
        AND existing.booking_number = v_requested_number
    )
  THEN
    NEW.booking_number := v_requested_number;
    RETURN NEW;
  END IF;

  SELECT COALESCE(
    MAX(((regexp_match(booking_number, format('^TT-%s-([0-9]+)$', v_year)))[1])::bigint),
    0
  ) + 1
  INTO v_next_sequence
  FROM travel_transportation.travel_bookings
  WHERE workspace_id = NEW.workspace_id
    AND booking_number ~ format('^TT-%s-[0-9]+$', v_year);

  NEW.booking_number := format(
    'TT-%s-%s',
    v_year,
    LPAD(v_next_sequence::text, GREATEST(5, length(v_next_sequence::text)), '0')
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION travel_transportation.assign_booking_number() FROM PUBLIC;
REVOKE ALL ON FUNCTION travel_transportation.assign_booking_number() FROM anon, authenticated;

DROP TRIGGER IF EXISTS assign_travel_booking_number_on_insert
  ON travel_transportation.travel_bookings;
CREATE TRIGGER assign_travel_booking_number_on_insert
  BEFORE INSERT ON travel_transportation.travel_bookings
  FOR EACH ROW
  EXECUTE FUNCTION travel_transportation.assign_booking_number();

NOTIFY pgrst, 'reload schema';
