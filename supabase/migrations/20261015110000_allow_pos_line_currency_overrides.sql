-- POS line currency overrides keep the chosen line currency while preserving
-- the existing single-currency payment and sale settlement model.

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS pos_line_currency_settlement_override boolean NOT NULL DEFAULT false;

-- Persist arbitrary POS item metadata before sale-item currency guards run.
DO $patch_pos_currency_override_metadata$
DECLARE
  checkout_definition text;
  sale_column_marker text := E'        origin,\n        payment_method,';
  sale_value_marker text := E'        COALESCE(payload->>''origin'', ''pos''),\n        COALESCE(payload->>''payment_method'', ''cash''),';
  column_marker text := E'            price_book_id\n        )';
  value_marker text := E'            (item->>''price_book_id'')::uuid\n        );';
BEGIN
  SELECT pg_catalog.pg_get_functiondef('private.complete_sale_once(jsonb)'::regprocedure)
  INTO checkout_definition;

  IF pg_catalog.strpos(checkout_definition, 'COALESCE(item->''metadata'', ''{}''::jsonb)') > 0
    AND pg_catalog.strpos(checkout_definition, 'currency_conversion_applied') > 0
    AND pg_catalog.strpos(checkout_definition, 'pos_line_currency_settlement_override') > 0 THEN
    RETURN;
  END IF;

  IF pg_catalog.strpos(checkout_definition, 'currency_conversion_applied') = 0 THEN
    IF pg_catalog.strpos(checkout_definition, sale_column_marker) = 0
      OR pg_catalog.strpos(checkout_definition, sale_value_marker) = 0 THEN
      RAISE EXCEPTION 'complete_sale_once does not contain the expected sales insert';
    END IF;
    checkout_definition := pg_catalog.replace(
      checkout_definition,
      sale_column_marker,
      E'        origin,\n        currency_conversion_applied,\n        pos_line_currency_settlement_override,\n        payment_method,'
    );
    checkout_definition := pg_catalog.replace(
      checkout_definition,
      sale_value_marker,
      E'        COALESCE(payload->>''origin'', ''pos''),\n        CASE\n          WHEN COALESCE(payload->>''origin'', ''pos'') = ''pos'' THEN EXISTS (\n            SELECT 1\n            FROM jsonb_array_elements(COALESCE(payload->''items'', ''[]''::jsonb)) AS pos_item(value)\n            WHERE pos_item.value->''metadata''->''posPriceCurrencyOverride'' IS NOT NULL\n          )\n          ELSE true\n        END,\n        CASE\n          WHEN COALESCE(payload->>''origin'', ''pos'') = ''pos'' THEN\n            jsonb_array_length(COALESCE(payload->''items'', ''[]''::jsonb)) > 0\n            AND NOT EXISTS (\n              SELECT 1\n              FROM jsonb_array_elements(COALESCE(payload->''items'', ''[]''::jsonb)) AS pos_item(value)\n              WHERE pos_item.value->''metadata''->''posPriceCurrencyOverride'' IS NULL\n                OR lower(COALESCE(pos_item.value->''metadata''->''posPriceCurrencyOverride''->>''selectedCurrency'', ''''))\n                  <> lower(COALESCE(payload->>''settlement_currency'', payload->>''currency'', ''usd''))\n                OR lower(COALESCE(pos_item.value->>''original_currency'', ''''))\n                  <> lower(COALESCE(payload->>''settlement_currency'', payload->>''currency'', ''usd''))\n            )\n          ELSE false\n        END,\n        COALESCE(payload->>''payment_method'', ''cash''),'
    );
  END IF;

  IF pg_catalog.strpos(checkout_definition, 'COALESCE(item->''metadata'', ''{}''::jsonb)') = 0 THEN
    IF pg_catalog.strpos(checkout_definition, column_marker) = 0
      OR pg_catalog.strpos(checkout_definition, value_marker) = 0 THEN
      RAISE EXCEPTION 'complete_sale_once does not contain the expected sale-item insert';
    END IF;

    checkout_definition := pg_catalog.replace(
      checkout_definition,
      column_marker,
      E'            price_book_id,\n            metadata\n        )'
    );
    checkout_definition := pg_catalog.replace(
      checkout_definition,
      value_marker,
      E'            (item->>''price_book_id'')::uuid,\n            COALESCE(item->''metadata'', ''{}''::jsonb)\n        );'
    );
  END IF;

  IF pg_catalog.strpos(checkout_definition, 'COALESCE(item->''metadata'', ''{}''::jsonb)') = 0
    OR pg_catalog.strpos(checkout_definition, 'currency_conversion_applied') = 0
    OR pg_catalog.strpos(checkout_definition, 'pos_line_currency_settlement_override') = 0 THEN
    RAISE EXCEPTION 'complete_sale_once currency override patches failed';
  END IF;
  EXECUTE checkout_definition;
END;
$patch_pos_currency_override_metadata$;

-- Preserve the workspace setting while allowing a cart made only of explicit
-- same-currency line overrides to settle directly in that selected currency.
CREATE OR REPLACE FUNCTION public.capture_pos_currency_conversion_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_conversion_enabled boolean;
  v_workspace_currency text;
BEGIN
  IF COALESCE(NEW.origin, 'pos') <> 'pos' THEN
    RETURN NEW;
  END IF;

  SELECT
    COALESCE(pos_convert_to_workspace_currency, true),
    lower(default_currency::text)
  INTO v_conversion_enabled, v_workspace_currency
  FROM public.workspaces
  WHERE id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace not found for POS sale';
  END IF;

  IF v_conversion_enabled
    AND lower(COALESCE(NEW.settlement_currency, '')) <> v_workspace_currency
    AND NOT COALESCE(NEW.pos_line_currency_settlement_override, false) THEN
    RAISE EXCEPTION 'POS sales must use the workspace currency while currency conversion is enabled';
  END IF;

  NEW.currency_conversion_applied := v_conversion_enabled
    OR COALESCE(NEW.currency_conversion_applied, false);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_pos_sale_item_currency_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_origin text;
  v_conversion_applied boolean;
  v_settlement_currency text;
  v_workspace_conversion_enabled boolean;
  v_workspace_id uuid;
  v_workspace_plan text;
  v_override jsonb;
  v_override_is_valid boolean;
BEGIN
  SELECT
    sale.workspace_id,
    workspace.plan::text,
    sale.origin,
    sale.currency_conversion_applied,
    lower(sale.settlement_currency::text),
    COALESCE(workspace.pos_convert_to_workspace_currency, true)
  INTO
    v_workspace_id,
    v_workspace_plan,
    v_origin,
    v_conversion_applied,
    v_settlement_currency,
    v_workspace_conversion_enabled
  FROM public.sales AS sale
  JOIN public.workspaces AS workspace ON workspace.id = sale.workspace_id
  WHERE sale.id = NEW.sale_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found for sale item';
  END IF;

  v_override := NEW.metadata->'posPriceCurrencyOverride';
  v_override_is_valid := pg_catalog.jsonb_typeof(v_override) = 'object'
    AND lower(COALESCE(v_override->>'selectedCurrency', '')) = lower(COALESCE(NEW.original_currency::text, ''))
    AND lower(COALESCE(v_override->>'sourceCurrency', '')) IN ('usd', 'iqd', 'eur', 'try')
    AND lower(COALESCE(v_override->>'sourceCurrency', '')) <> lower(COALESCE(v_override->>'selectedCurrency', ''))
    AND NULLIF(v_override->>'validationPriceInProductCurrency', '') ~ '^[0-9]+([.][0-9]+)?$';

  IF v_origin = 'pos' AND v_override IS NOT NULL AND NOT COALESCE(v_override_is_valid, false) THEN
    RAISE EXCEPTION 'POS line currency override is invalid';
  END IF;

  IF v_origin = 'pos'
    AND COALESCE(v_override_is_valid, false)
    AND NOT public.workspace_currency_allowed(
      v_workspace_id,
      v_workspace_plan,
      lower(v_override->>'selectedCurrency')
    ) THEN
    RAISE EXCEPTION 'POS line currency is not included in the current workspace plan'
      USING ERRCODE = '42501';
  END IF;

  IF v_origin = 'pos'
    AND NOT v_workspace_conversion_enabled
    AND lower(COALESCE(NEW.original_currency::text, '')) <> v_settlement_currency
    AND NOT COALESCE(v_override_is_valid, false) THEN
    RAISE EXCEPTION 'Currency conversion is disabled: a different line currency requires an explicit POS override';
  END IF;

  IF COALESCE(v_origin, 'pos') = 'pos'
    AND NOT COALESCE(v_conversion_applied, true)
    AND (
      lower(COALESCE(NEW.original_currency::text, '')) <> v_settlement_currency
      OR lower(COALESCE(NEW.settlement_currency::text, '')) <> v_settlement_currency
    ) THEN
    RAISE EXCEPTION 'Currency conversion is disabled: all POS sale items must use the sale currency';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_pos_sales_exchange_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_origin text;
  v_conversion_applied boolean;
BEGIN
  SELECT
    sale.origin,
    sale.currency_conversion_applied
  INTO v_origin, v_conversion_applied
  FROM public.sales AS sale
  WHERE sale.id = NEW.sale_id
    AND sale.workspace_id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found for sales exchange snapshot';
  END IF;

  IF COALESCE(v_origin, 'pos') = 'pos' AND NOT COALESCE(v_conversion_applied, true) THEN
    RAISE EXCEPTION 'Currency conversion is disabled for this workspace; exchange snapshots are not allowed';
  END IF;

  RETURN NEW;
END;
$function$;

-- Keep the staff minimum-selling-price guard effective when a line price is
-- entered in another currency. The POS sends the equivalent product-currency
-- price alongside the immutable conversion snapshot.
DO $patch_pos_override_minimum_price$
DECLARE
  function_definition text;
  unit_price_pattern text := $pattern$'effective_selling_price',[[:space:]]*item\.value->>'unit_price',$pattern$;
  converted_unit_price text := $replacement$'effective_selling_price', COALESCE(item.value->'metadata'->'posPriceCurrencyOverride'->>'validationPriceInProductCurrency', item.value->>'unit_price'),$replacement$;
  currency_filter_pattern text := $pattern$WHERE[[:space:]]+lower\(COALESCE\(item\.value->>'original_currency',[[:space:]]*'usd'\)\)[[:space:]]*=[[:space:]]*lower\(product\.currency::text\);$pattern$;
  override_currency_filter text := $override$
  WHERE lower(COALESCE(item.value->>'original_currency', 'usd'))
      = lower(product.currency::text)
     OR (
       item.value->'metadata'->'posPriceCurrencyOverride' IS NOT NULL
       AND lower(COALESCE(item.value->'metadata'->'posPriceCurrencyOverride'->>'selectedCurrency', ''))
         = lower(COALESCE(item.value->>'original_currency', ''))
     );$override$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('public.complete_sale(jsonb)'::regprocedure)
  INTO function_definition;
  function_definition := pg_catalog.replace(function_definition, E'\r\n', E'\n');

  IF pg_catalog.strpos(function_definition, converted_unit_price) > 0
    AND pg_catalog.strpos(function_definition, 'posPriceCurrencyOverride''->>''selectedCurrency') > 0 THEN
    RETURN;
  END IF;

  function_definition := pg_catalog.regexp_replace(
    function_definition,
    unit_price_pattern,
    converted_unit_price,
    'g'
  );
  function_definition := pg_catalog.regexp_replace(
    function_definition,
    currency_filter_pattern,
    override_currency_filter,
    'g'
  );

  IF pg_catalog.strpos(function_definition, converted_unit_price) = 0
    OR pg_catalog.strpos(function_definition, override_currency_filter) = 0 THEN
    RAISE EXCEPTION 'complete_sale minimum-price validation could not be patched for POS currency overrides';
  END IF;
  EXECUTE function_definition;
END;
$patch_pos_override_minimum_price$;

GRANT EXECUTE ON FUNCTION public.capture_pos_currency_conversion_policy() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_pos_sale_item_currency_policy() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_pos_sales_exchange_policy() TO authenticated, service_role;
