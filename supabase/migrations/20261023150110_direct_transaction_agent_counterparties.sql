-- Counterparty reads and validation share the existing workspace/module/permission boundary.
CREATE OR REPLACE FUNCTION private.direct_transaction_access(p_workspace_id uuid, p_module text, p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND p_workspace_id = public.current_workspace_id()
    AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id=p_workspace_id AND w.deleted_at IS NULL
      AND public.workspace_module_allowed(w.id,w.plan::text,p_module)
      AND (public.current_user_role()='admin'
        OR NOT public.workspace_capability_allowed(w.id,w.plan::text,'workspaceManagementPermissions')
        OR private.current_user_has_workspace_permission(w.id,p_permission)));
$$;
REVOKE ALL ON FUNCTION private.direct_transaction_access(uuid,text,text) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.direct_transaction_access(uuid,text,text) TO authenticated;

-- Historical identity can outlive an Agent's active status or a partner's soft deletion.
-- The same group memberships still protect that identity.
CREATE OR REPLACE FUNCTION private.direct_transaction_partner_visible(p_workspace_id uuid, p_partner_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND p_workspace_id=public.current_workspace_id()
    AND EXISTS (SELECT 1 FROM crm.business_partners p WHERE p.id=p_partner_id AND p.workspace_id=p_workspace_id)
    AND (public.current_user_role()='admin'
      OR COALESCE(public.workspace_get_override_value(p_workspace_id,'capability','businessPartnerGroupPrivacy'),'revoke')<>'grant'
      OR EXISTS (
        SELECT 1 FROM crm.business_partner_group_partners a
        JOIN crm.business_partner_groups g ON g.id=a.group_id AND g.workspace_id=a.workspace_id
        WHERE a.workspace_id=p_workspace_id AND a.business_partner_id=p_partner_id AND NOT a.is_deleted AND NOT g.is_deleted
          AND (EXISTS (SELECT 1 FROM crm.business_partner_group_users u WHERE u.workspace_id=p_workspace_id
            AND u.group_id=g.id AND u.user_id=auth.uid() AND NOT u.is_deleted)
          OR (g.access_type='non_grouped' AND NOT EXISTS (
            SELECT 1 FROM crm.business_partner_group_users u JOIN crm.business_partner_groups ug
              ON ug.id=u.group_id AND ug.workspace_id=u.workspace_id
            WHERE u.workspace_id=p_workspace_id AND u.user_id=auth.uid() AND NOT u.is_deleted AND NOT ug.is_deleted)))));
$$;
REVOKE ALL ON FUNCTION private.direct_transaction_partner_visible(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.direct_transaction_partner_visible(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION private.direct_transaction_counterparties_page(
  p_workspace_id uuid, p_scope text, p_search text, p_page integer, p_page_size integer, p_selected_partner_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb; v_pattern text;
BEGIN
  IF NOT private.direct_transaction_access(p_workspace_id,'direct_transactions','directTransaction.access') THEN
    RAISE EXCEPTION 'direct_transaction_access_denied' USING ERRCODE='42501';
  END IF;
  IF p_scope NOT IN ('all','partners','agents') THEN RAISE EXCEPTION 'invalid_counterparty_scope'; END IF;
  v_pattern := '%' || replace(replace(replace(btrim(p_search), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  WITH matching AS MATERIALIZED (
    SELECT p, a, c FROM crm.business_partners p
    LEFT JOIN crm.agents a ON a.id=p.agent_facet_id AND a.business_partner_id=p.id AND a.workspace_id=p.workspace_id
    LEFT JOIN crm.agent_types c ON c.id=a.custom_agent_type_id AND c.workspace_id=a.workspace_id AND NOT c.is_deleted
    WHERE p.workspace_id=p_workspace_id AND NOT p.is_deleted AND p.merged_into_business_partner_id IS NULL
      AND (p_selected_partner_id IS NULL OR p.id=p_selected_partner_id)
      AND crm.can_access_business_partner(p_workspace_id,p.id,CASE WHEN p.role='supplier' THEN 'supplier' ELSE 'customer' END)
      AND ((p_scope IN ('all','agents') AND p.role='agent' AND NOT a.is_deleted AND a.status='active'
        AND private.direct_transaction_access(p_workspace_id,'agents','agents.access'))
      OR (p_scope IN ('all','partners') AND p.role IN ('customer','supplier','both','online_customer')
        AND private.direct_transaction_access(p_workspace_id,'business_partners','businessPartners.access')))
      AND (nullif(btrim(p_search),'') IS NULL OR p.partner_name ILIKE v_pattern ESCAPE E'\\'
        OR p.phone ILIKE v_pattern ESCAPE E'\\' OR p.city ILIKE v_pattern ESCAPE E'\\'
        OR (p.role='agent' AND (a.zone ILIKE v_pattern ESCAPE E'\\' OR a.agent_type ILIKE v_pattern ESCAPE E'\\'
          OR c.name ILIKE v_pattern ESCAPE E'\\')))
  ), page AS (
    SELECT * FROM matching ORDER BY (p).partner_name COLLATE "C", (p).id
    LIMIT LEAST(100,GREATEST(1,p_page_size)) OFFSET (GREATEST(1,p_page)::bigint-1)*LEAST(100,GREATEST(1,p_page_size))
  ) SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'partner',to_jsonb(p),'agent',CASE WHEN (p).role='agent' THEN to_jsonb(a) ELSE NULL END,
      'customType',to_jsonb(c)) ORDER BY (p).partner_name COLLATE "C", (p).id) FROM page),'[]'::jsonb),
    'totalCount',(SELECT count(*) FROM matching)) INTO v_result;
  RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION private.direct_transaction_counterparties_page(uuid,text,text,integer,integer,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.direct_transaction_counterparties_page(uuid,text,text,integer,integer,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION crm.list_direct_transaction_counterparties_page(
  p_workspace_id uuid, p_scope text DEFAULT 'all', p_search text DEFAULT NULL, p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20, p_selected_partner_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.direct_transaction_counterparties_page(p_workspace_id,p_scope,p_search,p_page,p_page_size,p_selected_partner_id);
$$;
REVOKE ALL ON FUNCTION crm.list_direct_transaction_counterparties_page(uuid,text,text,integer,integer,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.list_direct_transaction_counterparties_page(uuid,text,text,integer,integer,uuid) TO authenticated;

CREATE INDEX IF NOT EXISTS payment_transactions_direct_page_idx ON public.payment_transactions
  (workspace_id,paid_at DESC,created_at DESC,id DESC) WHERE source_type='direct_transaction' AND NOT is_deleted AND void_id IS NULL;
CREATE INDEX IF NOT EXISTS agents_direct_active_partner_idx ON crm.agents(workspace_id,business_partner_id,id)
  WHERE status='active' AND NOT is_deleted;

CREATE OR REPLACE FUNCTION private.direct_transactions_page(
  p_workspace_id uuid, p_search text, p_direction text, p_start timestamptz, p_end timestamptz, p_page integer, p_page_size integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb; v_pattern text;
BEGIN
  IF NOT private.direct_transaction_access(p_workspace_id,'direct_transactions','directTransaction.access') THEN
    RAISE EXCEPTION 'direct_transaction_access_denied' USING ERRCODE='42501';
  END IF;
  v_pattern := '%' || replace(replace(replace(btrim(p_search), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  WITH matching AS MATERIALIZED (
    SELECT t.* FROM public.payment_transactions t
    WHERE t.workspace_id=p_workspace_id AND t.source_type='direct_transaction' AND NOT t.is_deleted AND t.void_id IS NULL
      AND (nullif(t.metadata->>'businessPartnerId','') IS NULL OR private.direct_transaction_partner_visible(p_workspace_id,(t.metadata->>'businessPartnerId')::uuid))
      AND (p_direction='all' OR t.direction=p_direction) AND (p_start IS NULL OR t.paid_at>=p_start) AND (p_end IS NULL OR t.paid_at<p_end)
      AND (nullif(btrim(p_search),'') IS NULL OR t.reference_label ILIKE v_pattern ESCAPE E'\\'
        OR t.counterparty_name ILIKE v_pattern ESCAPE E'\\' OR t.note ILIKE v_pattern ESCAPE E'\\'
        OR t.payment_method ILIKE v_pattern ESCAPE E'\\'
        OR (CASE WHEN t.voucher_number IS NULL THEN t.id::text ELSE 'DT-'||lpad(t.voucher_number::text,GREATEST(6,length(t.voucher_number::text)),'0') END) ILIKE v_pattern ESCAPE E'\\')
  ), page AS (
    SELECT * FROM matching ORDER BY paid_at DESC,created_at DESC,id DESC
    LIMIT LEAST(100,GREATEST(1,p_page_size)) OFFSET (GREATEST(1,p_page)::bigint-1)*LEAST(100,GREATEST(1,p_page_size))
  ) SELECT jsonb_build_object('totalCount',(SELECT count(*) FROM matching),'items',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('transaction',to_jsonb(p),'reversedAmount',r.amount,
      'counterpartyKind',COALESCE(p.metadata->>'counterpartyKind',CASE WHEN bp.role='agent' THEN 'agent'
        WHEN nullif(p.metadata->>'businessPartnerId','') IS NOT NULL THEN 'business_partner' ELSE 'external' END),
      'canReverse',p.reversal_of_transaction_id IS NULL AND p.amount-r.amount>0.000001
        AND NOT EXISTS (SELECT 1 FROM public.payment_transactions newer WHERE newer.workspace_id=p_workspace_id
          AND newer.source_type='direct_transaction' AND newer.source_record_id=p.source_record_id
          AND newer.source_subrecord_id IS NOT DISTINCT FROM p.source_subrecord_id
          AND newer.reversal_of_transaction_id IS NULL AND NOT newer.is_deleted AND newer.void_id IS NULL
          AND (newer.paid_at,newer.created_at,newer.id)>(p.paid_at,p.created_at,p.id)
          AND newer.amount>(SELECT COALESCE(sum(abs(nr.amount)),0) FROM public.payment_transactions nr
            WHERE nr.workspace_id=p_workspace_id AND nr.reversal_of_transaction_id=newer.id AND NOT nr.is_deleted AND nr.void_id IS NULL)))
      ORDER BY p.paid_at DESC,p.created_at DESC,p.id DESC)
    FROM page p LEFT JOIN crm.business_partners bp ON bp.workspace_id=p_workspace_id AND bp.id::text=p.metadata->>'businessPartnerId'
    CROSS JOIN LATERAL (SELECT COALESCE(sum(abs(rt.amount)),0) AS amount FROM public.payment_transactions rt
      WHERE rt.workspace_id=p_workspace_id AND rt.reversal_of_transaction_id=p.id AND NOT rt.is_deleted AND rt.void_id IS NULL) r
  ),'[]'::jsonb)) INTO v_result;
  RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION private.direct_transactions_page(uuid,text,text,timestamptz,timestamptz,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.direct_transactions_page(uuid,text,text,timestamptz,timestamptz,integer,integer) TO authenticated;
CREATE OR REPLACE FUNCTION crm.list_direct_transactions_page(p_workspace_id uuid,p_search text DEFAULT NULL,p_direction text DEFAULT 'all',
  p_start timestamptz DEFAULT NULL,p_end timestamptz DEFAULT NULL,p_page integer DEFAULT 1,p_page_size integer DEFAULT 20)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT private.direct_transactions_page(p_workspace_id,p_search,p_direction,p_start,p_end,p_page,p_page_size);
$$;
REVOKE ALL ON FUNCTION crm.list_direct_transactions_page(uuid,text,text,timestamptz,timestamptz,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION crm.list_direct_transactions_page(uuid,text,text,timestamptz,timestamptz,integer,integer) TO authenticated;

CREATE OR REPLACE FUNCTION private.validate_direct_transaction_counterparty()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p crm.business_partners; a crm.agents; original public.payment_transactions; existing public.payment_transactions;
  partner_id uuid; effect text; reversed numeric; custom_name text;
BEGIN
  IF NEW.source_type<>'direct_transaction' AND (TG_OP='INSERT' OR OLD.source_type<>'direct_transaction') THEN RETURN NEW; END IF;
  -- Lifecycle changes (void/offline acknowledgement) never revalidate a retired identity.
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.source_module,NEW.source_type,NEW.source_record_id,NEW.source_subrecord_id,NEW.direction,NEW.amount,
      NEW.currency,NEW.payment_method,NEW.paid_at,NEW.account_id,NEW.reversal_of_transaction_id,NEW.counterparty_name,
      NEW.metadata->>'businessPartnerId',NEW.metadata->>'partnerAccountEffect',NEW.metadata->>'agentId',NEW.metadata->>'counterpartyKind',
      NEW.metadata->>'agentTypeSnapshot',NEW.metadata->>'customAgentTypeNameSnapshot',NEW.reference_label,NEW.note)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.source_module,OLD.source_type,OLD.source_record_id,OLD.source_subrecord_id,OLD.direction,OLD.amount,
      OLD.currency,OLD.payment_method,OLD.paid_at,OLD.account_id,OLD.reversal_of_transaction_id,OLD.counterparty_name,
      OLD.metadata->>'businessPartnerId',OLD.metadata->>'partnerAccountEffect',OLD.metadata->>'agentId',OLD.metadata->>'counterpartyKind',
      OLD.metadata->>'agentTypeSnapshot',OLD.metadata->>'customAgentTypeNameSnapshot',OLD.reference_label,OLD.note) THEN
      RAISE EXCEPTION 'direct_transaction_immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT private.direct_transaction_access(NEW.workspace_id,'direct_transactions','directTransaction.access') THEN
    RAISE EXCEPTION 'direct_transaction_access_denied' USING ERRCODE='42501';
  END IF;
  IF public.current_user_role() NOT IN ('admin','staff') OR (NEW.created_by IS NOT NULL AND NEW.created_by<>auth.uid()) THEN
    RAISE EXCEPTION 'direct_transaction_access_denied' USING ERRCODE='42501';
  END IF;
  NEW.created_by:=auth.uid();
  SELECT * INTO existing FROM public.payment_transactions WHERE id=NEW.id;
  IF FOUND THEN
    IF ROW(NEW.workspace_id,NEW.source_type,NEW.source_record_id,NEW.source_subrecord_id,NEW.direction,NEW.amount,NEW.currency,
      NEW.payment_method,NEW.paid_at,NEW.account_id,NEW.reversal_of_transaction_id,NEW.reference_label,NEW.note,
      NEW.metadata->>'businessPartnerId',COALESCE(NEW.metadata->>'partnerAccountEffect','none'))
      IS DISTINCT FROM ROW(existing.workspace_id,existing.source_type,existing.source_record_id,existing.source_subrecord_id,existing.direction,
      existing.amount,existing.currency,existing.payment_method,existing.paid_at,existing.account_id,existing.reversal_of_transaction_id,
      existing.reference_label,existing.note,existing.metadata->>'businessPartnerId',COALESCE(existing.metadata->>'partnerAccountEffect','none')) THEN
      RAISE EXCEPTION 'direct_transaction_retry_mismatch' USING ERRCODE='23514';
    END IF;
    NEW.metadata:=existing.metadata; NEW.counterparty_name:=existing.counterparty_name; NEW.voucher_number:=existing.voucher_number;
    RETURN NEW;
  END IF;
  IF NEW.reversal_of_transaction_id IS NOT NULL THEN
    SELECT * INTO original FROM public.payment_transactions WHERE id=NEW.reversal_of_transaction_id AND workspace_id=NEW.workspace_id
      AND source_type='direct_transaction' AND reversal_of_transaction_id IS NULL AND NOT is_deleted AND void_id IS NULL FOR UPDATE;
    IF NOT FOUND OR NEW.amount>=0 OR NEW.currency<>original.currency OR NEW.direction<>original.direction
      OR NEW.source_record_id<>original.source_record_id OR NEW.source_subrecord_id IS DISTINCT FROM original.source_subrecord_id
      OR (nullif(original.metadata->>'businessPartnerId','') IS NOT NULL AND NOT private.direct_transaction_partner_visible(NEW.workspace_id,(original.metadata->>'businessPartnerId')::uuid)) THEN
      RAISE EXCEPTION 'invalid_direct_transaction_reversal' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(abs(t.amount)),0) INTO reversed FROM public.payment_transactions t
      WHERE t.workspace_id=NEW.workspace_id AND t.reversal_of_transaction_id=original.id AND NOT t.is_deleted AND t.void_id IS NULL;
    IF abs(NEW.amount)>original.amount-reversed+0.000001 THEN RAISE EXCEPTION 'invalid_direct_transaction_reversal' USING ERRCODE='23514'; END IF;
    NEW.counterparty_name:=original.counterparty_name;
    NEW.metadata:=COALESCE(original.metadata,'{}'::jsonb)||jsonb_build_object('reversal',true);
    RETURN NEW;
  END IF;
  effect:=COALESCE(NEW.metadata->>'partnerAccountEffect','none');
  IF NEW.amount<=0 OR NEW.amount='NaN'::numeric OR NEW.amount IN ('Infinity'::numeric,'-Infinity'::numeric)
    OR nullif(btrim(NEW.reference_label),'') IS NULL OR NEW.source_module<>'payments'
    OR NEW.payment_method IN ('loan','loan_adjustment') OR effect NOT IN ('none','increase_receivable','decrease_receivable','increase_payable','decrease_payable')
    OR (NEW.direction='outgoing' AND effect NOT IN ('none','increase_receivable','decrease_payable'))
    OR (NEW.direction='incoming' AND effect NOT IN ('none','decrease_receivable','increase_payable')) THEN
    RAISE EXCEPTION 'invalid_direct_transaction' USING ERRCODE='23514';
  END IF;
  partner_id:=nullif(NEW.metadata->>'businessPartnerId','')::uuid;
  IF partner_id IS NULL THEN
    IF NEW.source_subrecord_id IS NOT NULL OR effect<>'none' OR nullif(btrim(NEW.counterparty_name),'') IS NULL
      OR nullif(NEW.metadata->>'agentId','') IS NOT NULL THEN RAISE EXCEPTION 'invalid_direct_transaction_counterparty' USING ERRCODE='23514'; END IF;
    NEW.metadata:=COALESCE(NEW.metadata,'{}'::jsonb)||jsonb_build_object('counterpartyKind','external');
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM crm.business_partners WHERE id=partner_id AND workspace_id=NEW.workspace_id AND NOT is_deleted AND merged_into_business_partner_id IS NULL;
  IF NOT FOUND OR NEW.source_subrecord_id IS DISTINCT FROM partner_id OR NOT crm.can_access_business_partner(NEW.workspace_id,partner_id,'customer') THEN
    RAISE EXCEPTION 'direct_counterparty_unavailable' USING ERRCODE='42501';
  END IF;
  NEW.counterparty_name:=p.partner_name;
  IF p.role='agent' THEN
    SELECT * INTO a FROM crm.agents WHERE id=p.agent_facet_id AND business_partner_id=p.id AND workspace_id=NEW.workspace_id AND NOT is_deleted AND status='active';
    IF NOT FOUND OR NOT private.direct_transaction_access(NEW.workspace_id,'agents','agents.access')
      OR (nullif(NEW.metadata->>'agentId','') IS NOT NULL AND NEW.metadata->>'agentId'<>a.id::text) THEN
      RAISE EXCEPTION 'direct_counterparty_unavailable' USING ERRCODE='42501';
    END IF;
    SELECT name INTO custom_name FROM crm.agent_types WHERE id=a.custom_agent_type_id AND workspace_id=NEW.workspace_id AND NOT is_deleted;
    NEW.metadata:=COALESCE(NEW.metadata,'{}'::jsonb)||jsonb_build_object('counterpartyKind','agent','agentId',a.id,
      'agentTypeSnapshot',a.agent_type,'customAgentTypeNameSnapshot',custom_name);
  ELSE
    IF p.role NOT IN ('customer','supplier','both','online_customer')
      OR NOT private.direct_transaction_access(NEW.workspace_id,'business_partners','businessPartners.access') OR nullif(NEW.metadata->>'agentId','') IS NOT NULL THEN
      RAISE EXCEPTION 'direct_counterparty_unavailable' USING ERRCODE='42501';
    END IF;
    NEW.metadata:=COALESCE(NEW.metadata,'{}'::jsonb)||jsonb_build_object('counterpartyKind','business_partner');
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION private.validate_direct_transaction_counterparty() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER validate_direct_transaction_counterparty BEFORE INSERT OR UPDATE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION private.validate_direct_transaction_counterparty();
