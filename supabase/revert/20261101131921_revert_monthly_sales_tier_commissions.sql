-- Forward rollback of the monthly sales-tier feature. Applied migrations remain
-- in history; this migration restores the original commission entry points.
SET LOCAL lock_timeout = '10s';

-- Prevent a newly posted monthly earning from racing the empty-history guard.
LOCK TABLE crm.sales_orders, crm.sales_order_agent_assignments,
  public.order_returns, crm.agent_commission_entries,
  crm.agent_product_commission_entries, crm.commission_tier_programs,
  crm.commission_tier_periods, crm.commission_tier_contributions,
  private.commission_tier_jobs IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM crm.commission_tier_contributions)
     OR EXISTS (SELECT 1 FROM crm.agent_product_commission_entries WHERE monthly_period_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Monthly tier rollback requires an explicit earnings reconciliation before removing posted history';
  END IF;
END;
$guard$;

DO $scheduler$
DECLARE job record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    FOR job IN SELECT jobid FROM cron.job WHERE jobname='atlas-monthly-tier-commissions' LOOP
      PERFORM cron.unschedule(job.jobid);
    END LOOP;
  END IF;
END;
$scheduler$;

-- Restore the original public function in place, preserving its OID and grants.
DO $restore_entrypoint$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('private.reconcile_sales_agent_commission_before_monthly_tiers(uuid,uuid)'::regprocedure);
  definition := replace(definition,
    'private.reconcile_sales_agent_commission_before_monthly_tiers(',
    'public.reconcile_sales_agent_commission(');
  EXECUTE definition;
END;
$restore_entrypoint$;

-- Reverse only the added monthly CTEs and recipient predicate. Verify the
-- restored definition against the pre-deployment fingerprint before executing.
DO $restore_summary$
DECLARE definition text;
BEGIN
  definition := replace(pg_get_functiondef(
    'crm.get_orders_list_page_optimized(uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text,text,text,text,boolean,integer,integer,boolean)'::regprocedure), E'\r', '');
  definition := replace(definition,
    $monthly_recipient$SELECT count(*)::integer AS eligible_count FROM unnest(order_row.preview_agent_ids) AS credited(agent_id)
      WHERE (rule.recipient_scope='all_assigned' OR EXISTS(SELECT 1 FROM crm.product_commission_rule_agents recipient WHERE recipient.rule_id=rule.id AND recipient.agent_id=credited.agent_id AND NOT recipient.is_deleted))
      AND NOT private.monthly_tier_line_is_owned(order_row.workspace_id,credited.agent_id,rule.product_id,
        coalesce(nullif(order_row.order_json->>'monthly_commission_at','')::timestamptz,nullif(order_row.order_json->>'actual_delivery_date','')::timestamptz,nullif(order_row.order_json->>'created_at','')::timestamptz))$monthly_recipient$,
    $legacy_recipient$SELECT CASE
        WHEN rule.recipient_scope = 'all_assigned' THEN cardinality(order_row.preview_agent_ids)::integer
        ELSE (
          SELECT COUNT(*)::integer
          FROM crm.product_commission_rule_agents AS recipient
          WHERE recipient.workspace_id = order_row.workspace_id
            AND recipient.rule_id = rule.id
            AND recipient.agent_id = ANY(order_row.preview_agent_ids)
            AND COALESCE(recipient.is_deleted, false) = false
        )
      END AS eligible_count$legacy_recipient$);
  definition := replace(definition,
    $monthly_union$
  product_commission_preview_lines AS (
    SELECT * FROM static_product_commission_preview_lines
    UNION ALL
    SELECT order_row.id,entry.currency,sum(entry.amount),false
    FROM orders_with_preview_agents order_row
    JOIN crm.agent_product_commission_entries entry ON entry.order_id=order_row.id AND entry.workspace_id=order_row.workspace_id
      AND entry.monthly_period_id IS NOT NULL AND NOT entry.is_deleted AND entry.agent_id=ANY(order_row.preview_agent_ids)
    WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(order_row.visible_items,'[]')) visible WHERE coalesce(visible->>'id',visible->>'lineId',visible->>'line_id')=entry.order_item_id)
    GROUP BY order_row.id,entry.currency
  ),
  product_commission_preview_totals AS ($monthly_union$,
    '  product_commission_preview_totals AS (');
  definition := replace(definition,
    '  static_product_commission_preview_lines AS (',
    '  product_commission_preview_lines AS (');
  IF md5(definition) <> 'a473dc56698d546d63386063749ea77c' THEN
    RAISE EXCEPTION 'Order summary changed after monthly-tier deployment; refusing to overwrite unrelated changes';
  END IF;
  EXECUTE definition;
END;
$restore_summary$;

DROP TRIGGER queue_monthly_tier_order ON crm.sales_orders;
DROP TRIGGER capture_monthly_tier_date ON crm.sales_orders;
DROP TRIGGER queue_monthly_tier_assignment ON crm.sales_order_agent_assignments;
DROP TRIGGER queue_monthly_tier_return ON public.order_returns;
DROP TRIGGER aa_guard_monthly_tier_settlement ON crm.agent_commission_entries;

DROP FUNCTION public.publish_monthly_tier_program(uuid,timestamptz);
DROP FUNCTION public.archive_monthly_tier_program(uuid);
DROP FUNCTION public.preview_monthly_tier_commission(uuid,uuid[],timestamptz,text,uuid);
DROP FUNCTION public.finalize_monthly_tier_period(uuid);
DROP FUNCTION public.monthly_tier_queue_status(uuid);
DROP FUNCTION public.retry_monthly_tier_commissions(uuid);
DROP FUNCTION public.get_monthly_tier_statement_page(uuid,integer,integer,integer);

ALTER TABLE crm.agent_product_commission_entries
  DROP CONSTRAINT monthly_commission_provenance,
  DROP COLUMN monthly_program_id,
  DROP COLUMN monthly_period_id,
  DROP COLUMN monthly_level_id,
  DROP COLUMN monthly_generation;
ALTER TABLE crm.sales_orders DROP COLUMN monthly_commission_at;

-- RESTRICT is intentional: unexpected external dependencies must fail safely.
DROP TABLE private.commission_tier_jobs;
DROP TABLE crm.commission_tier_contributions;
DROP TABLE crm.commission_tier_periods;
DROP TABLE crm.commission_tier_programs;

DROP FUNCTION private.process_monthly_tier_jobs(uuid,integer);
DROP FUNCTION private.recalculate_monthly_tier_period(uuid);
DROP FUNCTION private.reconcile_monthly_order_aggregate(uuid);
DROP FUNCTION private.refresh_monthly_tier_order(uuid);
DROP FUNCTION private.ensure_monthly_creator_assignment(uuid);
DROP FUNCTION private.reconcile_monthly_static_details(uuid,uuid);
DROP FUNCTION private.reconcile_sales_agent_commission_before_monthly_tiers(uuid,uuid);
DROP FUNCTION private.monthly_tier_line_is_owned(uuid,uuid,uuid,timestamptz);
DROP FUNCTION private.monthly_tier_program_for_line(uuid,uuid,uuid,timestamptz);
DROP FUNCTION private.monthly_tier_read_agent(uuid,uuid);
DROP FUNCTION private.monthly_tier_allowed(uuid,text);
DROP FUNCTION private.monthly_line_units(jsonb);
DROP FUNCTION private.validate_monthly_tier_program();
DROP FUNCTION private.queue_monthly_tier_order();
DROP FUNCTION private.capture_monthly_tier_date();
DROP FUNCTION private.guard_monthly_tier_settlement();

NOTIFY pgrst, 'reload schema';
