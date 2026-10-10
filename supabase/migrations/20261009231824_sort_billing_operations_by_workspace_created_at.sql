CREATE OR REPLACE FUNCTION public.admin_list_billing_operations(p_search text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, billing
AS $function$
DECLARE
  v_result jsonb;
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'workspace_payment_admin_required' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(
    to_jsonb(row_data)
    ORDER BY row_data.workspace_created_at DESC,
      row_data.created_at DESC,
      row_data.id DESC
  ), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT revision.id, revision.billing_workspace_id, revision.requested_workspace_id,
      owner.name AS billing_workspace_name, requested.name AS workspace_name,
      requested.created_at AS workspace_created_at,
      revision.family_id, revision.parent_revision_id, revision.revision_number,
      revision.base_voucher_code, revision.voucher_code, revision.revision_type,
      revision.billing_mode, revision.snapshot, revision.previous_snapshot,
      revision.reason, revision.payment_transaction_id,
      revision.created_by, revision.created_by_label, revision.created_at,
      live.current_revision_id AS current_live_revision_id,
      (live.current_revision_id = revision.id) AS is_current_live,
      (live.current_revision_id IS NOT NULL AND live_revision.family_id = revision.family_id) AS is_live_family,
      payment.amount::text AS payment_amount, payment.currency AS payment_currency,
      payment.status AS payment_status, payment.paid_at
    FROM billing.admin_billing_revisions AS revision
    JOIN public.workspaces AS owner ON owner.id = revision.billing_workspace_id
    JOIN public.workspaces AS requested ON requested.id = revision.requested_workspace_id
    LEFT JOIN billing.workspace_billing_live_transactions AS live
      ON live.billing_workspace_id = revision.billing_workspace_id
    LEFT JOIN billing.admin_billing_revisions AS live_revision
      ON live_revision.id = live.current_revision_id
    LEFT JOIN LATERAL (
      SELECT payment_row.amount, payment_row.currency,
        payment_row.status, payment_row.paid_at
      FROM billing.payment_transactions AS payment_row
      WHERE payment_row.id = revision.payment_transaction_id
        OR (
          live.current_revision_id = revision.id
          AND revision.payment_transaction_id IS NULL
          AND payment_row.billing_workspace_id = revision.billing_workspace_id
          AND payment_row.status = 'approved'
          AND payment_row.created_at >= revision.created_at
        )
      ORDER BY (payment_row.id = revision.payment_transaction_id) DESC,
        payment_row.created_at DESC
      LIMIT 1
    ) AS payment ON true
    WHERE v_search IS NULL
      OR revision.voucher_code ILIKE '%' || v_search || '%'
      OR revision.base_voucher_code ILIKE '%' || v_search || '%'
      OR requested.name ILIKE '%' || v_search || '%'
      OR requested.id::text ILIKE '%' || v_search || '%'
      OR owner.name ILIKE '%' || v_search || '%'
      OR owner.id::text ILIKE '%' || v_search || '%'
  ) AS row_data;

  RETURN v_result;
END;
$function$;
