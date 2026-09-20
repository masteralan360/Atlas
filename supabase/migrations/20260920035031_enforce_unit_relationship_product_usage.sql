-- Active products reserve their unit and every endpoint of the relationship
-- they use. Relationship structure must be created before those products.

SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS idx_products_active_workspace_unit
  ON public.products (workspace_id, lower(btrim(unit)))
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_unit_relationships_active_parent
  ON public.unit_relationships (workspace_id, parent_unit_ref)
  WHERE is_deleted = false AND is_archived = false;

CREATE INDEX IF NOT EXISTS idx_unit_relationships_active_child
  ON public.unit_relationships (workspace_id, child_unit_ref)
  WHERE is_deleted = false AND is_archived = false;

CREATE OR REPLACE FUNCTION public.enforce_unit_relationship_product_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid;
  v_relationship_id uuid;
  v_validate_endpoints boolean := false;
  v_removing_relationship boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_workspace_id := OLD.workspace_id;
    v_relationship_id := OLD.id;
    v_removing_relationship := true;
  ELSE
    v_workspace_id := NEW.workspace_id;
    v_relationship_id := NEW.id;
    IF TG_OP = 'INSERT' THEN
      v_validate_endpoints := NOT NEW.is_archived AND NOT NEW.is_deleted;
    ELSE
      v_validate_endpoints := NOT NEW.is_archived
        AND NOT NEW.is_deleted
        AND (
          (NEW.parent_unit_ref, NEW.child_unit_ref)
            IS DISTINCT FROM (OLD.parent_unit_ref, OLD.child_unit_ref)
          OR (OLD.is_archived AND NOT NEW.is_archived)
          OR (OLD.is_deleted AND NOT NEW.is_deleted)
        );
      v_removing_relationship := (NOT OLD.is_archived AND NEW.is_archived)
        OR (NOT OLD.is_deleted AND NEW.is_deleted);
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('unit-relationships:' || v_workspace_id::text, 0)
  );

  IF v_removing_relationship AND EXISTS (
    SELECT 1
    FROM public.product_unit_conversions AS conversion
    JOIN public.products AS product
      ON product.id = conversion.product_id
      AND product.workspace_id = conversion.workspace_id
      AND product.is_deleted = false
    WHERE conversion.workspace_id = v_workspace_id
      AND conversion.relationship_id = v_relationship_id
      AND conversion.is_deleted = false
  ) THEN
    RAISE EXCEPTION 'Unit relationship is used by a product and cannot be archived or deleted'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF v_validate_endpoints AND (
    EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.workspace_id = NEW.workspace_id
        AND product.is_deleted = false
        AND lower(btrim(product.unit)) IN (
          lower(btrim(NEW.parent_unit_code)),
          lower(btrim(NEW.child_unit_code))
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.product_unit_conversions AS conversion
      JOIN public.products AS product
        ON product.id = conversion.product_id
        AND product.workspace_id = conversion.workspace_id
        AND product.is_deleted = false
      JOIN public.unit_relationships AS linked_relationship
        ON linked_relationship.id = conversion.relationship_id
        AND linked_relationship.workspace_id = conversion.workspace_id
        AND linked_relationship.is_deleted = false
      WHERE conversion.workspace_id = NEW.workspace_id
        AND conversion.is_deleted = false
        AND (
          linked_relationship.parent_unit_ref IN (NEW.parent_unit_ref, NEW.child_unit_ref)
          OR linked_relationship.child_unit_ref IN (NEW.parent_unit_ref, NEW.child_unit_ref)
        )
    )
  ) THEN
    RAISE EXCEPTION 'Unit relationship endpoint is already used by a product'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_unit_relationship_product_usage_on_write
  ON public.unit_relationships;
CREATE TRIGGER enforce_unit_relationship_product_usage_on_write
BEFORE INSERT OR UPDATE OR DELETE ON public.unit_relationships
FOR EACH ROW EXECUTE FUNCTION public.enforce_unit_relationship_product_usage();

COMMENT ON FUNCTION public.enforce_unit_relationship_product_usage() IS
  'Prevents relationship creation/restoration on product-used endpoints and prevents archive/delete while directly used.';
