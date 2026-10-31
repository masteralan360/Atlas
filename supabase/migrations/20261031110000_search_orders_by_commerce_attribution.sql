-- Search sales orders by the saved Commerce Operations platform and agent
-- snapshot, while leaving Commerce Operations row access governed by its RLS.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
  v_anchor text := $anchor$
              AND POSITION(normalized.search_term IN LOWER(COALESCE(partner.partner_name, ''))) > 0
          )
        )
      )
  ),
  page_orders AS ($anchor$;
  v_replacement text := $replacement$
              AND POSITION(normalized.search_term IN LOWER(COALESCE(partner.partner_name, ''))) > 0
          )
        )
        OR (
          enriched_orders.order_type = 'sales'
          AND EXISTS (
            SELECT 1
            FROM public.commerce_operations_records AS commerce_record
            WHERE commerce_record.workspace_id = enriched_orders.workspace_id
              AND commerce_record.related_order_id = enriched_orders.id
              AND commerce_record.record_type = 'order_details'
              AND COALESCE(commerce_record.is_deleted, false) = false
              AND (
                POSITION(normalized.search_term IN LOWER(COALESCE(commerce_record.payload ->> 'agentNameSnapshot', ''))) > 0
                OR (
                  LOWER(COALESCE(commerce_record.payload ->> 'channel', '')) = 'social'
                  AND POSITION(normalized.search_term IN LOWER(COALESCE(commerce_record.payload ->> 'platform', ''))) > 0
                )
              )
          )
        )
      )
  ),
  page_orders AS ($replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'crm.get_orders_list_page_optimized(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, text, text, text, text, text, boolean, integer, integer, boolean)'::regprocedure
  )
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');

  IF position('commerce_record.payload' IN v_definition) > 0 THEN
    RETURN;
  END IF;

  v_replaced := replace(v_definition, v_anchor, v_replacement);
  IF v_replaced = v_definition THEN
    RAISE EXCEPTION 'Could not add Commerce Operations attribution to sales order search';
  END IF;

  EXECUTE v_replaced;
END;
$block$;

NOTIFY pgrst, 'reload schema';
