INSERT INTO public.postal_locations (governorate, area)
VALUES ('sulaymaniyah', 'kalar')
ON CONFLICT (governorate, area) DO NOTHING;
