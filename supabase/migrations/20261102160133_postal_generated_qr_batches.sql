-- Generated identities use the existing atlas:postal:v1 payload. Once claimed,
-- the identity is the shipment's normal immutable QR identity.
CREATE TABLE public.postal_qr_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  organization_id uuid,
  active boolean NOT NULL DEFAULT true,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES public.postal_organizations(workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.postal_generated_qrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  claimant_name text,
  claimed_organization_id uuid,
  organization_name text,
  shipment_id uuid UNIQUE,
  shipment_number bigint,
  shipment_created_at timestamptz,
  FOREIGN KEY(workspace_id,batch_id) REFERENCES public.postal_qr_batches(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,claimed_organization_id) REFERENCES public.postal_organizations(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,shipment_id,claimed_organization_id) REFERENCES public.postal_shipments(workspace_id,id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT postal_qr_complete_claim CHECK (
    (claimed_at IS NULL AND claimed_by IS NULL AND claimant_name IS NULL AND claimed_organization_id IS NULL
      AND organization_name IS NULL AND shipment_id IS NULL AND shipment_number IS NULL AND shipment_created_at IS NULL)
    OR (claimed_at IS NOT NULL AND claimed_by IS NOT NULL AND claimant_name IS NOT NULL AND claimed_organization_id IS NOT NULL
      AND organization_name IS NOT NULL AND shipment_id IS NOT NULL AND shipment_number IS NOT NULL AND shipment_created_at IS NOT NULL)
  )
);
CREATE INDEX postal_qr_batches_page ON public.postal_qr_batches(workspace_id,created_at DESC,id DESC);
CREATE INDEX postal_qr_batches_organization ON public.postal_qr_batches(workspace_id,organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX postal_qr_batches_creator ON public.postal_qr_batches(created_by);
CREATE INDEX postal_generated_qrs_page ON public.postal_generated_qrs(workspace_id,batch_id,id);
CREATE INDEX postal_generated_qrs_claimed ON public.postal_generated_qrs(batch_id) WHERE claimed_at IS NOT NULL;
CREATE INDEX postal_generated_qrs_claimant ON public.postal_generated_qrs(claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX postal_generated_qrs_organization ON public.postal_generated_qrs(workspace_id,claimed_organization_id) WHERE claimed_organization_id IS NOT NULL;
ALTER TABLE public.postal_qr_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.postal_generated_qrs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_qr_batches, public.postal_generated_qrs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.postal_qr_batches, public.postal_generated_qrs TO authenticated;
GRANT ALL ON public.postal_qr_batches, public.postal_generated_qrs TO service_role;
CREATE POLICY postal_qr_batches_admin_read ON public.postal_qr_batches FOR SELECT TO authenticated
  USING(workspace_id=public.current_workspace_id() AND postal_private.access_role(workspace_id)='admin');
CREATE POLICY postal_generated_qrs_admin_read ON public.postal_generated_qrs FOR SELECT TO authenticated
  USING(workspace_id=public.current_workspace_id() AND postal_private.access_role(workspace_id)='admin');

CREATE VIEW public.postal_qr_batch_summaries WITH (security_invoker=true) AS
SELECT b.*, o.name AS organization_name,
  (SELECT count(*) FROM public.postal_generated_qrs q WHERE q.batch_id=b.id AND q.claimed_at IS NOT NULL) AS claimed_count
FROM public.postal_qr_batches b
LEFT JOIN public.postal_organizations o ON o.workspace_id=b.workspace_id AND o.id=b.organization_id;
REVOKE ALL ON public.postal_qr_batch_summaries FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.postal_qr_batch_summaries TO authenticated,service_role;

CREATE FUNCTION postal_private.protect_generated_qr() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.claimed_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.postal_shipments WHERE qr_id=NEW.id) THEN
      RAISE EXCEPTION 'postal_qr_identity_conflict';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'postal_qr_claim_is_immutable'; END IF;
  IF TG_OP='DELETE' THEN
    -- Only a whole, never-claimed batch can remove its identities via FK cascade.
    IF EXISTS(SELECT 1 FROM public.postal_qr_batches WHERE id=OLD.batch_id) THEN
      RAISE EXCEPTION 'postal_qr_requires_batch';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.batch_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.batch_id,OLD.created_at) THEN
    RAISE EXCEPTION 'postal_identity_is_immutable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.postal_shipments s WHERE s.id=NEW.shipment_id AND s.qr_id=NEW.id
    AND s.workspace_id=NEW.workspace_id AND s.organization_id=NEW.claimed_organization_id) THEN
    RAISE EXCEPTION 'postal_qr_invalid_claim';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postal_generated_qr_integrity BEFORE INSERT OR UPDATE OR DELETE ON public.postal_generated_qrs
FOR EACH ROW EXECUTE FUNCTION postal_private.protect_generated_qr();

CREATE FUNCTION postal_private.protect_qr_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM public.postal_generated_qrs WHERE batch_id=OLD.id AND claimed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'postal_qr_batch_has_claims';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.organization_id,NEW.quantity,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.organization_id,OLD.quantity,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'postal_identity_is_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postal_qr_batch_integrity BEFORE UPDATE OR DELETE ON public.postal_qr_batches
FOR EACH ROW EXECUTE FUNCTION postal_private.protect_qr_batch();

CREATE FUNCTION postal_private.validate_generated_qr(p_workspace_id uuid,p_qr_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b public.postal_qr_batches; q public.postal_generated_qrs; org uuid; parent uuid;
BEGIN
  IF auth.uid() IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR postal_private.access_role(p_workspace_id) IS DISTINCT FROM 'merchant' THEN
    RAISE EXCEPTION 'postal_qr_not_authorized' USING ERRCODE='42501';
  END IF;
  SELECT organization_id INTO org FROM public.postal_memberships
    WHERE workspace_id=p_workspace_id AND user_id=auth.uid() FOR SHARE;
  SELECT batch_id INTO parent FROM public.postal_generated_qrs WHERE id=p_qr_id AND workspace_id=p_workspace_id;
  IF parent IS NULL THEN RAISE EXCEPTION 'postal_qr_unknown'; END IF;
  -- Lock order is batch then QR. SHARE allows claims of different codes in a
  -- batch concurrently, while excluding activation changes and deletion.
  SELECT * INTO b FROM public.postal_qr_batches WHERE id=parent AND workspace_id=p_workspace_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'postal_qr_unknown'; END IF;
  SELECT * INTO q FROM public.postal_generated_qrs WHERE id=p_qr_id AND workspace_id=p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'postal_qr_unknown'; END IF;
  IF q.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'postal_qr_already_claimed'; END IF;
  IF NOT b.active THEN RAISE EXCEPTION 'postal_qr_inactive'; END IF;
  IF org IS NULL OR (b.organization_id IS NOT NULL AND b.organization_id<>org) THEN
    RAISE EXCEPTION 'postal_qr_organization_restricted' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('id',q.id,'batch_id',q.batch_id,'workspace_id',q.workspace_id);
END $$;
CREATE FUNCTION public.postal_validate_generated_qr(p_workspace_id uuid,p_qr_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
  SELECT postal_private.validate_generated_qr(p_workspace_id,p_qr_id)
$$;

CREATE FUNCTION postal_private.creation_qr(w uuid,org uuid,p_payload jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE qr uuid;
BEGIN
  IF NOT p_payload ? 'generated_qr_id' THEN RETURN gen_random_uuid(); END IF;
  BEGIN qr := (p_payload->>'generated_qr_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'postal_qr_unknown'; END;
  PERFORM postal_private.validate_generated_qr(w,qr);
  IF NOT EXISTS(SELECT 1 FROM public.postal_memberships WHERE workspace_id=w AND organization_id=org AND user_id=auth.uid()) THEN
    RAISE EXCEPTION 'postal_qr_organization_restricted' USING ERRCODE='42501';
  END IF;
  RETURN qr;
END $$;

CREATE FUNCTION postal_private.record_generated_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.postal_generated_qrs WHERE id=NEW.qr_id) THEN
    PERFORM postal_private.validate_generated_qr(NEW.workspace_id,NEW.qr_id);
    IF NOT EXISTS(SELECT 1 FROM public.postal_memberships
      WHERE workspace_id=NEW.workspace_id AND organization_id=NEW.organization_id AND user_id=auth.uid()) THEN
      RAISE EXCEPTION 'postal_qr_organization_restricted' USING ERRCODE='42501';
    END IF;
    UPDATE public.postal_generated_qrs q SET claimed_at=now(),claimed_by=auth.uid(),
      claimant_name=(SELECT COALESCE(name,'') FROM public.profiles WHERE id=auth.uid()),
      claimed_organization_id=NEW.organization_id,
      organization_name=(SELECT name FROM public.postal_organizations WHERE id=NEW.organization_id),
      shipment_id=NEW.id,shipment_number=NEW.shipment_number,shipment_created_at=NEW.created_at
    WHERE q.id=NEW.qr_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postal_shipment_generated_claim AFTER INSERT ON public.postal_shipments
FOR EACH ROW EXECUTE FUNCTION postal_private.record_generated_claim();

-- Extend the existing shipment command in place. Its validation, events,
-- tariff handling and idempotent replay continue to run in the same transaction.
DO $$
DECLARE source text; updated text;
BEGIN
  SELECT prosrc INTO source FROM pg_proc WHERE oid='postal_private.command(text,jsonb,uuid)'::regprocedure;
  updated := replace(source,
    'INSERT INTO public.postal_shipments(workspace_id,organization_id,recipient_name',
    'INSERT INTO public.postal_shipments(qr_id,workspace_id,organization_id,recipient_name');
  IF updated=source THEN RAISE EXCEPTION 'Could not extend postal shipment QR columns'; END IF;
  source := updated;
  updated := replace(source,'VALUES(w,org,btrim(p_payload->>''recipient_name'')',
    'VALUES(postal_private.creation_qr(w,org,p_payload),w,org,btrim(p_payload->>''recipient_name'')');
  IF updated=source THEN RAISE EXCEPTION 'Could not extend postal shipment QR identity'; END IF;
  EXECUTE format($ddl$CREATE OR REPLACE FUNCTION postal_private.command(p_command text,p_payload jsonb,p_request_id uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS %L$ddl$,updated);
END $$;

CREATE FUNCTION postal_private.qr_batch_command(p_command text,p_payload jsonb,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=public.current_workspace_id(); actor uuid:=auth.uid(); cached postal_private.requests;
  b public.postal_qr_batches; result jsonb; quantity integer; org uuid; before_data jsonb;
BEGIN
  IF actor IS NULL OR postal_private.access_role(w) IS DISTINCT FROM 'admin' OR p_request_id IS NULL
    OR (p_payload->>'workspace_id')::uuid IS DISTINCT FROM w THEN
    RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text||actor::text||p_request_id::text,0));
  SELECT * INTO cached FROM postal_private.requests WHERE workspace_id=w AND actor_id=actor AND request_id=p_request_id;
  IF FOUND THEN
    IF cached.command<>p_command OR cached.payload<>p_payload THEN RAISE EXCEPTION 'postal_request_conflict'; END IF;
    RETURN cached.response;
  END IF;
  IF p_command='generate_qr_batch' THEN
    IF jsonb_typeof(p_payload->'quantity') IS DISTINCT FROM 'number' OR (p_payload->>'quantity') !~ '^[0-9]{1,5}$' THEN
      RAISE EXCEPTION 'postal_qr_invalid_quantity';
    END IF;
    quantity:=(p_payload->>'quantity')::integer;
    IF quantity NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'postal_qr_invalid_quantity'; END IF;
    org:=NULLIF(p_payload->>'organization_id','')::uuid;
    IF org IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.postal_organizations WHERE workspace_id=w AND id=org) THEN
      RAISE EXCEPTION 'postal_invalid_organization';
    END IF;
    INSERT INTO public.postal_qr_batches(workspace_id,organization_id,quantity,created_by)
      VALUES(w,org,quantity,actor) RETURNING * INTO b;
    INSERT INTO public.postal_generated_qrs(workspace_id,batch_id) SELECT w,b.id FROM generate_series(1,quantity);
    result:=to_jsonb(b);
  ELSIF p_command IN ('set_qr_batch_active','delete_qr_batch') THEN
    SELECT * INTO b FROM public.postal_qr_batches WHERE workspace_id=w AND id=(p_payload->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'postal_qr_unknown'; END IF;
    before_data:=to_jsonb(b);
    IF p_command='delete_qr_batch' THEN
      DELETE FROM public.postal_qr_batches WHERE id=b.id;
      result:=jsonb_build_object('id',b.id,'deleted',true);
    ELSE
      IF jsonb_typeof(p_payload->'active') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'postal_invalid_result'; END IF;
      UPDATE public.postal_qr_batches SET active=(p_payload->>'active')::boolean,updated_at=now() WHERE id=b.id RETURNING * INTO b;
      result:=to_jsonb(b);
    END IF;
  ELSE RAISE EXCEPTION 'postal_invalid_command'; END IF;
  INSERT INTO public.postal_admin_audit(workspace_id,actor_id,action,entity_id,before_data,after_data)
    VALUES(w,actor,p_command,b.id,before_data,result);
  INSERT INTO postal_private.requests VALUES(w,actor,p_request_id,p_command,p_payload,result);
  RETURN result;
END $$;
-- Preserve the existing public entry point and tariff setup.
DO $$
DECLARE source text; updated text;
BEGIN
  SELECT prosrc INTO source FROM pg_proc WHERE oid='public.postal_command(text,jsonb,uuid)'::regprocedure;
  updated:=replace(source,'RETURN postal_private.command(p_command,p_payload,p_request_id);',
    $code$IF p_command IN ('generate_qr_batch','set_qr_batch_active','delete_qr_batch') THEN
      RETURN postal_private.qr_batch_command(p_command,p_payload,p_request_id);
    END IF;
    RETURN postal_private.command(p_command,p_payload,p_request_id);$code$);
  IF updated=source THEN RAISE EXCEPTION 'Could not extend postal public command'; END IF;
  EXECUTE format($ddl$CREATE OR REPLACE FUNCTION public.postal_command(p_command text,p_payload jsonb,p_request_id uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS %L$ddl$,updated);
END $$;

REVOKE ALL ON FUNCTION postal_private.protect_generated_qr(),postal_private.protect_qr_batch(),
  postal_private.creation_qr(uuid,uuid,jsonb),postal_private.record_generated_claim(),
  postal_private.validate_generated_qr(uuid,uuid),postal_private.qr_batch_command(text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION postal_private.validate_generated_qr(uuid,uuid),postal_private.qr_batch_command(text,jsonb,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.postal_validate_generated_qr(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.postal_validate_generated_qr(uuid,uuid) TO authenticated;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.postal_qr_batches,public.postal_generated_qrs;
  END IF;
END $$;
