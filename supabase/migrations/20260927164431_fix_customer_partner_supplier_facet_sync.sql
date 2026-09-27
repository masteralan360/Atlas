-- Existing clients can still have queued supplier updates from before a
-- partner was changed to Customer. Turn those stale updates into a safe
-- supplier tombstone instead of leaving the sync queue permanently blocked.
CREATE OR REPLACE FUNCTION crm.sync_supplier(
  p_operation text,
  p_entity_id uuid,
  p_workspace_id uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm, pg_temp
AS $function$
DECLARE
  v_existing crm.suppliers%ROWTYPE;
  v_next crm.suppliers%ROWTYPE;
  v_partner crm.business_partners%ROWTYPE;
  v_is_service boolean := auth.role() = 'service_role';
BEGIN
  IF p_entity_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Supplier sync requires an entity and workspace id' USING ERRCODE = '22023';
  END IF;
  IF p_operation NOT IN ('upsert', 'soft_delete') THEN
    RAISE EXCEPTION 'Unsupported supplier sync operation: %', p_operation USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_service AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to sync suppliers' USING ERRCODE = '42501';
  END IF;
  IF NOT v_is_service AND p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing FROM crm.suppliers WHERE id = p_entity_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.workspace_id IS DISTINCT FROM p_workspace_id THEN
      RAISE EXCEPTION 'Supplier belongs to a different workspace' USING ERRCODE = '42501';
    END IF;

    IF v_existing.business_partner_id IS NOT NULL THEN
      SELECT * INTO v_partner
      FROM crm.business_partners
      WHERE id = v_existing.business_partner_id;
    END IF;

    IF NOT v_is_service AND (
      v_existing.business_partner_id IS NULL
      OR NOT crm.can_manage_business_partner(v_existing.workspace_id, v_existing.business_partner_id, 'supplier')
    ) THEN
      IF v_partner.id IS NOT NULL
        AND v_partner.workspace_id = p_workspace_id
        AND v_partner.role = 'customer' THEN
        -- The partner role is already demoted, so only allow the operation to
        -- remove the now-inaccessible facet. Never apply stale supplier data.
        UPDATE crm.suppliers
        SET is_deleted = true,
            updated_at = now()
        WHERE id = p_entity_id;

        UPDATE crm.business_partners
        SET supplier_facet_id = NULL,
            updated_at = now(),
            version = COALESCE(version, 0) + 1
        WHERE id = v_partner.id
          AND supplier_facet_id = p_entity_id;
        RETURN;
      END IF;

      RAISE EXCEPTION 'Supplier access denied' USING ERRCODE = '42501';
    END IF;

    IF p_operation = 'soft_delete' THEN
      UPDATE crm.suppliers SET is_deleted = true, updated_at = now() WHERE id = p_entity_id;
      RETURN;
    END IF;

    PERFORM crm.assert_partner_sync_payload_columns('crm.suppliers'::regclass, p_payload);
    v_next := jsonb_populate_record(v_existing, p_payload);
    IF v_next.id IS DISTINCT FROM p_entity_id
      OR v_next.workspace_id IS DISTINCT FROM v_existing.workspace_id
      OR v_next.business_partner_id IS DISTINCT FROM v_existing.business_partner_id THEN
      RAISE EXCEPTION 'Supplier identity, workspace, and partner link cannot change during sync' USING ERRCODE = '42501';
    END IF;

    UPDATE crm.suppliers
    SET partner_name = v_next.partner_name,
        name = v_next.name,
        contact_name = v_next.contact_name,
        phone = v_next.phone,
        address = v_next.address,
        city = v_next.city,
        default_currency = v_next.default_currency,
        notes = v_next.notes,
        total_purchases = v_next.total_purchases,
        total_spent = v_next.total_spent,
        updated_at = COALESCE(v_next.updated_at, now()),
        version = v_next.version,
        is_deleted = v_next.is_deleted,
        credit_limit = v_next.credit_limit,
        is_ecommerce = v_next.is_ecommerce
    WHERE id = p_entity_id;
    RETURN;
  END IF;

  IF p_operation = 'soft_delete' THEN
    RETURN;
  END IF;

  PERFORM crm.assert_partner_sync_payload_columns('crm.suppliers'::regclass, p_payload);
  v_next := jsonb_populate_record(NULL::crm.suppliers, p_payload);
  IF v_next.id IS DISTINCT FROM p_entity_id
    OR v_next.workspace_id IS DISTINCT FROM p_workspace_id
    OR v_next.business_partner_id IS NULL THEN
    RAISE EXCEPTION 'Supplier identity, workspace, and partner link must match the sync request' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_partner FROM crm.business_partners WHERE id = v_next.business_partner_id;
  IF NOT FOUND OR v_partner.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'Supplier must reference a business partner in the same workspace' USING ERRCODE = '23514';
  END IF;
  IF NOT v_is_service AND NOT crm.can_manage_business_partner(p_workspace_id, v_next.business_partner_id, 'supplier') THEN
    RAISE EXCEPTION 'Supplier access denied' USING ERRCODE = '42501';
  END IF;

  v_next.sync_status := COALESCE(v_next.sync_status, 'synced');
  v_next.created_at := COALESCE(v_next.created_at, now());
  v_next.updated_at := COALESCE(v_next.updated_at, now());
  v_next.default_currency := COALESCE(v_next.default_currency, 'usd');
  v_next.is_deleted := COALESCE(v_next.is_deleted, false);
  v_next.is_ecommerce := COALESCE(v_next.is_ecommerce, false);
  v_next.version := COALESCE(v_next.version, 1);

  INSERT INTO crm.suppliers (
    id, workspace_id, business_partner_id, partner_name, name, contact_name, phone,
    address, city, default_currency, notes, total_purchases, total_spent,
    created_at, updated_at, sync_status, version, is_deleted, credit_limit, is_ecommerce
  ) VALUES (
    v_next.id, v_next.workspace_id, v_next.business_partner_id, v_next.partner_name,
    v_next.name, v_next.contact_name, v_next.phone, v_next.address, v_next.city,
    v_next.default_currency, v_next.notes, v_next.total_purchases, v_next.total_spent,
    v_next.created_at, v_next.updated_at, v_next.sync_status, v_next.version,
    v_next.is_deleted, v_next.credit_limit, v_next.is_ecommerce
  );
END;
$function$;

REVOKE ALL ON FUNCTION crm.sync_supplier(text, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.sync_supplier(text, uuid, uuid, jsonb) TO authenticated, service_role;
