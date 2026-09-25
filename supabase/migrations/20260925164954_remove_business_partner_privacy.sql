-- Business partners are workspace-scoped records. Remove per-partner and
-- workspace-level privacy controls while retaining workspace authorization.

CREATE OR REPLACE FUNCTION crm.can_access_business_partner(
  p_workspace_id uuid,
  p_business_partner_id uuid,
  p_scope text DEFAULT 'customer'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, crm
AS $function$
  SELECT p_workspace_id = public.current_workspace_id()
    AND p_business_partner_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM crm.business_partners AS partner
      WHERE partner.id = p_business_partner_id
        AND partner.workspace_id = p_workspace_id
        AND COALESCE(partner.is_deleted, false) = false
        AND (
          COALESCE(p_scope, 'customer') <> 'supplier'
          OR partner.role <> 'customer'
        )
    );
$function$;

CREATE OR REPLACE FUNCTION crm.can_manage_business_partner(
  p_workspace_id uuid,
  p_business_partner_id uuid,
  p_scope text DEFAULT 'customer'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, crm
AS $function$
  SELECT crm.can_access_business_partner(p_workspace_id, p_business_partner_id, p_scope);
$function$;

REVOKE ALL ON FUNCTION crm.can_access_business_partner(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm.can_manage_business_partner(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.can_access_business_partner(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION crm.can_manage_business_partner(uuid, uuid, text) TO authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_business_partner_privacy_on_write ON crm.business_partners;
DROP TRIGGER IF EXISTS enforce_business_partner_privacy_on_insert ON crm.business_partners;
DROP TRIGGER IF EXISTS enforce_business_partner_privacy_on_update ON crm.business_partners;
DROP TRIGGER IF EXISTS a_preserve_business_partner_privacy_on_staff_update ON crm.business_partners;
DROP TRIGGER IF EXISTS audit_business_partner_privacy_change_on_write ON crm.business_partners;
DROP TRIGGER IF EXISTS audit_business_partner_privacy_change_on_insert ON crm.business_partners;
DROP TRIGGER IF EXISTS audit_business_partner_privacy_change_on_update ON crm.business_partners;
DROP TRIGGER IF EXISTS audit_workspace_partner_privacy_settings_on_write ON public.workspaces;

DROP FUNCTION IF EXISTS crm.list_visible_business_partners(uuid);
DROP FUNCTION IF EXISTS crm.enforce_business_partner_privacy();
DROP FUNCTION IF EXISTS crm.preserve_business_partner_privacy_on_staff_update();
DROP FUNCTION IF EXISTS crm.is_partner_privacy_admin();
DROP FUNCTION IF EXISTS public.audit_business_partner_privacy_change();
DROP FUNCTION IF EXISTS public.audit_workspace_partner_privacy_settings_change();

-- Recreate the sync RPC without the retired columns. This also lets clients
-- continue syncing old queued records after their local upgrade removes the
-- obsolete fields.
CREATE OR REPLACE FUNCTION crm.sync_business_partner(
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
  v_existing crm.business_partners%ROWTYPE;
  v_next crm.business_partners%ROWTYPE;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb)
    - 'staff_visibility'
    - 'owner_user_id'
    - 'staffVisibility'
    - 'ownerUserId';
  v_is_service boolean := auth.role() = 'service_role';
  v_scope text;
BEGIN
  IF p_entity_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Business partner sync requires an entity and workspace id' USING ERRCODE = '22023';
  END IF;
  IF p_operation NOT IN ('upsert', 'soft_delete') THEN
    RAISE EXCEPTION 'Unsupported business partner sync operation: %', p_operation USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_service AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to sync business partners' USING ERRCODE = '42501';
  END IF;
  IF NOT v_is_service AND p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM crm.business_partners
  WHERE id = p_entity_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.workspace_id IS DISTINCT FROM p_workspace_id THEN
      RAISE EXCEPTION 'Business partner belongs to a different workspace' USING ERRCODE = '42501';
    END IF;

    v_scope := CASE WHEN v_existing.role = 'supplier' THEN 'supplier' ELSE 'customer' END;
    IF NOT v_is_service
      AND NOT crm.can_manage_business_partner(v_existing.workspace_id, v_existing.id, v_scope) THEN
      RAISE EXCEPTION 'Business partner access denied' USING ERRCODE = '42501';
    END IF;

    IF p_operation = 'soft_delete' THEN
      UPDATE crm.business_partners
      SET is_deleted = true,
          updated_at = now()
      WHERE id = p_entity_id;
      RETURN;
    END IF;

    PERFORM crm.assert_partner_sync_payload_columns('crm.business_partners'::regclass, v_payload);
    v_next := jsonb_populate_record(v_existing, v_payload);

    IF v_next.id IS DISTINCT FROM p_entity_id OR v_next.workspace_id IS DISTINCT FROM v_existing.workspace_id THEN
      RAISE EXCEPTION 'Business partner identity and workspace cannot change during sync' USING ERRCODE = '42501';
    END IF;
    IF v_next.role = 'agent'
      AND NOT (
        public.workspace_module_allowed(
          p_workspace_id,
          (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = p_workspace_id),
          'agents'
        )
        OR delivery.module_allowed(p_workspace_id)
      ) THEN
      RAISE EXCEPTION 'Agents module is not available in this workspace' USING ERRCODE = '42501';
    END IF;

    UPDATE crm.business_partners
    SET partner_name = v_next.partner_name,
        name = v_next.name,
        contact_name = v_next.contact_name,
        phone = v_next.phone,
        address = v_next.address,
        city = v_next.city,
        notes = v_next.notes,
        default_currency = v_next.default_currency,
        role = v_next.role,
        credit_limit = v_next.credit_limit,
        receivable_credit_limit = v_next.receivable_credit_limit,
        payable_credit_limit = v_next.payable_credit_limit,
        customer_facet_id = v_next.customer_facet_id,
        supplier_facet_id = v_next.supplier_facet_id,
        agent_facet_id = v_next.agent_facet_id,
        price_book_id = v_next.price_book_id,
        total_sales_orders = v_next.total_sales_orders,
        total_sales_value = v_next.total_sales_value,
        receivable_balance = v_next.receivable_balance,
        total_purchase_orders = v_next.total_purchase_orders,
        total_purchase_value = v_next.total_purchase_value,
        payable_balance = v_next.payable_balance,
        total_loan_count = v_next.total_loan_count,
        loan_outstanding_balance = v_next.loan_outstanding_balance,
        net_exposure = v_next.net_exposure,
        merged_into_business_partner_id = v_next.merged_into_business_partner_id,
        is_ecommerce = v_next.is_ecommerce,
        updated_at = COALESCE(v_next.updated_at, now()),
        version = v_next.version,
        is_deleted = v_next.is_deleted,
        latitude = v_next.latitude,
        longitude = v_next.longitude
    WHERE id = p_entity_id;
    RETURN;
  END IF;

  IF p_operation = 'soft_delete' THEN
    -- A retry after a successful delete is idempotent.
    RETURN;
  END IF;

  PERFORM crm.assert_partner_sync_payload_columns('crm.business_partners'::regclass, v_payload);
  v_next := jsonb_populate_record(NULL::crm.business_partners, v_payload);

  IF v_next.id IS DISTINCT FROM p_entity_id OR v_next.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'Business partner identity and workspace must match the sync request' USING ERRCODE = '42501';
  END IF;
  IF v_next.role = 'agent'
    AND NOT (
      public.workspace_module_allowed(
        p_workspace_id,
        (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = p_workspace_id),
        'agents'
      )
      OR delivery.module_allowed(p_workspace_id)
    ) THEN
    RAISE EXCEPTION 'Agents module is not available in this workspace' USING ERRCODE = '42501';
  END IF;

  v_next.sync_status := COALESCE(v_next.sync_status, 'synced');
  v_next.created_at := COALESCE(v_next.created_at, now());
  v_next.updated_at := COALESCE(v_next.updated_at, now());
  v_next.default_currency := COALESCE(v_next.default_currency, 'usd');
  v_next.role := COALESCE(v_next.role, 'customer');
  v_next.is_deleted := COALESCE(v_next.is_deleted, false);
  v_next.is_ecommerce := COALESCE(v_next.is_ecommerce, false);
  v_next.version := COALESCE(v_next.version, 1);

  INSERT INTO crm.business_partners (
    id, workspace_id, partner_name, name, contact_name, phone, address, city, notes,
    default_currency, role, credit_limit, receivable_credit_limit, payable_credit_limit,
    customer_facet_id, supplier_facet_id, agent_facet_id, price_book_id,
    total_sales_orders, total_sales_value, receivable_balance,
    total_purchase_orders, total_purchase_value, payable_balance,
    total_loan_count, loan_outstanding_balance, net_exposure,
    merged_into_business_partner_id, is_ecommerce, created_at, updated_at, sync_status,
    version, is_deleted, latitude, longitude
  ) VALUES (
    v_next.id, v_next.workspace_id, v_next.partner_name, v_next.name, v_next.contact_name,
    v_next.phone, v_next.address, v_next.city, v_next.notes, v_next.default_currency,
    v_next.role, v_next.credit_limit, v_next.receivable_credit_limit,
    v_next.payable_credit_limit, v_next.customer_facet_id, v_next.supplier_facet_id,
    v_next.agent_facet_id, v_next.price_book_id, v_next.total_sales_orders,
    v_next.total_sales_value, v_next.receivable_balance, v_next.total_purchase_orders,
    v_next.total_purchase_value, v_next.payable_balance, v_next.total_loan_count,
    v_next.loan_outstanding_balance, v_next.net_exposure, v_next.merged_into_business_partner_id,
    v_next.is_ecommerce, v_next.created_at, v_next.updated_at, v_next.sync_status,
    v_next.version, v_next.is_deleted, v_next.latitude, v_next.longitude
  );
END;
$function$;

DROP INDEX IF EXISTS crm.business_partners_workspace_visibility_owner_idx;
ALTER TABLE crm.business_partners
  DROP CONSTRAINT IF EXISTS business_partners_staff_visibility_check,
  DROP COLUMN IF EXISTS staff_visibility,
  DROP COLUMN IF EXISTS owner_user_id;

ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS private_staff_customers,
  DROP COLUMN IF EXISTS private_staff_suppliers,
  DROP COLUMN IF EXISTS suppliers_admin_only;

DROP TABLE IF EXISTS crm.business_partner_privacy_audit;

CREATE OR REPLACE FUNCTION crm.list_visible_business_partners(p_workspace_id uuid)
RETURNS SETOF crm.business_partners
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, crm
AS $function$
  SELECT partner.*
  FROM crm.business_partners AS partner
  WHERE partner.workspace_id = p_workspace_id
    AND partner.workspace_id = public.current_workspace_id()
    AND COALESCE(partner.is_deleted, false) = false
    AND crm.can_access_business_partner(
      partner.workspace_id,
      partner.id,
      CASE WHEN partner.role = 'supplier' THEN 'supplier' ELSE 'customer' END
    );
$function$;

REVOKE ALL ON FUNCTION crm.list_visible_business_partners(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.list_visible_business_partners(uuid) TO authenticated, service_role;
