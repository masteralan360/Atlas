ALTER TABLE clinics.clinical_presets
  ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE clinics.clinical_presets
  DROP CONSTRAINT IF EXISTS clinical_presets_display_name_check,
  ADD CONSTRAINT clinical_presets_display_name_check
    CHECK (display_name IS NULL OR length(trim(display_name)) > 0);
