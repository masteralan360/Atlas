-- Offline clients can retain a complete partner row while an administrator
-- changes its privacy fields. A staff member who can still edit that partner
-- must not have a later non-privacy edit rejected merely because its old
-- payload includes those protected fields. The RPC continues to reject rows
-- the caller cannot manage before this trigger can run.
CREATE OR REPLACE FUNCTION crm.preserve_business_partner_privacy_on_staff_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, crm, pg_temp
AS $function$
BEGIN
  IF auth.role() = 'service_role' OR crm.is_partner_privacy_admin() THEN
    RETURN NEW;
  END IF;

  NEW.staff_visibility := OLD.staff_visibility;
  NEW.owner_user_id := OLD.owner_user_id;

  RETURN NEW;
END;
$function$;

-- Trigger functions are internal implementation details, not RPC endpoints.
REVOKE ALL ON FUNCTION crm.preserve_business_partner_privacy_on_staff_update() FROM PUBLIC;

-- PostgreSQL executes triggers with the same timing in alphabetical name
-- order. This must run before enforce_business_partner_privacy_on_update.
DROP TRIGGER IF EXISTS a_preserve_business_partner_privacy_on_staff_update
  ON crm.business_partners;
CREATE TRIGGER a_preserve_business_partner_privacy_on_staff_update
  BEFORE UPDATE OF staff_visibility, owner_user_id ON crm.business_partners
  FOR EACH ROW
  EXECUTE FUNCTION crm.preserve_business_partner_privacy_on_staff_update();
