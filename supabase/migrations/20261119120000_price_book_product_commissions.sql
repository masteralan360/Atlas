-- Product commission overrides are scoped to the pricing source used by each
-- sale line. NULL preserves the existing native-price product commission.
ALTER TABLE crm.product_commission_rules
  ADD COLUMN IF NOT EXISTS price_book_id uuid NULL
    REFERENCES public.price_books(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS product_commission_rules_workspace_product_book_idx
  ON crm.product_commission_rules (workspace_id, product_id, price_book_id, effective_from DESC)
  WHERE is_deleted = false;

-- Each pricing source has at most one current rule; older effective-dated
-- revisions remain available to explain historical sales.
WITH ranked AS (
  SELECT
    id,
    effective_from,
    row_number() OVER (
      PARTITION BY workspace_id, product_id, price_book_id
      ORDER BY effective_from DESC, updated_at DESC, id DESC
    ) AS duplicate_rank
  FROM crm.product_commission_rules
  WHERE is_deleted = false AND is_active = true AND effective_to IS NULL
)
UPDATE crm.product_commission_rules AS rule
SET is_active = false,
    effective_to = greatest(clock_timestamp(), ranked.effective_from + interval '1 microsecond'),
    updated_at = clock_timestamp(),
    version = rule.version + 1
FROM ranked
WHERE ranked.id = rule.id AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS product_commission_rules_default_current_unique
  ON crm.product_commission_rules (workspace_id, product_id)
  WHERE price_book_id IS NULL AND is_deleted = false AND is_active = true AND effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_commission_rules_price_book_current_unique
  ON crm.product_commission_rules (workspace_id, product_id, price_book_id)
  WHERE price_book_id IS NOT NULL AND is_deleted = false AND is_active = true AND effective_to IS NULL;

CREATE OR REPLACE FUNCTION private.enforce_product_commission_rule_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND (SELECT auth.uid()) IS NOT NULL THEN
    NEW.created_by := (SELECT auth.uid());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.products AS product
    WHERE product.id = NEW.product_id
      AND product.workspace_id = NEW.workspace_id
      AND COALESCE(product.is_deleted, false) = false
  ) THEN
    RAISE EXCEPTION 'Product commission product must belong to the same workspace' USING ERRCODE = '23514';
  END IF;
  IF NEW.price_book_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.price_books AS book
    WHERE book.id = NEW.price_book_id
      AND book.workspace_id = NEW.workspace_id
      AND COALESCE(book.is_deleted, false) = false
  ) THEN
    RAISE EXCEPTION 'Price Book commission must belong to the same workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- The order reconciler uses the selected Price Book id from the immutable line
-- snapshot. It never infers the source from the selling price.
DO $patch_product_commission_reconciler$
DECLARE
  v_definition text;
  v_original text;
  v_rule_query text := E'      SELECT * INTO v_rule FROM crm.product_commission_rules\n      WHERE workspace_id = v_order.workspace_id AND product_id = v_product_id AND is_deleted = false AND is_active = true\n        AND effective_from <= v_event_at AND (effective_to IS NULL OR v_event_at < effective_to)\n      ORDER BY effective_from DESC LIMIT 1;';
  v_scoped_rule_query text := E'      SELECT * INTO v_rule FROM crm.product_commission_rules\n      WHERE workspace_id = v_order.workspace_id AND product_id = v_product_id AND is_deleted = false AND is_active = true\n        AND (price_book_id = v_price_book_id OR price_book_id IS NULL)\n        AND effective_from <= v_event_at AND (effective_to IS NULL OR v_event_at < effective_to)\n      ORDER BY (price_book_id = v_price_book_id) DESC NULLS LAST, effective_from DESC LIMIT 1;';
  v_product_id_anchor text := '  v_product_id uuid;';
  v_product_id_replacement text := E'  v_product_id uuid;\n  v_price_book_id uuid;';
  v_line_product_anchor text := E'      BEGIN v_product_id := COALESCE(NULLIF(v_line->>''product_id'', '''')::uuid, NULLIF(v_line->>''productId'', '''')::uuid); EXCEPTION WHEN invalid_text_representation THEN CONTINUE; END;';
  v_line_product_replacement text := E'      BEGIN v_product_id := COALESCE(NULLIF(v_line->>''product_id'', '''')::uuid, NULLIF(v_line->>''productId'', '''')::uuid); EXCEPTION WHEN invalid_text_representation THEN CONTINUE; END;\n      BEGIN v_price_book_id := COALESCE(NULLIF(v_line->>''price_book_id'', '''')::uuid, NULLIF(v_line->>''priceBookId'', '''')::uuid); EXCEPTION WHEN invalid_text_representation THEN v_price_book_id := NULL; END;';
BEGIN
  SELECT pg_get_functiondef('private.reconcile_product_sales_agent_commission(uuid, uuid)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  v_original := v_definition;

  IF position('v_price_book_id uuid;' IN v_definition) = 0 THEN
    v_definition := replace(v_definition, v_product_id_anchor, v_product_id_replacement);
    v_definition := replace(v_definition, v_line_product_anchor, v_line_product_replacement);
  END IF;
  IF position(v_rule_query IN v_definition) > 0 THEN
    v_definition := replace(v_definition, v_rule_query, v_scoped_rule_query);
  END IF;
  IF v_definition = v_original
    OR position('v_price_book_id uuid;' IN v_definition) = 0
    OR position('v_line->>''priceBookId''' IN v_definition) = 0
    OR position('price_book_id = v_price_book_id OR price_book_id IS NULL' IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Could not add Price Book commission selection to the server reconciler';
  END IF;
  EXECUTE v_definition;
END;
$patch_product_commission_reconciler$;

-- Keep both server-paged order RPCs aligned with the commission reconciler.
DO $patch_product_commission_previews$
DECLARE
  v_function regprocedure;
  v_definition text;
  v_original text;
  v_rules_cte text := E'  product_commission_rules AS (\n    SELECT DISTINCT ON (rule.workspace_id, rule.product_id)\n      rule.id,\n      rule.workspace_id,\n      rule.product_id,\n      rule.commission_type,\n      rule.rate_percent,\n      rule.fixed_amount,\n      rule.fixed_currency,\n      rule.recipient_scope\n    FROM crm.product_commission_rules AS rule\n    WHERE rule.workspace_id = p_workspace_id\n      AND COALESCE(rule.is_deleted, false) = false\n      AND COALESCE(rule.is_active, false) = true\n      AND rule.effective_from <= now()\n      AND (rule.effective_to IS NULL OR rule.effective_to > now())\n    ORDER BY rule.workspace_id, rule.product_id, rule.effective_from DESC\n  ),';
  v_scoped_rules_cte text := E'  product_commission_rules AS (\n    SELECT DISTINCT ON (rule.workspace_id, rule.product_id, rule.price_book_id)\n      rule.id,\n      rule.workspace_id,\n      rule.product_id,\n      rule.price_book_id,\n      rule.commission_type,\n      rule.rate_percent,\n      rule.fixed_amount,\n      rule.fixed_currency,\n      rule.recipient_scope,\n      rule.effective_from\n    FROM crm.product_commission_rules AS rule\n    WHERE rule.workspace_id = p_workspace_id\n      AND COALESCE(rule.is_deleted, false) = false\n      AND COALESCE(rule.is_active, false) = true\n      AND rule.effective_from <= now()\n      AND (rule.effective_to IS NULL OR rule.effective_to > now())\n    ORDER BY rule.workspace_id, rule.product_id, rule.price_book_id, rule.effective_from DESC\n  ),';
  v_join_anchor text := E'    JOIN product_commission_rules AS rule\n      ON rule.workspace_id = order_row.workspace_id\n      AND rule.product_id = CASE\n        WHEN COALESCE(item.value ->> ''productId'', item.value ->> ''product_id'', '''') ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''\n          THEN COALESCE(item.value ->> ''productId'', item.value ->> ''product_id'')::uuid\n        ELSE NULL\n      END\n      AND cardinality(order_row.preview_agent_ids) > 0';
  v_scoped_join text := E'    JOIN LATERAL (\n      SELECT candidate.*\n      FROM product_commission_rules AS candidate\n      WHERE candidate.workspace_id = order_row.workspace_id\n        AND candidate.product_id = CASE\n          WHEN COALESCE(item.value ->> ''productId'', item.value ->> ''product_id'', '''') ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''\n            THEN COALESCE(item.value ->> ''productId'', item.value ->> ''product_id'')::uuid\n          ELSE NULL\n        END\n        AND (candidate.price_book_id = CASE\n          WHEN COALESCE(item.value ->> ''priceBookId'', item.value ->> ''price_book_id'', '''') ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''\n            THEN COALESCE(item.value ->> ''priceBookId'', item.value ->> ''price_book_id'')::uuid\n          ELSE NULL\n        END OR candidate.price_book_id IS NULL)\n      ORDER BY (candidate.price_book_id = CASE\n        WHEN COALESCE(item.value ->> ''priceBookId'', item.value ->> ''price_book_id'', '''') ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''\n          THEN COALESCE(item.value ->> ''priceBookId'', item.value ->> ''price_book_id'')::uuid\n        ELSE NULL\n      END) DESC NULLS LAST, candidate.effective_from DESC\n      LIMIT 1\n    ) AS rule ON cardinality(order_row.preview_agent_ids) > 0';
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'crm.get_orders_list_page(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, text, text, text, text, text, boolean, integer, integer)'::regprocedure,
    'crm.get_orders_list_page_optimized(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, text, text, text, text, text, boolean, integer, integer, boolean)'::regprocedure
  ]
  LOOP
    SELECT pg_get_functiondef(v_function) INTO v_definition;
    v_definition := replace(v_definition, chr(13), '');
    v_original := v_definition;
    IF position('rule.price_book_id' IN v_definition) = 0 THEN
      v_definition := replace(v_definition, v_rules_cte, v_scoped_rules_cte);
      v_definition := replace(v_definition, v_join_anchor, v_scoped_join);
    END IF;
    IF v_definition = v_original
      OR position('candidate.price_book_id' IN v_definition) = 0
      OR position('rule.price_book_id' IN v_definition) = 0
    THEN
      RAISE EXCEPTION 'Could not add Price Book commission selection to %', v_function;
    END IF;
    EXECUTE v_definition;
  END LOOP;
END;
$patch_product_commission_previews$;

NOTIFY pgrst, 'reload schema';
