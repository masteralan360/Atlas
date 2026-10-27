CREATE TABLE IF NOT EXISTS public.storefront_promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  code text NOT NULL,
  discount_value numeric(15, 3) NOT NULL CHECK (discount_value > 0),
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamp with time zone NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT storefront_promo_codes_percentage_limit
    CHECK (discount_type <> 'percentage' OR discount_value <= 100)
);

CREATE OR REPLACE FUNCTION public.normalize_storefront_promo_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  NEW.code := upper(trim(COALESCE(NEW.code, '')));
  IF NEW.code = '' OR char_length(NEW.code) > 80 THEN
    RAISE EXCEPTION 'Promo codes must contain between 1 and 80 characters';
  END IF;
  NEW.discount_value := round(NEW.discount_value, 3);
  NEW.updated_at := timezone('utc', now());
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS normalize_storefront_promo_code_before_write ON public.storefront_promo_codes;
CREATE TRIGGER normalize_storefront_promo_code_before_write
BEFORE INSERT OR UPDATE ON public.storefront_promo_codes
FOR EACH ROW
EXECUTE FUNCTION public.normalize_storefront_promo_code();

CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_promo_codes_workspace_code
  ON public.storefront_promo_codes (workspace_id, code);

ALTER TABLE public.storefront_promo_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.storefront_promo_codes FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storefront_promo_codes TO service_role;

COMMENT ON TABLE public.storefront_promo_codes IS
  'Manually managed promo codes available to the bound website storefront; read and write through trusted service-role backend code.';

ALTER TABLE public.marketplace_orders
  ADD COLUMN IF NOT EXISTS promo_code text NULL,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(15, 3) NOT NULL DEFAULT 0;

DO $marketplace_order_promo_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_discount_amount_nonnegative'
  ) THEN
    ALTER TABLE public.marketplace_orders
      ADD CONSTRAINT marketplace_orders_discount_amount_nonnegative CHECK (discount_amount >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_discount_not_above_subtotal'
  ) THEN
    ALTER TABLE public.marketplace_orders
      ADD CONSTRAINT marketplace_orders_discount_not_above_subtotal CHECK (discount_amount <= subtotal);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_orders_promo_code_discount_pair'
  ) THEN
    ALTER TABLE public.marketplace_orders
      ADD CONSTRAINT marketplace_orders_promo_code_discount_pair CHECK (
        (promo_code IS NULL AND discount_amount = 0)
        OR (NULLIF(trim(promo_code), '') IS NOT NULL AND discount_amount > 0)
      );
  END IF;
END;
$marketplace_order_promo_constraints$;

COMMENT ON COLUMN public.marketplace_orders.subtotal IS
  'Original product-line subtotal before any order-level promo code adjustment.';
COMMENT ON COLUMN public.marketplace_orders.discount_amount IS
  'Immutable discount amount finalized at website inquiry checkout, in the order currency.';
COMMENT ON COLUMN public.marketplace_orders.promo_code IS
  'Promo code snapshot captured with the final website discount.';

-- Marketplace orders become Sales Orders in this existing status transition.
-- The established adjustment JSON shape keeps the promo as one built-in deduction.
DO $marketplace_sales_order_promo$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL
    OR position('INSERT INTO crm.sales_orders (' IN v_definition) = 0
    OR position('v_create_sales_order' IN v_definition) = 0
    OR position('order_adjustments' IN v_definition) > 0
  THEN
    RAISE EXCEPTION 'Marketplace shipped-order Sales Order insert is not in the expected state';
  END IF;

  v_updated := replace(
    v_definition,
    E'      marketplace_order_id,\n      created_by,\n      created_at,',
    E'      marketplace_order_id,\n      order_adjustments,\n      created_by,\n      created_at,'
  );
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Promo adjustment column could not be added to the marketplace Sales Order insert';
  END IF;

  v_definition := v_updated;
  v_updated := replace(
    v_definition,
    E'      v_order.id,\n      v_shipped_actor_id,\n      v_shipment_timestamp,\n      v_shipment_timestamp,\n      ''synced'',',
    E'      v_order.id,\n'
      || E'      CASE WHEN COALESCE(v_order.discount_amount, 0) > 0\n'
      || E'        AND NULLIF(trim(COALESCE(v_order.promo_code, '''')), '''') IS NOT NULL\n'
      || E'        THEN jsonb_build_array(jsonb_build_object(\n'
      || E'          ''id'', gen_random_uuid()::text,\n'
      || E'          ''type'', ''deduction'',\n'
      || E'          ''name'', format(''Promo code %s'', v_order.promo_code),\n'
      || E'          ''currency'', lower(COALESCE(v_order.currency, v_workspace.default_currency::text, ''usd'')),\n'
      || E'          ''amount'', round(COALESCE(v_order.discount_amount, 0)::numeric, 3),\n'
      || E'          ''orderCurrency'', lower(COALESCE(v_order.currency, v_workspace.default_currency::text, ''usd'')),\n'
      || E'          ''convertedAmount'', round(COALESCE(v_order.discount_amount, 0)::numeric, 3),\n'
      || E'          ''exchangeRate'', 1,\n'
      || E'          ''exchangeRateSource'', ''native'',\n'
      || E'          ''exchangeRateTimestamp'', v_shipment_timestamp,\n'
      || E'          ''exchangeRates'', ''[]''::jsonb\n'
      || E'        ))\n'
      || E'        ELSE NULL END,\n'
      || E'      v_shipped_actor_id,\n'
      || E'      v_shipment_timestamp,\n      v_shipment_timestamp,\n      ''synced'', '
  );
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Promo adjustment value could not be added to the marketplace Sales Order insert';
  END IF;

  IF position(E'      order_adjustments,\n      created_by,\n      created_at,' IN v_updated) = 0
    OR position(E'          ''type'', ''deduction'',' IN v_updated) = 0
    OR position('v_create_sales_order' IN v_updated) = 0
  THEN
    RAISE EXCEPTION 'Marketplace promo adjustment failed post-patch validation';
  END IF;

  EXECUTE v_updated;
END;
$marketplace_sales_order_promo$;

-- Item edits are allowed before shipping. Keep the submitted discount fixed,
-- and reject edits that would make the discounted marketplace total negative.
DO $marketplace_order_item_edit_promo$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(
    'public.edit_marketplace_order_items(uuid,jsonb)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL
    OR position('v_new_product_count = 0' IN v_definition) = 0
    OR position('subtotal = v_new_subtotal' IN v_definition) = 0
    OR position('total = v_new_subtotal' IN v_definition) = 0
    OR position('''total'', v_new_subtotal' IN v_definition) = 0
    OR position('discount_amount' IN v_definition) > 0
  THEN
    RAISE EXCEPTION 'Marketplace item-edit function is not in the expected state';
  END IF;

  v_updated := replace(
    v_definition,
    E'  IF v_new_product_count = 0 THEN\n    RAISE EXCEPTION ''A marketplace order must keep at least one item'';\n  END IF;\n\n  UPDATE public.marketplace_orders',
    E'  IF v_new_product_count = 0 THEN\n    RAISE EXCEPTION ''A marketplace order must keep at least one item'';\n  END IF;\n\n'
      || E'  IF COALESCE(v_order.discount_amount, 0) > v_new_subtotal THEN\n'
      || E'    RAISE EXCEPTION ''Order items cannot be reduced below the applied promo discount'';\n'
      || E'  END IF;\n\n  UPDATE public.marketplace_orders'
  );
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Promo discount protection could not be added to marketplace item edits';
  END IF;

  v_definition := v_updated;
  v_updated := replace(
    v_definition,
    'total = v_new_subtotal,',
    'total = v_new_subtotal - COALESCE(v_order.discount_amount, 0),'
  );
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Marketplace edited order total could not retain its promo discount';
  END IF;

  v_definition := v_updated;
  v_updated := replace(
    v_definition,
    E'''total'', v_new_subtotal,',
    E'''total'', v_new_subtotal - COALESCE(v_order.discount_amount, 0),'
  );
  IF v_updated IS NOT DISTINCT FROM v_definition
    OR position('v_new_subtotal - COALESCE(v_order.discount_amount, 0)' IN v_updated) < 2
    OR position('Order items cannot be reduced below the applied promo discount' IN v_updated) = 0
  THEN
    RAISE EXCEPTION 'Marketplace promo item-edit updates failed post-patch validation';
  END IF;

  EXECUTE v_updated;
END;
$marketplace_order_item_edit_promo$;
