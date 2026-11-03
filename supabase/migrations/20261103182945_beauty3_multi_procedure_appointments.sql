ALTER TABLE clinics.beauty3_appointments
  ADD COLUMN IF NOT EXISTS procedure_types text[] NOT NULL DEFAULT '{}'::text[];

UPDATE clinics.beauty3_appointments
SET procedure_types = ARRAY[procedure_type]
WHERE cardinality(procedure_types) = 0
  AND procedure_type IS NOT NULL
  AND length(trim(procedure_type)) > 0;

CREATE OR REPLACE FUNCTION public.enforce_beauty3_appointment_procedure_available()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, clinics
AS $function$
DECLARE
  selected_type text;
  selected_preset_id uuid;
  procedure_types_to_check text[];
BEGIN
  IF NEW.is_deleted THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
      AND NEW.procedure_type IS NOT DISTINCT FROM OLD.procedure_type
      AND NEW.procedure_types IS NOT DISTINCT FROM OLD.procedure_types
      AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
    THEN
      RETURN NEW;
    END IF;
  END IF;

  procedure_types_to_check := COALESCE(NEW.procedure_types, '{}'::text[]);
  IF NEW.procedure_type IS NOT NULL
    AND NOT (NEW.procedure_type = ANY(procedure_types_to_check))
  THEN
    procedure_types_to_check := array_prepend(NEW.procedure_type, procedure_types_to_check);
  END IF;

  FOREACH selected_type IN ARRAY procedure_types_to_check LOOP
    IF selected_type IS NULL OR length(trim(selected_type)) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'beauty3_procedure_unavailable';
    END IF;

    IF selected_type = 'other' OR left(selected_type, 8) = 'builtin:' THEN
      CONTINUE;
    END IF;

    SELECT preset.id
    INTO selected_preset_id
    FROM clinics.clinical_presets AS preset
    WHERE preset.workspace_id = NEW.workspace_id
      AND preset.category = 'beauty3_procedure'
      AND preset.name = selected_type
      AND preset.is_active = true
      AND preset.is_deleted = false
    FOR SHARE;

    IF selected_preset_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'beauty3_procedure_unavailable';
    END IF;
    selected_preset_id := NULL;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_deleting_used_beauty3_procedure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, clinics
AS $function$
DECLARE
  has_active_appointments boolean;
  should_check_usage boolean := false;
BEGIN
  IF OLD.category = 'beauty3_procedure' THEN
    IF TG_OP = 'DELETE' THEN
      should_check_usage := true;
    ELSIF OLD.is_deleted = false AND NEW.is_deleted = true THEN
      should_check_usage := true;
    END IF;
  END IF;

  IF should_check_usage THEN
    SELECT EXISTS (
      SELECT 1
      FROM clinics.beauty3_appointments AS appointment
      WHERE appointment.workspace_id = OLD.workspace_id
        AND (
          appointment.procedure_type = OLD.name
          OR OLD.name = ANY(COALESCE(appointment.procedure_types, '{}'::text[]))
        )
        AND appointment.is_deleted = false
    ) INTO has_active_appointments;

    IF has_active_appointments THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'beauty3_procedure_in_use';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
