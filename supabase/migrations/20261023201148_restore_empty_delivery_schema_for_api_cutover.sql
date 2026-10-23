-- Temporary empty namespace restores PostgREST while its hosted exposed-schema configuration is corrected.
-- Post Service data and objects remain retired; the final API cutover migration drops this empty schema.
CREATE SCHEMA IF NOT EXISTS delivery;
NOTIFY pgrst, 'reload schema';
