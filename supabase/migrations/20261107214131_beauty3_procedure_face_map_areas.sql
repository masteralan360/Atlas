ALTER TABLE clinics.clinical_presets
  ADD COLUMN IF NOT EXISTS face_map_areas jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE clinics.clinical_presets
  DROP CONSTRAINT IF EXISTS clinical_presets_face_map_areas_check,
  ADD CONSTRAINT clinical_presets_face_map_areas_check
    CHECK (jsonb_typeof(face_map_areas) = 'array');

UPDATE clinics.clinical_presets
SET face_map_areas = CASE name
  WHEN 'builtin:dermal_filler' THEN '["left_cheek", "right_cheek", "lips"]'::jsonb
  WHEN 'builtin:botox' THEN '["forehead", "glabella", "left_temple", "right_temple"]'::jsonb
  WHEN 'builtin:mesotherapy' THEN '["left_under_eye", "right_under_eye", "left_cheek", "right_cheek"]'::jsonb
  WHEN 'builtin:skin_treatment' THEN '["nose"]'::jsonb
  WHEN 'builtin:device_based_treatments' THEN '["left_jawline", "right_jawline"]'::jsonb
  WHEN 'builtin:plasma_treatment' THEN '["left_under_eye", "right_under_eye"]'::jsonb
  WHEN 'other' THEN '["neck"]'::jsonb
  ELSE face_map_areas
END
WHERE category = 'beauty3_procedure'
  AND face_map_areas = '[]'::jsonb
  AND name IN (
    'builtin:dermal_filler',
    'builtin:botox',
    'builtin:mesotherapy',
    'builtin:skin_treatment',
    'builtin:device_based_treatments',
    'builtin:plasma_treatment',
    'other'
  );
