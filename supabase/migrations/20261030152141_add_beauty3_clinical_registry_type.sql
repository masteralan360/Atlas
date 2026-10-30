ALTER TABLE clinics.clinical_presets
  DROP CONSTRAINT IF EXISTS clinical_presets_registry_type_name_check,
  ADD CONSTRAINT clinical_presets_registry_type_name_check CHECK (
    category <> 'registry_type' OR name IN ('medical', 'beauty', 'beauty2', 'beauty3')
  );
