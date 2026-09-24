-- READ-ONLY CHECK. Run this file manually in the Supabase SQL Editor to see
-- every active order loan whose linked sales or purchase order is cancelled.
-- This manual check contains no UPDATE, DELETE, or repair statements.
-- It is intentionally safe to rerun after deploying the cancellation fix.

WITH cancelled_orders AS (
  SELECT sales_order.workspace_id, sales_order.id AS order_id,
    sales_order.order_number, sales_order.status AS order_status,
    sales_order.is_deleted AS order_is_deleted,
    sales_order.linked_loan_id, sales_order.business_partner_id,
    sales_order.updated_at AS order_last_updated_at,
    'sales'::text AS order_type
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.status = 'cancelled'
  UNION ALL
  SELECT purchase_order.workspace_id, purchase_order.id,
    purchase_order.order_number, purchase_order.status,
    purchase_order.is_deleted,
    purchase_order.linked_loan_id, purchase_order.business_partner_id,
    purchase_order.updated_at, 'purchase'::text
  FROM crm.purchase_orders AS purchase_order
  WHERE purchase_order.status = 'cancelled'
)
SELECT workspace.id AS workspace_id, workspace.name AS workspace_name,
  cancelled_orders.order_type, cancelled_orders.order_id,
  cancelled_orders.order_number, cancelled_orders.order_status,
  cancelled_orders.order_is_deleted,
  cancelled_orders.order_last_updated_at,
  cancelled_orders.business_partner_id,
  loan.id AS loan_id, loan.loan_no, loan.loan_category,
  loan.status AS loan_status, loan.balance_amount AS loan_balance_amount,
  loan.settlement_currency AS loan_currency,
  CASE
    WHEN cancelled_orders.linked_loan_id = loan.id THEN 'order_still_links_loan'
    WHEN cancelled_orders.linked_loan_id IS NULL THEN 'order_link_cleared'
    ELSE 'order_links_different_loan'
  END AS link_state,
  CASE
    WHEN loan.source = 'order' AND loan.order_type = cancelled_orders.order_type
      AND loan.order_id = cancelled_orders.order_id THEN 'loan_source_matches_order'
    ELSE 'order_link_only'
  END AS match_reason,
  (SELECT COUNT(*) FROM public.loan_payments AS payment
    WHERE payment.loan_id = loan.id AND NOT payment.is_deleted) AS active_loan_payments,
  (SELECT COUNT(*) FROM public.loan_installments AS installment
    WHERE installment.loan_id = loan.id AND NOT installment.is_deleted) AS active_installments
FROM cancelled_orders
JOIN public.loans AS loan
  ON loan.workspace_id = cancelled_orders.workspace_id
 AND ((loan.source = 'order'
   AND loan.order_type = cancelled_orders.order_type
   AND loan.order_id = cancelled_orders.order_id)
   OR loan.id = cancelled_orders.linked_loan_id)
 AND NOT loan.is_deleted
JOIN public.workspaces AS workspace ON workspace.id = cancelled_orders.workspace_id
ORDER BY workspace.name, cancelled_orders.order_type,
  cancelled_orders.order_last_updated_at DESC, cancelled_orders.order_number;
