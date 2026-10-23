-- Remove only the retired schema from the exact live exposed-schema list captured during cutover.
-- Hosted configuration still listed delivery after its removal, preventing PostgREST cache loading.
-- The database role setting is now authoritative for db_schemas; preserve the remaining live schemas.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER ROLE authenticator SET pgrst.db_schemas TO 'public,graphql_public,budget,crm,real_estate,fx,clinics,fleet,notifications,billing,activities,car_rental,payment_accounts,travel_transportation';
-- The preceding recovery migration created an empty namespace only; refuse to drop new objects.
DROP SCHEMA IF EXISTS delivery RESTRICT;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
COMMIT;
