CREATE OR REPLACE FUNCTION public.delete_branch_cascade(
  p_source_workspace_id uuid,
  p_branch_workspace_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm, budget, notifications
AS $function$
DECLARE
  v_branch_record public.workspace_branches%ROWTYPE;
  v_table record;
  v_managed_tables text[] := ARRAY[
    'public.sale_items',
    'public.payment_transactions',
    'public.loan_payments',
    'public.loan_installments',
    'notifications.events',
    'notifications.device_tokens',
    'budget.payroll_statuses',
    'budget.dividend_statuses',
    'budget.expense_items',
    'budget.expense_series',
    'budget.budget_allocations',
    'budget.budget_settings',
    'public.marketplace_orders',
    'public.marketplace_order_counters',
    'public.invoices',
    'public.inventory_transfer_transactions',
    'public.reorder_transfer_rules',
    'public.inventory',
    'public.product_discounts',
    'public.category_discounts',
    'crm.sales_orders',
    'crm.purchase_orders',
    'crm.travel_agency_sales',
    'crm.business_partner_merge_candidates',
    'crm.customers',
    'crm.suppliers',
    'crm.business_partners',
    'public.employees',
    'public.workspace_contacts',
    'public.loans',
    'public.sales',
    'public.products',
    'public.categories',
    'public.storages'
  ];
BEGIN
  SELECT *
  INTO v_branch_record
  FROM public.workspace_branches
  WHERE source_workspace_id = p_source_workspace_id
    AND branch_workspace_id = p_branch_workspace_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Branch relationship not found for source % and branch %',
      p_source_workspace_id,
      p_branch_workspace_id;
  END IF;

  DELETE FROM public.sale_items si
  USING public.sales s
  WHERE si.sale_id = s.id
    AND s.workspace_id = p_branch_workspace_id;

  DELETE FROM public.payment_transactions
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.loan_payments
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.loan_installments
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM notifications.events
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM notifications.device_tokens
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM budget.payroll_statuses
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM budget.dividend_statuses
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM budget.expense_items
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM budget.expense_series
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM budget.budget_allocations
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM budget.budget_settings
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.marketplace_orders
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.marketplace_order_counters
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.invoices
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.inventory_transfer_transactions
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.reorder_transfer_rules
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.inventory
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.product_discounts
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.category_discounts
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM crm.sales_orders
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM crm.purchase_orders
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM crm.travel_agency_sales
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM crm.business_partner_merge_candidates
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM crm.customers
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM crm.suppliers
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM crm.business_partners
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.employees
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.workspace_contacts
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.loans
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.sales
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.products
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.categories
  WHERE workspace_id = p_branch_workspace_id;

  DELETE FROM public.storages
  WHERE workspace_id = p_branch_workspace_id;

  FOR v_table IN
    SELECT DISTINCT
      c.table_schema,
      c.table_name
    FROM information_schema.columns c
    WHERE c.column_name = 'workspace_id'
      AND c.table_schema IN ('public', 'crm', 'budget', 'notifications')
      AND (c.table_schema || '.' || c.table_name) <> ALL (
        ARRAY['public.workspaces', 'public.profiles', 'public.workspace_branches'] || v_managed_tables
      )
  LOOP
    EXECUTE format(
      'DELETE FROM %I.%I WHERE workspace_id = $1',
      v_table.table_schema,
      v_table.table_name
    )
    USING p_branch_workspace_id;
  END LOOP;

  DELETE FROM public.workspace_branches
  WHERE id = v_branch_record.id;

  DELETE FROM public.workspaces
  WHERE id = p_branch_workspace_id;

  RETURN jsonb_build_object(
    'success',
    true,
    'source_workspace_id',
    p_source_workspace_id,
    'branch_workspace_id',
    p_branch_workspace_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_branch_cascade(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_branch_cascade(uuid, uuid) TO service_role;
