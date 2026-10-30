ALTER TABLE clinics.clinical_presets
  DROP CONSTRAINT IF EXISTS clinical_presets_category_check,
  ADD CONSTRAINT clinical_presets_category_check CHECK (
    category IN (
      'reason_for_visit',
      'appointment_type',
      'registry_type',
      'beauty3_procedure'
    )
  );

ALTER TABLE clinics.beauty3_appointments
  ADD COLUMN IF NOT EXISTS procedure_type_other text NULL;

ALTER TABLE clinics.beauty3_appointments
  DROP CONSTRAINT IF EXISTS beauty3_appointments_procedure_type_other_check,
  ADD CONSTRAINT beauty3_appointments_procedure_type_other_check CHECK (
    procedure_type_other IS NULL OR length(trim(procedure_type_other)) > 0
  );
