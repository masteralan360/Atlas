CREATE OR REPLACE FUNCTION public.enforce_beauty3_appointment_procedure_available()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, clinics
AS $function$
DECLARE
  selected_preset_id uuid;
BEGIN
  IF NEW.is_deleted THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
    AND NEW.procedure_type IS NOT DISTINCT FROM OLD.procedure_type
    AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
  THEN
    RETURN NEW;
  END IF;

  IF NEW.procedure_type IS NULL
    OR NEW.procedure_type = 'other'
    OR left(NEW.procedure_type, 8) = 'builtin:'
  THEN
    RETURN NEW;
  END IF;

  SELECT preset.id
  INTO selected_preset_id
  FROM clinics.clinical_presets AS preset
  WHERE preset.workspace_id = NEW.workspace_id
    AND preset.category = 'beauty3_procedure'
    AND preset.name = NEW.procedure_type
    AND preset.is_active = true
    AND preset.is_deleted = false
  FOR SHARE;

  IF selected_preset_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'beauty3_procedure_unavailable';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS beauty3_appointment_procedure_available
  ON clinics.beauty3_appointments;
CREATE TRIGGER beauty3_appointment_procedure_available
  BEFORE INSERT OR UPDATE ON clinics.beauty3_appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_beauty3_appointment_procedure_available();

CREATE OR REPLACE FUNCTION public.prevent_deleting_used_beauty3_procedure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, clinics
AS $function$
DECLARE
  has_active_appointments boolean;
BEGIN
  IF OLD.category = 'beauty3_procedure'
    AND (
      TG_OP = 'DELETE'
      OR (OLD.is_deleted = false AND NEW.is_deleted = true)
    )
  THEN
    SELECT EXISTS (
      SELECT 1
      FROM clinics.beauty3_appointments AS appointment
      WHERE appointment.workspace_id = OLD.workspace_id
        AND appointment.procedure_type = OLD.name
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

DROP TRIGGER IF EXISTS prevent_deleting_used_beauty3_procedure
  ON clinics.clinical_presets;
CREATE TRIGGER prevent_deleting_used_beauty3_procedure
  BEFORE UPDATE OF is_deleted ON clinics.clinical_presets
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_deleting_used_beauty3_procedure();

DROP TRIGGER IF EXISTS prevent_hard_deleting_used_beauty3_procedure
  ON clinics.clinical_presets;
CREATE TRIGGER prevent_hard_deleting_used_beauty3_procedure
  BEFORE DELETE ON clinics.clinical_presets
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_deleting_used_beauty3_procedure();
