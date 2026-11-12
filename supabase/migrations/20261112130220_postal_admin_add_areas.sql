ALTER TABLE public.postal_locations
  ALTER COLUMN label_en DROP NOT NULL,
  ALTER COLUMN label_ar DROP NOT NULL,
  ALTER COLUMN label_ku DROP NOT NULL,
  ADD CONSTRAINT postal_locations_at_least_one_label
    CHECK (
      COALESCE(label_en ~ '[^[:space:]]', false)
      OR COALESCE(label_ar ~ '[^[:space:]]', false)
      OR COALESCE(label_ku ~ '[^[:space:]]', false)
    );

CREATE FUNCTION public.postal_admin_add_area(
  p_governorate text,
  p_area text,
  p_label_en text DEFAULT NULL,
  p_label_ar text DEFAULT NULL,
  p_label_ku text DEFAULT NULL,
  p_tariff_zone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_governorate text := btrim(COALESCE(p_governorate, ''));
  v_area text := btrim(COALESCE(p_area, ''));
  v_label_en text := NULLIF(regexp_replace(COALESCE(p_label_en, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_label_ar text := NULLIF(regexp_replace(COALESCE(p_label_ar, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_label_ku text := NULLIF(regexp_replace(COALESCE(p_label_ku, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_profile text;
  v_tariff_zone text;
  v_display_order integer;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'postal_admin_required' USING ERRCODE = '42501';
  END IF;

  IF v_governorate = ''
    OR v_area !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    OR length(v_area) > 120
    OR (v_label_en IS NULL AND v_label_ar IS NULL AND v_label_ku IS NULL)
    OR length(v_label_en) > 120
    OR length(v_label_ar) > 120
    OR length(v_label_ku) > 120 THEN
    RAISE EXCEPTION 'postal_invalid_area' USING ERRCODE = '22023';
  END IF;

  SELECT tariff_profile
    INTO v_profile
  FROM public.postal_governorates
  WHERE id = v_governorate;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'postal_invalid_governorate' USING ERRCODE = '22023';
  END IF;

  IF v_profile = 'northern' THEN
    IF p_tariff_zone IS DISTINCT FROM 'center'
      AND p_tariff_zone IS DISTINCT FROM 'outside' THEN
      RAISE EXCEPTION 'postal_invalid_tariff_zone' USING ERRCODE = '22023';
    END IF;
    v_tariff_zone := p_tariff_zone;
  ELSE
    v_tariff_zone := NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.postal_locations
    WHERE governorate = v_governorate AND area = v_area
  ) THEN
    RAISE EXCEPTION 'postal_area_exists' USING ERRCODE = '23505';
  END IF;

  SELECT COALESCE(MAX(display_order), 0) + 1
    INTO v_display_order
  FROM public.postal_locations
  WHERE governorate = v_governorate;

  INSERT INTO public.postal_locations (
    governorate,
    area,
    label_en,
    label_ar,
    label_ku,
    display_order,
    is_active,
    tariff_zone
  )
  VALUES (
    v_governorate,
    v_area,
    v_label_en,
    v_label_ar,
    v_label_ku,
    v_display_order,
    true,
    v_tariff_zone
  )
  RETURNING to_jsonb(postal_locations.*) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.postal_admin_add_area(text, text, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postal_admin_add_area(text, text, text, text, text, text)
  TO authenticated, service_role;
