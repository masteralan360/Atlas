-- The Table Editor and SQL Editor operate as trusted database administration,
-- not as an Atlas application user. They therefore have no request JWT and
-- cannot resolve a current workspace through auth.uid(). Do not mistake that
-- missing application context for a hidden business partner.
--
-- Authenticated Atlas users continue through crm.can_access_business_partner,
-- so partner privacy is still enforced for every application write.
CREATE OR REPLACE FUNCTION crm.enforce_visible_partner_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm
AS $function$
DECLARE
  partner_id uuid;
  partner_scope text := CASE WHEN TG_TABLE_NAME = 'purchase_orders' THEN 'supplier' ELSE 'customer' END;
  facet_id uuid;
BEGIN
  -- Direct Dashboard/SQL and server-side administration have no Atlas user
  -- identity. They are already privileged database operations and must be
  -- able to correct an order, including its historical balance snapshot.
  IF auth.uid() IS NULL OR auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  partner_id := NULLIF(to_jsonb(NEW)->>'business_partner_id', '')::uuid;
  IF partner_id IS NULL THEN
    IF TG_TABLE_NAME = 'purchase_orders' THEN
      facet_id := NULLIF(to_jsonb(NEW)->>'supplier_id', '')::uuid;
      SELECT supplier.business_partner_id INTO partner_id
      FROM crm.suppliers AS supplier
      WHERE supplier.id = facet_id;
    ELSE
      facet_id := NULLIF(to_jsonb(NEW)->>'customer_id', '')::uuid;
      SELECT customer.business_partner_id INTO partner_id
      FROM crm.customers AS customer
      WHERE customer.id = facet_id;
    END IF;
  END IF;

  IF partner_id IS NOT NULL
    AND NOT crm.can_access_business_partner(NEW.workspace_id, partner_id, partner_scope) THEN
    RAISE EXCEPTION 'Business partner is unavailable' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
