CREATE TABLE public.postal_governorates (
  id text PRIMARY KEY,
  label_en text NOT NULL CHECK (btrim(label_en) <> ''),
  label_ar text NOT NULL CHECK (btrim(label_ar) <> ''),
  label_ku text NOT NULL CHECK (btrim(label_ku) <> ''),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  tariff_profile text NOT NULL CHECK (tariff_profile IN ('standard','northern')),
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.postal_locations
  ADD COLUMN label_en text,
  ADD COLUMN label_ar text,
  ADD COLUMN label_ku text,
  ADD COLUMN display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN tariff_zone text CHECK (tariff_zone IS NULL OR tariff_zone IN ('center','outside'));

INSERT INTO public.postal_governorates
  (id, label_en, label_ar, label_ku, display_order, tariff_profile, is_active)
VALUES
  ('baghdad', 'Baghdad', 'بغداد', 'بەغدا', 1, 'standard', true),
  ('basra', 'Basra', 'البصرة', 'بەسرە', 2, 'standard', true),
  ('nineveh', 'Nineveh', 'نينوى', 'نەینەوا', 3, 'standard', true),
  ('erbil', 'Erbil', 'أربيل', 'هەولێر', 4, 'northern', true),
  ('sulaymaniyah', 'Sulaymaniyah', 'السليمانية', 'سلێمانی', 5, 'northern', true),
  ('duhok', 'Duhok', 'دهوك', 'دهۆک', 6, 'northern', true),
  ('halabja', 'Halabja', 'حلبجة', 'هەڵەبجە', 7, 'standard', true),
  ('kirkuk', 'Kirkuk', 'كركوك', 'کەرکووک', 8, 'standard', true),
  ('anbar', 'Anbar', 'الأنبار', 'ئەنبار', 9, 'standard', true),
  ('babil', 'Babil', 'بابل', 'بابل', 10, 'standard', true),
  ('karbala', 'Karbala', 'كربلاء', 'کەربەلا', 11, 'standard', true),
  ('najaf', 'Najaf', 'النجف', 'نەجەف', 12, 'standard', true),
  ('qadisiyah', 'Qadisiyah', 'القادسية', 'قادسیە', 13, 'standard', true),
  ('muthanna', 'Muthanna', 'المثنى', 'موسەنا', 14, 'standard', true),
  ('dhi-qar', 'Dhi Qar', 'ذي قار', 'زیقار', 15, 'standard', true),
  ('maysan', 'Maysan', 'ميسان', 'مەیسان', 16, 'standard', true),
  ('wasit', 'Wasit', 'واسط', 'واست', 17, 'standard', true),
  ('diyala', 'Diyala', 'ديالى', 'دیالە', 18, 'standard', true),
  ('salah-al-din', 'Salah Al Din', 'صلاح الدين', 'سەلاحەدین', 19, 'standard', true)
ON CONFLICT (id) DO UPDATE SET
  label_en = EXCLUDED.label_en,
  label_ar = EXCLUDED.label_ar,
  label_ku = EXCLUDED.label_ku,
  display_order = EXCLUDED.display_order,
  tariff_profile = EXCLUDED.tariff_profile;

INSERT INTO public.postal_locations
  (governorate, area, label_en, label_ar, label_ku, display_order, is_active, tariff_zone)
VALUES
  ('baghdad', 'karrada', 'Karrada', 'الكرادة', 'کەڕادە', 1, true, NULL),
  ('baghdad', 'mansour', 'Mansour', 'المنصور', 'مەنسوور', 2, true, NULL),
  ('baghdad', 'adhamiya', 'Adhamiya', 'الأعظمية', 'ئەعزەمیە', 3, true, NULL),
  ('baghdad', 'kadhimiya', 'Kadhimiya', 'الكاظمية', 'کازمیە', 4, true, NULL),
  ('baghdad', 'sadr-city', 'Sadr City', 'مدينة الصدر', 'شاری سەدر', 5, true, NULL),
  ('baghdad', 'rusafa', 'Rusafa', 'الرصافة', 'ڕوسافە', 6, true, NULL),
  ('baghdad', 'karkh', 'Karkh', 'الكرخ', 'کەرخ', 7, true, NULL),
  ('basra', 'basra-centre', 'Basra Centre', 'مركز البصرة', 'ناوەندی بەسرە', 1, true, NULL),
  ('basra', 'zubair', 'Zubair', 'الزبير', 'زوبێر', 2, true, NULL),
  ('basra', 'abu-al-khasib', 'Abu Al Khasib', 'أبو الخصيب', 'ئەبو خەسیب', 3, true, NULL),
  ('basra', 'qurna', 'Qurna', 'القرنة', 'قوڕنە', 4, true, NULL),
  ('nineveh', 'mosul', 'Mosul', 'الموصل', 'مووسڵ', 1, true, NULL),
  ('nineveh', 'tal-afar', 'Tal Afar', 'تلعفر', 'تەلعەفەر', 2, true, NULL),
  ('nineveh', 'hamdaniya', 'Hamdaniya', 'الحمدانية', 'حەمدانیە', 3, true, NULL),
  ('nineveh', 'sinjar', 'Sinjar', 'سنجار', 'شنگال', 4, true, NULL),
  ('erbil', 'erbil-centre', 'Erbil Centre', 'مركز أربيل', 'ناوەندی هەولێر', 1, true, 'center'),
  ('erbil', 'ankawa', 'Ankawa', 'عنكاوا', 'عەنکاوە', 2, true, 'outside'),
  ('erbil', 'soran', 'Soran', 'سوران', 'سۆران', 3, true, 'outside'),
  ('erbil', 'shaqlawa', 'Shaqlawa', 'شقلاوة', 'شەقڵاوە', 4, true, 'outside'),
  ('erbil', 'koya', 'Koya', 'كويسنجق', 'کۆیە', 5, true, 'outside'),
  ('sulaymaniyah', 'sulaymaniyah-centre', 'Sulaymaniyah Centre', 'مركز السليمانية', 'ناوەندی سلێمانی', 1, true, 'center'),
  ('sulaymaniyah', 'chamchamal', 'Chamchamal', 'جمجمال', 'چەمچەماڵ', 2, true, 'outside'),
  ('sulaymaniyah', 'ranya', 'Ranya', 'رانية', 'ڕانیە', 3, true, 'outside'),
  ('sulaymaniyah', 'dukan', 'Dukan', 'دوكان', 'دووکان', 4, true, 'outside'),
  ('sulaymaniyah', 'penjwen', 'Penjwen', 'بنجوين', 'پێنجوێن', 5, true, 'outside'),
  ('sulaymaniyah', 'kalar', 'Kalar', 'كلار', 'کەلار', 6, true, 'outside'),
  ('duhok', 'duhok-centre', 'Duhok Centre', 'مركز دهوك', 'ناوەندی دهۆک', 1, true, 'center'),
  ('duhok', 'zakho', 'Zakho', 'زاخو', 'زاخۆ', 2, true, 'outside'),
  ('duhok', 'akre', 'Akre', 'عقرة', 'ئاکرێ', 3, true, 'outside'),
  ('duhok', 'sumel', 'Sumel', 'سميل', 'سمێل', 4, true, 'outside'),
  ('duhok', 'amadiya', 'Amadiya', 'العمادية', 'ئامێدی', 5, true, 'outside'),
  ('halabja', 'halabja-centre', 'Halabja Centre', 'مركز حلبجة', 'ناوەندی هەڵەبجە', 1, true, NULL),
  ('halabja', 'khurmal', 'Khurmal', 'خورمال', 'خورماڵ', 2, true, NULL),
  ('halabja', 'sirwan', 'Sirwan', 'سيروان', 'سیروان', 3, true, NULL),
  ('halabja', 'byara', 'Byara', 'بيارة', 'بیارە', 4, true, NULL),
  ('kirkuk', 'kirkuk-centre', 'Kirkuk Centre', 'مركز كركوك', 'ناوەندی کەرکووک', 1, true, NULL),
  ('kirkuk', 'hawija', 'Hawija', 'الحويجة', 'حەویجە', 2, true, NULL),
  ('kirkuk', 'daquq', 'Daquq', 'داقوق', 'داقووق', 3, true, NULL),
  ('kirkuk', 'dibis', 'Dibis', 'الدبس', 'دووبز', 4, true, NULL),
  ('anbar', 'ramadi', 'Ramadi', 'الرمادي', 'ڕەمادی', 1, true, NULL),
  ('anbar', 'fallujah', 'Fallujah', 'الفلوجة', 'فەلوجە', 2, true, NULL),
  ('anbar', 'hit', 'Hit', 'هيت', 'هیت', 3, true, NULL),
  ('anbar', 'haditha', 'Haditha', 'حديثة', 'حەدیسە', 4, true, NULL),
  ('anbar', 'qaim', 'Al Qaim', 'القائم', 'قائم', 5, true, NULL),
  ('babil', 'hillah', 'Hillah', 'الحلة', 'حیلە', 1, true, NULL),
  ('babil', 'musayyib', 'Musayyib', 'المسيب', 'موسەیەب', 2, true, NULL),
  ('babil', 'hashimiya', 'Hashimiya', 'الهاشمية', 'هاشمیە', 3, true, NULL),
  ('babil', 'mahawil', 'Mahawil', 'المحاويل', 'مەحاویل', 4, true, NULL),
  ('karbala', 'karbala-centre', 'Karbala Centre', 'مركز كربلاء', 'ناوەندی کەربەلا', 1, true, NULL),
  ('karbala', 'hindiya', 'Hindiya', 'الهندية', 'هیندیە', 2, true, NULL),
  ('karbala', 'ain-al-tamur', 'Ain Al Tamur', 'عين التمر', 'عەین تەمر', 3, true, NULL),
  ('najaf', 'najaf-centre', 'Najaf Centre', 'مركز النجف', 'ناوەندی نەجەف', 1, true, NULL),
  ('najaf', 'kufa', 'Kufa', 'الكوفة', 'کوفە', 2, true, NULL),
  ('najaf', 'manathera', 'Manathera', 'المناذرة', 'مەناذرە', 3, true, NULL),
  ('najaf', 'mishkhab', 'Mishkhab', 'المشخاب', 'میشخاب', 4, true, NULL),
  ('qadisiyah', 'diwaniyah', 'Diwaniyah', 'الديوانية', 'دیوانیە', 1, true, NULL),
  ('qadisiyah', 'shamiya', 'Shamiya', 'الشامية', 'شامیە', 2, true, NULL),
  ('qadisiyah', 'afak', 'Afak', 'عفك', 'عەفەک', 3, true, NULL),
  ('qadisiyah', 'hamza', 'Hamza', 'الحمزة', 'حەمزە', 4, true, NULL),
  ('muthanna', 'samawah', 'Samawah', 'السماوة', 'سەماوە', 1, true, NULL),
  ('muthanna', 'rumaitha', 'Rumaitha', 'الرميثة', 'ڕومەیسە', 2, true, NULL),
  ('muthanna', 'khidr', 'Khidr', 'الخضر', 'خدر', 3, true, NULL),
  ('muthanna', 'salman', 'Salman', 'السلمان', 'سەلمان', 4, true, NULL),
  ('dhi-qar', 'nasiriyah', 'Nasiriyah', 'الناصرية', 'ناسریە', 1, true, NULL),
  ('dhi-qar', 'shatra', 'Shatra', 'الشطرة', 'شەترە', 2, true, NULL),
  ('dhi-qar', 'rifai', 'Rifai', 'الرفاعي', 'ڕیفاعی', 3, true, NULL),
  ('dhi-qar', 'suq-al-shuyukh', 'Suq Al Shuyukh', 'سوق الشيوخ', 'سوق شیوخ', 4, true, NULL),
  ('maysan', 'amarah', 'Amarah', 'العمارة', 'عەمارە', 1, true, NULL),
  ('maysan', 'majar-al-kabir', 'Majar Al Kabir', 'المجر الكبير', 'مەجەری گەورە', 2, true, NULL),
  ('maysan', 'qalaat-saleh', 'Qalaat Saleh', 'قلعة صالح', 'قەڵای ساڵح', 3, true, NULL),
  ('maysan', 'ali-al-gharbi', 'Ali Al Gharbi', 'علي الغربي', 'عەلی غەربی', 4, true, NULL),
  ('wasit', 'kut', 'Kut', 'الكوت', 'کوت', 1, true, NULL),
  ('wasit', 'hay', 'Al Hay', 'الحي', 'حەی', 2, true, NULL),
  ('wasit', 'suwayra', 'Suwayra', 'الصويرة', 'سوەیرە', 3, true, NULL),
  ('wasit', 'aziziya', 'Aziziya', 'العزيزية', 'عەزیزیە', 4, true, NULL),
  ('wasit', 'badra', 'Badra', 'بدرة', 'بەدرە', 5, true, NULL),
  ('diyala', 'baqubah', 'Baqubah', 'بعقوبة', 'بەعقوبە', 1, true, NULL),
  ('diyala', 'muqdadiya', 'Muqdadiya', 'المقدادية', 'میقدادیە', 2, true, NULL),
  ('diyala', 'khanaqin', 'Khanaqin', 'خانقين', 'خانەقین', 3, true, NULL),
  ('diyala', 'khalis', 'Khalis', 'الخالص', 'خالص', 4, true, NULL),
  ('diyala', 'balad-ruz', 'Balad Ruz', 'بلدروز', 'بەلەدڕوز', 5, true, NULL),
  ('salah-al-din', 'tikrit', 'Tikrit', 'تكريت', 'تکریت', 1, true, NULL),
  ('salah-al-din', 'samarra', 'Samarra', 'سامراء', 'سامەڕا', 2, true, NULL),
  ('salah-al-din', 'balad', 'Balad', 'بلد', 'بەلەد', 3, true, NULL),
  ('salah-al-din', 'baiji', 'Baiji', 'بيجي', 'بەیجی', 4, true, NULL),
  ('salah-al-din', 'tuz', 'Tuz Khurmatu', 'طوزخورماتو', 'دووزخورماتو', 5, true, NULL)
ON CONFLICT (governorate, area) DO UPDATE SET
  label_en = EXCLUDED.label_en,
  label_ar = EXCLUDED.label_ar,
  label_ku = EXCLUDED.label_ku,
  display_order = EXCLUDED.display_order,
  tariff_zone = EXCLUDED.tariff_zone;

ALTER TABLE public.postal_locations
  ALTER COLUMN label_en SET NOT NULL,
  ALTER COLUMN label_ar SET NOT NULL,
  ALTER COLUMN label_ku SET NOT NULL,
  ADD CONSTRAINT postal_locations_governorate_catalog_fk
    FOREIGN KEY (governorate) REFERENCES public.postal_governorates(id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION postal_private.validate_postal_area_catalog()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_profile text;
BEGIN
  SELECT tariff_profile INTO v_profile
  FROM public.postal_governorates
  WHERE id = NEW.governorate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'postal_invalid_governorate' USING ERRCODE = '22023';
  END IF;
  IF (v_profile = 'northern' AND (NEW.tariff_zone IS NULL OR NEW.tariff_zone NOT IN ('center','outside')))
    OR (v_profile = 'standard' AND NEW.tariff_zone IS NOT NULL) THEN
    RAISE EXCEPTION 'postal_invalid_tariff_zone' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION postal_private.validate_postal_area_catalog() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER postal_locations_valid_catalog
  BEFORE INSERT OR UPDATE ON public.postal_locations
  FOR EACH ROW EXECUTE FUNCTION postal_private.validate_postal_area_catalog();

CREATE TABLE public.postal_shipment_tariffs (
  tariff_profile text NOT NULL CHECK (tariff_profile IN ('standard','northern')),
  shipment_size text NOT NULL CHECK (shipment_size IN ('carton','ship','small_package')),
  tariff_zone text NOT NULL CHECK (tariff_zone IN ('standard','center','outside')),
  fee bigint NOT NULL CHECK (fee > 0 AND fee <= 999999999999),
  label_key text NOT NULL CHECK (label_key ~ '^[a-z0-9_]+$'),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tariff_profile, shipment_size, tariff_zone, fee),
  CHECK (
    (tariff_profile = 'northern' AND shipment_size = 'small_package' AND tariff_zone IN ('center','outside'))
    OR (tariff_profile = 'standard' AND shipment_size IN ('carton','ship') AND tariff_zone = 'standard')
  )
);

INSERT INTO public.postal_shipment_tariffs
  (tariff_profile, shipment_size, tariff_zone, fee, label_key, display_order, is_active)
VALUES
  ('northern','small_package','center',5000,'small_package',1,true),
  ('northern','small_package','outside',6000,'small_package',2,true),
  ('standard','carton','standard',8000,'carton_8000',1,true),
  ('standard','carton','standard',12000,'carton_12000',2,true),
  ('standard','carton','standard',15000,'carton_15000',3,true),
  ('standard','carton','standard',20000,'carton_20000',4,true),
  ('standard','ship','standard',15000,'ship_15000',5,true),
  ('standard','ship','standard',24000,'ship_24000',6,true),
  ('standard','ship','standard',35000,'ship_35000',7,true),
  ('standard','ship','standard',55000,'ship_55000',8,true);

ALTER TABLE public.postal_governorates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_governorates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.postal_governorates TO authenticated;
GRANT ALL ON public.postal_governorates TO service_role;
CREATE POLICY postal_governorates_read ON public.postal_governorates
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

ALTER TABLE public.postal_shipment_tariffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_shipment_tariffs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.postal_shipment_tariffs TO authenticated;
GRANT ALL ON public.postal_shipment_tariffs TO service_role;
CREATE POLICY postal_shipment_tariffs_read ON public.postal_shipment_tariffs
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DO $$
DECLARE
  v_table text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_table IN ARRAY ARRAY['postal_governorates','postal_locations','postal_shipment_tariffs'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = v_table
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
      END IF;
    END LOOP;
  END IF;
END;
$$;

CREATE TABLE public.postal_location_admin_audit (
  id uuid PRIMARY KEY,
  actor_id uuid,
  action text NOT NULL CHECK (action IN ('save_governorate','save_area','save_tariff')),
  entity_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.postal_location_admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_location_admin_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.postal_location_admin_audit TO service_role;

CREATE OR REPLACE FUNCTION postal_private.guard_active_location()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_available boolean;
BEGIN
  IF TG_OP = 'UPDATE'
    AND ROW(NEW.governorate, NEW.area) IS NOT DISTINCT FROM ROW(OLD.governorate, OLD.area) THEN
    RETURN NEW;
  END IF;

  SELECT g.is_active AND (NEW.area IS NULL OR COALESCE(l.is_active, false))
    INTO v_available
  FROM public.postal_governorates g
  LEFT JOIN public.postal_locations l
    ON l.governorate = g.id AND l.area = NEW.area
  WHERE g.id = NEW.governorate;

  IF COALESCE(v_available, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'postal_location_unavailable' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION postal_private.guard_active_location() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER postal_shipments_active_location_guard
  BEFORE INSERT OR UPDATE ON public.postal_shipments
  FOR EACH ROW EXECUTE FUNCTION postal_private.guard_active_location();
CREATE TRIGGER postal_branches_active_location_guard
  BEFORE INSERT OR UPDATE ON public.postal_branches
  FOR EACH ROW EXECUTE FUNCTION postal_private.guard_active_location();

CREATE OR REPLACE FUNCTION postal_private.apply_intake_tariff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
  v_size text;
  v_fee_text text;
  v_addon_text text;
  v_fee bigint;
  v_addon bigint;
  v_total bigint;
  v_zone text;
  v_profile text;
  v_area_zone text;
BEGIN
  IF OLD.state = 'draft' AND NEW.state IN ('draft','received')
    AND current_setting('postal.tariff_authorized', true) = 'true' THEN
    v_size := NULLIF(current_setting('postal.tariff_size', true), '');
    v_fee_text := NULLIF(current_setting('postal.tariff_fee', true), '');
    v_addon_text := NULLIF(current_setting('postal.tariff_fee_addon', true), '');

    IF v_size IS NULL AND v_fee_text IS NULL AND v_addon_text IS NULL THEN
      v_size := OLD.shipment_size;
      v_fee_text := OLD.delivery_fee_tariff::text;
      v_addon_text := OLD.delivery_fee_addon::text;
    END IF;
    IF v_addon_text IS NULL THEN
      v_addon := COALESCE(OLD.delivery_fee_addon, 0);
    ELSE
      IF v_addon_text !~ '^[0-9]{1,12}$' THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      v_addon := v_addon_text::bigint;
    END IF;

    IF v_size IS NULL THEN
      IF v_fee_text IS NOT NULL THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      IF v_addon <= 0 THEN
        RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
      END IF;
      v_fee := NULL;
      v_zone := NULL;
      v_total := v_addon;
    ELSE
      IF v_fee_text IS NULL OR v_fee_text !~ '^[0-9]{1,12}$' THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      v_fee := v_fee_text::bigint;
      IF v_fee <= 0 THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;

      SELECT g.tariff_profile, l.tariff_zone
        INTO v_profile, v_area_zone
      FROM public.postal_governorates g
      JOIN public.postal_locations l ON l.governorate = g.id
      WHERE g.id = NEW.governorate AND l.area = NEW.area;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'postal_location_unavailable' USING ERRCODE = '22023';
      END IF;

      v_zone := CASE WHEN v_profile = 'northern' THEN v_area_zone ELSE 'standard' END;
      IF NOT EXISTS (
        SELECT 1 FROM public.postal_shipment_tariffs t
        WHERE t.tariff_profile = v_profile
          AND t.shipment_size = v_size
          AND t.tariff_zone = v_zone
          AND t.fee = v_fee
          AND (
            t.is_active
            OR (
              OLD.shipment_size = v_size
              AND OLD.delivery_fee_tariff = v_fee
              AND OLD.tariff_zone IS NOT DISTINCT FROM
                CASE WHEN v_profile = 'northern' THEN v_zone ELSE NULL END
            )
          )
      ) THEN
        RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
      END IF;
      IF v_profile <> 'northern' THEN v_zone := NULL; END IF;
      v_total := v_fee + v_addon;
    END IF;

    IF v_total <= 0 OR v_total > 999999999999 THEN
      RAISE EXCEPTION 'postal_invalid_tariff' USING ERRCODE = '22023';
    END IF;

    NEW.shipment_size := v_size;
    NEW.tariff_zone := v_zone;
    NEW.delivery_fee_tariff := v_fee;
    NEW.delivery_fee_addon := v_addon;
    NEW.delivery_fee := v_total;
    IF OLD.tariff_assigned_at IS NULL
      OR ROW(v_size, v_zone, v_fee, v_addon, v_total)
        IS DISTINCT FROM ROW(OLD.shipment_size, OLD.tariff_zone,
          OLD.delivery_fee_tariff, OLD.delivery_fee_addon, OLD.delivery_fee) THEN
      NEW.tariff_assigned_by := auth.uid();
      NEW.tariff_assigned_at := now();
    END IF;
  ELSIF OLD.state = 'draft' AND NEW.state = 'received' THEN
    RAISE EXCEPTION 'postal_tariff_required' USING ERRCODE = '23514';
  ELSIF ROW(NEW.shipment_size, NEW.tariff_zone, NEW.delivery_fee,
            NEW.delivery_fee_tariff, NEW.delivery_fee_addon,
            NEW.tariff_assigned_by, NEW.tariff_assigned_at)
    IS DISTINCT FROM ROW(OLD.shipment_size, OLD.tariff_zone, OLD.delivery_fee,
                          OLD.delivery_fee_tariff, OLD.delivery_fee_addon,
                          OLD.tariff_assigned_by, OLD.tariff_assigned_at) THEN
    RAISE EXCEPTION 'postal_tariff_locked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
