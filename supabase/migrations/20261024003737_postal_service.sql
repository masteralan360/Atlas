-- Independent Post Service implementation. No retired data or identities are reused.
CREATE SCHEMA IF NOT EXISTS postal_private;
REVOKE ALL ON SCHEMA postal_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA postal_private TO authenticated, service_role;

CREATE TABLE public.postal_locations (
  governorate text NOT NULL, area text NOT NULL,
  PRIMARY KEY (governorate, area)
);
CREATE TABLE public.postal_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8}$'),
  leader_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE TABLE public.postal_memberships (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, organization_id, user_id),
  FOREIGN KEY (workspace_id, organization_id) REFERENCES public.postal_organizations(workspace_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.postal_organizations ADD CONSTRAINT postal_leader_is_member
 FOREIGN KEY (workspace_id,id,leader_id) REFERENCES public.postal_memberships(workspace_id,organization_id,user_id)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.postal_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  governorate text NOT NULL, area text NOT NULL, address text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id), FOREIGN KEY(governorate,area) REFERENCES public.postal_locations
);
CREATE TABLE public.postal_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
  qr_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  recipient_name text NOT NULL CHECK (length(btrim(recipient_name)) BETWEEN 1 AND 160),
  primary_phone text NOT NULL CHECK (primary_phone ~ '^(07[0-9]{9}|7[0-9]{9}|9647[0-9]{9}|009647[0-9]{9})$'),
  backup_phone text NOT NULL CHECK (backup_phone ~ '^(07[0-9]{9}|7[0-9]{9}|9647[0-9]{9}|009647[0-9]{9})$'),
  governorate text NOT NULL, area text NOT NULL,
  address text CHECK(length(address)<=2000), cod_amount bigint NOT NULL CHECK(abs(cod_amount::numeric)<=999999999999),
  pieces integer CHECK(pieces>0), fragile boolean NOT NULL DEFAULT false,
  delivery_notes text CHECK(length(delivery_notes)<=2000),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','received','in_transit','arrived','out_for_delivery','delivered','cancelled')),
  current_branch_id uuid, revision integer NOT NULL DEFAULT 1,
  driver_id uuid REFERENCES crm.agents(id) ON DELETE SET NULL, driver_name text,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(workspace_id,id), UNIQUE(workspace_id,id,organization_id),
  FOREIGN KEY(workspace_id,organization_id) REFERENCES public.postal_organizations(workspace_id,id),
  FOREIGN KEY(governorate,area) REFERENCES public.postal_locations,
  FOREIGN KEY(workspace_id,current_branch_id) REFERENCES public.postal_branches(workspace_id,id)
);
CREATE TABLE public.postal_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, shipment_id uuid NOT NULL,
  origin_id uuid NOT NULL, destination_id uuid NOT NULL CHECK(destination_id<>origin_id),
  origin_name text NOT NULL, destination_name text NOT NULL,
  authorized_by uuid NOT NULL REFERENCES public.profiles(id),
  authorized_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, arrived_at timestamptz,
  status text NOT NULL DEFAULT 'authorized' CHECK(status IN ('authorized','dispatched','arrived','cancelled')),
  FOREIGN KEY(workspace_id,shipment_id) REFERENCES public.postal_shipments(workspace_id,id),
  FOREIGN KEY(workspace_id,origin_id) REFERENCES public.postal_branches(workspace_id,id),
  FOREIGN KEY(workspace_id,destination_id) REFERENCES public.postal_branches(workspace_id,id)
);
CREATE UNIQUE INDEX postal_one_open_transfer ON public.postal_transfers(shipment_id) WHERE status IN ('authorized','dispatched');
CREATE TABLE public.postal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, shipment_id uuid NOT NULL,
  event_type text NOT NULL, previous_state text, resulting_state text NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.profiles(id), actor_name text NOT NULL,
  origin_id uuid, destination_id uuid, notes text, metadata jsonb NOT NULL DEFAULT '{}',
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,shipment_id) REFERENCES public.postal_shipments(workspace_id,id),
  FOREIGN KEY(workspace_id,origin_id) REFERENCES public.postal_branches(workspace_id,id),
  FOREIGN KEY(workspace_id,destination_id) REFERENCES public.postal_branches(workspace_id,id)
);
CREATE TABLE public.postal_cod_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, shipment_id uuid NOT NULL, organization_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('collection','settlement')),
  signed_amount bigint NOT NULL CHECK(signed_amount<>0 AND abs(signed_amount::numeric)<=999999999999),
  payment_transaction_id uuid NOT NULL UNIQUE REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.profiles(id), notes text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,shipment_id,organization_id) REFERENCES public.postal_shipments(workspace_id,id,organization_id)
);
CREATE TABLE postal_private.requests (
  workspace_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL,
  command text NOT NULL, payload jsonb NOT NULL, response jsonb NOT NULL,
  PRIMARY KEY(workspace_id,actor_id,request_id)
);
CREATE TABLE postal_private.registration_permits (
 user_id uuid PRIMARY KEY,email text NOT NULL,enrollment jsonb NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
ALTER TABLE postal_private.registration_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON postal_private.registration_permits FROM PUBLIC,anon,authenticated;
GRANT SELECT,DELETE ON postal_private.registration_permits TO service_role;
CREATE TABLE public.postal_admin_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
 actor_id uuid NOT NULL REFERENCES public.profiles(id),action text NOT NULL,entity_id uuid NOT NULL,
 before_data jsonb,after_data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.postal_admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.postal_admin_audit FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.postal_admin_audit TO authenticated;
GRANT ALL ON public.postal_admin_audit TO service_role;
CREATE INDEX postal_admin_audit_workspace ON public.postal_admin_audit(workspace_id,created_at DESC,id DESC);
CREATE INDEX postal_shipments_page ON public.postal_shipments(workspace_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX postal_shipments_merchant_page ON public.postal_shipments(workspace_id,organization_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX postal_shipments_state_page ON public.postal_shipments(workspace_id,state,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX postal_events_history ON public.postal_events(workspace_id,shipment_id,sequence);
CREATE INDEX postal_transfers_shipment ON public.postal_transfers(workspace_id,shipment_id,authorized_at,id);
CREATE INDEX postal_cod_history ON public.postal_cod_records(workspace_id,organization_id,created_at DESC,id DESC);
CREATE INDEX postal_cod_shipment ON public.postal_cod_records(shipment_id,kind);
CREATE INDEX postal_branches_page ON public.postal_branches(workspace_id,name,id);
CREATE INDEX postal_organizations_page ON public.postal_organizations(workspace_id,name,id);

CREATE FUNCTION postal_private.module_granted(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.workspaces x WHERE x.id=w AND x.deleted_at IS NULL AND x.data_mode IN ('cloud','hybrid'))
 AND EXISTS(SELECT 1 FROM public.workspace_access_overrides o WHERE o.workspace_id=w AND o.type='module' AND o.key='postal_service' AND o.value='grant');
$$;
CREATE FUNCTION postal_private.access_role(w uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN p.role='admin' THEN 'admin'
 WHEN p.role='staff' AND p.workspace_id=w AND EXISTS(SELECT 1 FROM public.workspace_permissions x WHERE x.workspace_id=w AND x.user_uuid=p.id AND x.key='postService.merchant')
  AND EXISTS(SELECT 1 FROM public.postal_memberships m WHERE m.workspace_id=w AND m.user_id=p.id) THEN 'merchant'
 WHEN p.role='staff' AND p.workspace_id=w AND EXISTS(SELECT 1 FROM public.workspace_permissions x WHERE x.workspace_id=w AND x.user_uuid=p.id AND x.key='postService.officeEmployee') THEN 'office'
 END FROM public.profiles p WHERE p.id=auth.uid() AND p.current_workspace=w AND postal_private.module_granted(w);
$$;
CREATE FUNCTION postal_private.can_read(w uuid,org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT COALESCE(postal_private.access_role(w) IN ('admin','office') OR
 (postal_private.access_role(w)='merchant' AND EXISTS(SELECT 1 FROM public.postal_memberships m WHERE m.workspace_id=w AND m.organization_id=org AND m.user_id=auth.uid())),false);
$$;
CREATE FUNCTION postal_private.can_read_shipment(w uuid,s uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.postal_shipments x WHERE x.workspace_id=w AND x.id=s AND postal_private.can_read(w,x.organization_id));
$$;

DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['postal_locations','postal_organizations','postal_memberships','postal_branches','postal_shipments','postal_transfers','postal_events','postal_cod_records'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',n);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated',n);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',n);
 END LOOP;
END $$;
CREATE POLICY postal_locations_read ON public.postal_locations FOR SELECT TO authenticated USING(auth.uid() IS NOT NULL);
CREATE POLICY postal_organizations_read ON public.postal_organizations FOR SELECT TO authenticated USING(postal_private.can_read(workspace_id,id));
CREATE POLICY postal_memberships_read ON public.postal_memberships FOR SELECT TO authenticated USING(postal_private.can_read(workspace_id,organization_id));
CREATE POLICY postal_branches_read ON public.postal_branches FOR SELECT TO authenticated USING(postal_private.access_role(workspace_id) IN ('admin','office'));
CREATE POLICY postal_shipments_read ON public.postal_shipments FOR SELECT TO authenticated USING(postal_private.can_read(workspace_id,organization_id));
CREATE POLICY postal_transfers_read ON public.postal_transfers FOR SELECT TO authenticated USING(postal_private.can_read_shipment(workspace_id,shipment_id));
CREATE POLICY postal_events_read ON public.postal_events FOR SELECT TO authenticated USING(postal_private.can_read_shipment(workspace_id,shipment_id));
CREATE POLICY postal_cod_read ON public.postal_cod_records FOR SELECT TO authenticated USING(postal_private.can_read(workspace_id,organization_id));
CREATE POLICY postal_admin_audit_read ON public.postal_admin_audit FOR SELECT TO authenticated USING(postal_private.access_role(workspace_id)='admin');
-- Post roles are explicit even when the workspace plan does not have general permission management.
CREATE POLICY postal_permissions_read ON public.workspace_permissions FOR SELECT TO authenticated USING(
 module='postService' AND postal_private.module_granted(workspace_id) AND workspace_id=public.current_workspace_id()
 AND (user_uuid=auth.uid() OR public.current_user_role()='admin'));
CREATE POLICY postal_office_permission_insert ON public.workspace_permissions FOR INSERT TO authenticated WITH CHECK(
 key='postService.officeEmployee' AND module='postService' AND postal_private.access_role(workspace_id)='admin'
 AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=user_uuid AND p.workspace_id=workspace_permissions.workspace_id AND p.role='staff'));
CREATE POLICY postal_office_permission_delete ON public.workspace_permissions FOR DELETE TO authenticated USING(
 key='postService.officeEmployee' AND postal_private.access_role(workspace_id)='admin');
CREATE POLICY postal_office_permission_update ON public.workspace_permissions FOR UPDATE TO authenticated
 USING(key='postService.officeEmployee' AND postal_private.access_role(workspace_id)='admin')
 WITH CHECK(key='postService.officeEmployee' AND module='postService' AND postal_private.access_role(workspace_id)='admin'
 AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=user_uuid AND p.workspace_id=workspace_permissions.workspace_id AND p.role='staff'));

-- Deferred checks cover direct permission writes, profile changes and membership writes.
CREATE FUNCTION postal_private.check_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ids uuid[];
BEGIN
 IF TG_TABLE_NAME='workspace_permissions' THEN
  ids:=ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.user_uuid END,CASE WHEN TG_OP<>'DELETE' THEN NEW.user_uuid END];
 ELSIF TG_TABLE_NAME='profiles' THEN
  ids:=ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.id END];
 ELSE
  ids:=ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.user_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.user_id END];
 END IF;
 IF EXISTS(SELECT 1 FROM public.workspace_permissions p LEFT JOIN public.postal_memberships m ON m.user_id=p.user_uuid AND m.workspace_id=p.workspace_id
   JOIN public.profiles u ON u.id=p.user_uuid WHERE p.user_uuid=ANY(ids) AND p.key='postService.merchant' AND (m.user_id IS NULL OR u.role<>'staff' OR u.workspace_id<>p.workspace_id))
 OR EXISTS(SELECT 1 FROM public.postal_memberships m JOIN public.profiles u ON u.id=m.user_id
   WHERE m.user_id=ANY(ids) AND (u.role<>'staff' OR u.workspace_id IS DISTINCT FROM m.workspace_id OR NOT EXISTS(SELECT 1 FROM public.workspace_permissions p WHERE p.user_uuid=m.user_id AND p.workspace_id=m.workspace_id AND p.key='postService.merchant')))
 OR EXISTS(SELECT 1 FROM public.workspace_permissions a JOIN public.workspace_permissions b ON a.workspace_id=b.workspace_id AND a.user_uuid=b.user_uuid
   WHERE a.user_uuid=ANY(ids) AND a.key='postService.merchant' AND b.key='postService.officeEmployee')
 THEN RAISE EXCEPTION 'postal_invalid_membership' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER postal_permission_membership AFTER INSERT OR UPDATE OR DELETE ON public.workspace_permissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION postal_private.check_membership();
CREATE CONSTRAINT TRIGGER postal_member_integrity AFTER INSERT OR UPDATE OR DELETE ON public.postal_memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION postal_private.check_membership();
CREATE CONSTRAINT TRIGGER postal_profile_integrity AFTER UPDATE OR DELETE ON public.profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION postal_private.check_membership();

CREATE FUNCTION postal_private.protect_grant() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF ((TG_OP<>'INSERT' AND OLD.type='module' AND OLD.key='postal_service') OR (TG_OP<>'DELETE' AND NEW.type='module' AND NEW.key='postal_service'))
 AND COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role'),'')<>'service_role'
 THEN RAISE EXCEPTION 'postal_platform_grant_required' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER postal_platform_grant BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_access_overrides FOR EACH ROW EXECUTE FUNCTION postal_private.protect_grant();

-- GoTrue writes app_metadata after INSERT. A service-only, single-use permit
-- binds enrollment to an unguessable Auth user ID and email before that insert.
CREATE FUNCTION postal_private.prepare_registration(p_user_id uuid,p_email text,p_enrollment jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=(p_enrollment->>'workspace_id')::uuid; actor uuid:=(p_enrollment->>'actor_id')::uuid;
BEGIN
 IF p_user_id IS NULL OR p_email IS NULL OR p_enrollment->>'mode' NOT IN ('create','join')
  OR NOT postal_private.module_granted(w) OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=actor AND p.role='admin' AND p.current_workspace=w)
 THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
 DELETE FROM postal_private.registration_permits WHERE expires_at<now();
 INSERT INTO postal_private.registration_permits(user_id,email,enrollment) VALUES(p_user_id,lower(btrim(p_email)),p_enrollment);
END $$;
CREATE FUNCTION public.postal_prepare_registration(p_user_id uuid,p_email text,p_enrollment jsonb) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT postal_private.prepare_registration(p_user_id,p_email,p_enrollment) $$;
CREATE FUNCTION public.postal_cancel_registration(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ DELETE FROM postal_private.registration_permits WHERE user_id=p_user_id $$;
REVOKE ALL ON FUNCTION public.postal_prepare_registration(uuid,text,jsonb),public.postal_cancel_registration(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.postal_prepare_registration(uuid,text,jsonb),public.postal_cancel_registration(uuid) TO service_role;

CREATE FUNCTION postal_private.consume_registration_permit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE permit postal_private.registration_permits; staff_key text;
BEGIN
 DELETE FROM postal_private.registration_permits WHERE user_id=NEW.id AND email=lower(NEW.email) AND expires_at>now() RETURNING * INTO permit;
 IF NOT FOUND THEN
  IF NEW.raw_app_meta_data ? 'postal_enrollment' THEN RAISE EXCEPTION 'postal_registration_permit_required'; END IF;
  RETURN NEW;
 END IF;
 PERFORM 1 FROM public.keys WHERE key_name IN ('admin','staff','viewer') ORDER BY key_name FOR UPDATE;
 SELECT key_value INTO staff_key FROM public.keys WHERE key_name='staff';
 IF staff_key IS NULL THEN RAISE EXCEPTION 'postal_registration_unavailable'; END IF;
 NEW.raw_user_meta_data:=COALESCE(NEW.raw_user_meta_data,'{}')||jsonb_build_object('role','staff','workspace_id',permit.enrollment->>'workspace_id','passkey',staff_key);
 NEW.raw_app_meta_data:=COALESCE(NEW.raw_app_meta_data,'{}')||jsonb_build_object('postal_enrollment',permit.enrollment);
 RETURN NEW;
END $$;
-- This sorts ahead of the existing registration-key guard. Only a valid
-- merchant permit takes this path; the existing guard still validates and rotates its key.
CREATE TRIGGER "000_postal_registration_permit" BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION postal_private.consume_registration_permit();

-- Enrollment and Auth creation commit in one transaction; no orphan records.
CREATE FUNCTION postal_private.enroll_merchant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e jsonb:=NEW.raw_app_meta_data->'postal_enrollment'; w uuid; actor uuid; org uuid; c text; i integer;
BEGIN
 IF e IS NULL THEN RETURN NEW; END IF;
 w:=(e->>'workspace_id')::uuid; actor:=(e->>'actor_id')::uuid;
 IF NOT postal_private.module_granted(w) OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=actor AND p.role='admin' AND p.current_workspace=w)
 THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
 INSERT INTO public.profiles(id,name,role,workspace_id,current_workspace) VALUES(NEW.id,NEW.raw_user_meta_data->>'name','staff',w,w)
 ON CONFLICT(id) DO UPDATE SET role='staff',workspace_id=w,current_workspace=w;
 IF e->>'mode'='create' THEN
  IF length(btrim(COALESCE(e->>'name',''))) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'postal_invalid_organization'; END IF;
  LOOP
   c:='';
   FOR i IN 1..8 LOOP c:=c||substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',1+(get_byte(uuid_send(gen_random_uuid()),0)%32),1); END LOOP;
   BEGIN
    INSERT INTO public.postal_organizations(workspace_id,name,code,leader_id) VALUES(w,btrim(e->>'name'),c,NEW.id) RETURNING id INTO org;
    EXIT;
   EXCEPTION WHEN unique_violation THEN CONTINUE;
   END;
  END LOOP;
 ELSIF e->>'mode'='join' THEN
  c:=upper(replace(btrim(e->>'code'),'-',''));
  SELECT id INTO org FROM public.postal_organizations WHERE workspace_id=w AND code=c FOR UPDATE;
  IF org IS NULL THEN RAISE EXCEPTION 'postal_invalid_organization'; END IF;
 ELSE RAISE EXCEPTION 'postal_invalid_organization'; END IF;
 INSERT INTO public.postal_memberships(user_id,workspace_id,organization_id) VALUES(NEW.id,w,org);
 INSERT INTO public.workspace_permissions(workspace_id,user_uuid,key,module) VALUES(w,NEW.id,'postService.merchant','postService');
 -- Do not retain the temporary key or enrollment transport in Auth metadata,
 -- including installations where the legacy registration guard is not attached.
 UPDATE auth.users SET raw_user_meta_data=COALESCE(raw_user_meta_data,'{}')-'passkey',
  raw_app_meta_data=COALESCE(raw_app_meta_data,'{}')-'postal_enrollment' WHERE id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER zzzz_postal_enroll_merchant AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION postal_private.enroll_merchant();

CREATE FUNCTION postal_private.immutable_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'postal_history_is_immutable' USING ERRCODE='42501'; END $$;
CREATE TRIGGER postal_event_immutable BEFORE UPDATE OR DELETE ON public.postal_events FOR EACH ROW EXECUTE FUNCTION postal_private.immutable_history();
CREATE TRIGGER postal_cod_immutable BEFORE UPDATE OR DELETE ON public.postal_cod_records FOR EACH ROW EXECUTE FUNCTION postal_private.immutable_history();
CREATE TRIGGER postal_admin_audit_immutable BEFORE UPDATE OR DELETE ON public.postal_admin_audit FOR EACH ROW EXECUTE FUNCTION postal_private.immutable_history();
CREATE FUNCTION postal_private.protect_shipment_identity() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF ROW(NEW.id,NEW.qr_id,NEW.workspace_id,NEW.organization_id,NEW.created_by,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.qr_id,OLD.workspace_id,OLD.organization_id,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'postal_identity_is_immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER postal_shipment_identity BEFORE UPDATE ON public.postal_shipments FOR EACH ROW EXECUTE FUNCTION postal_private.protect_shipment_identity();

CREATE FUNCTION postal_private.command(p_command text,p_payload jsonb,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=public.current_workspace_id(); actor uuid:=auth.uid(); r text; s public.postal_shipments;
 tr public.postal_transfers; result jsonb; cached postal_private.requests; org uuid; previous text;
 origin uuid; destination uuid; event_kind text; detail jsonb:='{}'; rec uuid; amount bigint; collected bigint; settled bigint;
 payment_id uuid; direction text; method text; actor_name text; branch_id uuid; selected_driver uuid; selected_driver_name text;
 before_data jsonb; member_id uuid; old_org uuid; replacement uuid;
BEGIN
 r:=postal_private.access_role(w);
 IF actor IS NULL OR r IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
 IF (p_payload->>'workspace_id')::uuid IS DISTINCT FROM w THEN RAISE EXCEPTION 'postal_workspace_changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text||actor::text||p_request_id::text,0));
 SELECT * INTO cached FROM postal_private.requests WHERE workspace_id=w AND actor_id=actor AND request_id=p_request_id;
 IF FOUND THEN
  IF cached.command<>p_command OR cached.payload<>p_payload THEN RAISE EXCEPTION 'postal_request_conflict'; END IF;
  IF (p_command IN ('save_branch','save_organization','move_member','authorize_transfer','cancel_transfer','cancel','settlement') AND r<>'admin')
   OR (p_command='create_shipment' AND r<>'merchant')
   OR (p_command IN ('receive','dispatch','arrive','out_for_delivery','deliver','collection') AND r NOT IN ('admin','office'))
   OR (cached.response ? 'organization_id' AND NOT postal_private.can_read(w,(cached.response->>'organization_id')::uuid))
   THEN RAISE EXCEPTION 'postal_unavailable' USING ERRCODE='42501'; END IF;
  RETURN cached.response;
 END IF;
 SELECT COALESCE(name,'') INTO actor_name FROM public.profiles WHERE id=actor;
 IF p_command='save_branch' THEN
  IF r<>'admin' THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
  IF NULLIF(p_payload->>'id','') IS NULL THEN
   INSERT INTO public.postal_branches(workspace_id,name,governorate,area,address,active)
   VALUES(w,btrim(p_payload->>'name'),p_payload->>'governorate',p_payload->>'area',p_payload->>'address',COALESCE((p_payload->>'active')::boolean,true)) RETURNING to_jsonb(postal_branches.*) INTO result;
  ELSE
   SELECT to_jsonb(b) INTO before_data FROM public.postal_branches b WHERE workspace_id=w AND id=(p_payload->>'id')::uuid FOR UPDATE;
   UPDATE public.postal_branches SET name=btrim(p_payload->>'name'),governorate=p_payload->>'governorate',area=p_payload->>'area',address=p_payload->>'address',active=(p_payload->>'active')::boolean,updated_at=now()
   WHERE workspace_id=w AND id=(p_payload->>'id')::uuid RETURNING to_jsonb(postal_branches.*) INTO result;
   IF result IS NULL THEN RAISE EXCEPTION 'postal_unavailable'; END IF;
  END IF;
 ELSIF p_command='save_organization' THEN
  IF r<>'admin' THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
  SELECT to_jsonb(o) INTO before_data FROM public.postal_organizations o WHERE workspace_id=w AND id=(p_payload->>'id')::uuid FOR UPDATE;
  UPDATE public.postal_organizations SET name=btrim(p_payload->>'name'),leader_id=(p_payload->>'leader_id')::uuid,updated_at=now()
   WHERE workspace_id=w AND id=(p_payload->>'id')::uuid RETURNING to_jsonb(postal_organizations.*) INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'postal_unavailable'; END IF;
 ELSIF p_command='move_member' THEN
  IF r<>'admin' THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
  member_id:=(p_payload->>'user_id')::uuid;
  SELECT organization_id INTO old_org FROM public.postal_memberships WHERE workspace_id=w AND user_id=member_id FOR UPDATE;
  SELECT id INTO org FROM public.postal_organizations WHERE workspace_id=w AND code=upper(replace(btrim(p_payload->>'code'),'-',''));
  IF old_org IS NULL OR org IS NULL OR old_org=org THEN RAISE EXCEPTION 'postal_invalid_organization'; END IF;
  PERFORM id FROM public.postal_organizations WHERE id IN (old_org,org) ORDER BY id FOR UPDATE;
  SELECT to_jsonb(m) INTO before_data FROM public.postal_memberships m WHERE user_id=member_id;
  IF EXISTS(SELECT 1 FROM public.postal_organizations WHERE id=old_org AND leader_id=member_id) THEN
   replacement:=NULLIF(p_payload->>'replacement_leader_id','')::uuid;
   IF replacement IS NULL OR replacement=member_id OR NOT EXISTS(SELECT 1 FROM public.postal_memberships WHERE organization_id=old_org AND user_id=replacement)
    THEN RAISE EXCEPTION 'postal_replacement_leader_required'; END IF;
   UPDATE public.postal_organizations SET leader_id=replacement,updated_at=now() WHERE id=old_org;
  END IF;
  UPDATE public.postal_memberships SET organization_id=org WHERE user_id=member_id RETURNING to_jsonb(postal_memberships.*) INTO result;
 ELSIF p_command='create_shipment' THEN
  IF r<>'merchant' THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM public.postal_memberships WHERE workspace_id=w AND user_id=actor;
  INSERT INTO public.postal_shipments(workspace_id,organization_id,recipient_name,primary_phone,backup_phone,governorate,area,address,cod_amount,pieces,fragile,delivery_notes,created_by)
  VALUES(w,org,btrim(p_payload->>'recipient_name'),p_payload->>'primary_phone',p_payload->>'backup_phone',p_payload->>'governorate',p_payload->>'area',p_payload->>'address',
   (p_payload->>'cod_amount')::bigint,NULLIF(p_payload->>'pieces','')::integer,(p_payload->>'fragile')::boolean,p_payload->>'delivery_notes',actor) RETURNING * INTO s;
  event_kind:='created'; previous:=NULL;
 ELSE
  SELECT * INTO s FROM public.postal_shipments WHERE workspace_id=w AND id=(p_payload->>'id')::uuid AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT postal_private.can_read(w,s.organization_id) THEN RAISE EXCEPTION 'postal_unavailable' USING ERRCODE='42501'; END IF;
  IF s.revision IS DISTINCT FROM (p_payload->>'revision')::integer THEN RAISE EXCEPTION 'postal_stale_shipment' USING ERRCODE='40001'; END IF;
  previous:=s.state; origin:=s.current_branch_id;
  SELECT * INTO tr FROM public.postal_transfers WHERE shipment_id=s.id AND status IN ('authorized','dispatched') FOR UPDATE;
  IF p_command='edit_shipment' THEN
   IF NOT ((r='merchant' AND s.state='draft') OR r='admin') OR s.state='cancelled' THEN RAISE EXCEPTION 'postal_invalid_transition'; END IF;
   IF r='admin' AND length(btrim(COALESCE(p_payload->>'reason','')))=0 THEN RAISE EXCEPTION 'postal_reason_required'; END IF;
   -- Financial amounts are immutable after physical acceptance.
   IF s.state<>'draft' AND s.cod_amount IS DISTINCT FROM (p_payload->>'cod_amount')::bigint THEN RAISE EXCEPTION 'postal_cod_locked'; END IF;
   detail:=jsonb_build_object('before',to_jsonb(s),'reason',p_payload->>'reason');
   UPDATE public.postal_shipments SET recipient_name=btrim(p_payload->>'recipient_name'),primary_phone=p_payload->>'primary_phone',backup_phone=p_payload->>'backup_phone',
    governorate=p_payload->>'governorate',area=p_payload->>'area',address=p_payload->>'address',cod_amount=(p_payload->>'cod_amount')::bigint,pieces=NULLIF(p_payload->>'pieces','')::integer,
    fragile=(p_payload->>'fragile')::boolean,delivery_notes=p_payload->>'delivery_notes' WHERE id=s.id RETURNING * INTO s;
   event_kind:=CASE WHEN r='admin' THEN 'admin_correction' ELSE 'edited' END;
  ELSIF p_command='delete_draft' THEN
   IF s.state<>'draft' OR r NOT IN ('admin','merchant') THEN RAISE EXCEPTION 'postal_invalid_transition'; END IF;
   UPDATE public.postal_shipments SET deleted_at=now() WHERE id=s.id RETURNING * INTO s;
   event_kind:='draft_deleted';
  ELSIF p_command='authorize_transfer' THEN
   IF r<>'admin' OR s.state NOT IN ('received','arrived') OR tr.id IS NOT NULL THEN RAISE EXCEPTION 'postal_invalid_transition'; END IF;
   destination:=(p_payload->>'branch_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.postal_branches WHERE workspace_id=w AND id=destination AND active) THEN RAISE EXCEPTION 'postal_branch_unavailable'; END IF;
   INSERT INTO public.postal_transfers(workspace_id,shipment_id,origin_id,destination_id,origin_name,destination_name,authorized_by) VALUES(w,s.id,origin,destination,(SELECT name FROM public.postal_branches WHERE id=origin),(SELECT name FROM public.postal_branches WHERE id=destination),actor);
   event_kind:='transfer_authorized';
  ELSIF p_command='cancel_transfer' THEN
   IF r<>'admin' OR tr.status IS DISTINCT FROM 'authorized' THEN RAISE EXCEPTION 'postal_invalid_transition'; END IF;
   UPDATE public.postal_transfers SET status='cancelled' WHERE id=tr.id;
   destination:=tr.destination_id; event_kind:='transfer_cancelled';
  ELSIF p_command IN ('receive','dispatch','arrive','out_for_delivery','deliver','cancel') THEN
   IF r NOT IN ('admin','office') THEN RAISE EXCEPTION 'postal_not_authorized' USING ERRCODE='42501'; END IF;
   IF p_command='receive' AND s.state='draft' THEN
    branch_id:=(p_payload->>'branch_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.postal_branches WHERE workspace_id=w AND id=branch_id AND active) THEN RAISE EXCEPTION 'postal_branch_unavailable'; END IF;
    s.state:='received'; s.current_branch_id:=branch_id; destination:=branch_id;
   ELSIF p_command='dispatch' AND s.state IN ('received','arrived') AND tr.status='authorized' THEN
    IF NOT EXISTS(SELECT 1 FROM public.postal_branches WHERE workspace_id=w AND id=tr.destination_id AND active) THEN RAISE EXCEPTION 'postal_branch_unavailable'; END IF;
    s.state:='in_transit'; destination:=tr.destination_id;
    UPDATE public.postal_transfers SET status='dispatched',dispatched_at=now() WHERE id=tr.id;
   ELSIF p_command='arrive' AND s.state='in_transit' AND tr.status='dispatched' AND tr.destination_id=(p_payload->>'branch_id')::uuid THEN
    s.state:='arrived'; s.current_branch_id:=tr.destination_id; destination:=tr.destination_id;
    UPDATE public.postal_transfers SET status='arrived',arrived_at=now() WHERE id=tr.id;
   ELSIF p_command='out_for_delivery' AND s.state IN ('received','arrived') AND tr.id IS NULL THEN s.state:='out_for_delivery';
   ELSIF p_command='deliver' AND s.state='out_for_delivery' THEN s.state:='delivered';
   ELSIF p_command='cancel' AND r='admin' AND s.state NOT IN ('delivered','cancelled') AND tr.status IS DISTINCT FROM 'dispatched' THEN
    IF length(btrim(COALESCE(p_payload->>'notes','')))=0 THEN RAISE EXCEPTION 'postal_reason_required'; END IF;
    s.state:='cancelled'; UPDATE public.postal_transfers SET status='cancelled' WHERE id=tr.id;
   ELSE RAISE EXCEPTION 'postal_invalid_transition' USING ERRCODE='23514'; END IF;
   IF p_command='out_for_delivery' AND NULLIF(p_payload->>'driver_id','') IS NOT NULL THEN
    selected_driver:=(p_payload->>'driver_id')::uuid;
    SELECT p.partner_name INTO selected_driver_name FROM crm.agents a JOIN crm.business_partners p ON p.id=a.business_partner_id AND p.workspace_id=w
     WHERE a.id=selected_driver AND a.workspace_id=w AND a.agent_type='driver' AND a.status='active' AND NOT a.is_deleted AND NOT p.is_deleted;
    IF selected_driver_name IS NULL OR NOT public.workspace_module_allowed(w,(SELECT plan::text FROM public.workspaces WHERE id=w),'agents') THEN RAISE EXCEPTION 'postal_driver_unavailable'; END IF;
    s.driver_id:=selected_driver; s.driver_name:=selected_driver_name;
    detail:=detail||jsonb_build_object('driver_id',selected_driver,'driver_name',selected_driver_name);
   END IF;
   UPDATE public.postal_shipments SET state=s.state,current_branch_id=s.current_branch_id,driver_id=s.driver_id,driver_name=s.driver_name WHERE id=s.id RETURNING * INTO s;
   event_kind:=p_command;
  ELSIF p_command IN ('collection','settlement') THEN
   IF s.state<>'delivered' OR r NOT IN ('admin','office') OR (p_command='settlement' AND r<>'admin') THEN RAISE EXCEPTION 'postal_invalid_transition'; END IF;
   amount:=(p_payload->>'signed_amount')::bigint; direction:=p_payload->>'direction'; method:=p_payload->>'payment_method';
   IF amount=0 OR sign(amount)<>sign(s.cod_amount) OR direction NOT IN ('incoming','outgoing') OR direction IS NULL
    OR method IS NULL OR method NOT IN ('cash','fib','qicard','zaincash','fastpay','bank_transfer') THEN RAISE EXCEPTION 'postal_invalid_payment'; END IF;
   SELECT COALESCE(sum(signed_amount) FILTER(WHERE kind='collection'),0),COALESCE(sum(signed_amount) FILTER(WHERE kind='settlement'),0)
    INTO collected,settled FROM public.postal_cod_records WHERE shipment_id=s.id;
   IF (p_command='collection' AND (abs(collected+amount)>abs(s.cod_amount) OR (amount<0 AND direction<>'outgoing') OR (amount>0 AND direction<>'incoming')))
    OR (p_command='settlement' AND abs(settled+amount)>abs(collected)) THEN RAISE EXCEPTION 'postal_invalid_payment'; END IF;
   payment_id:=gen_random_uuid(); rec:=gen_random_uuid();
   INSERT INTO public.payment_transactions(id,workspace_id,source_module,source_type,source_record_id,source_subrecord_id,direction,amount,currency,payment_method,paid_at,counterparty_name,reference_label,note,created_by,account_id,account_name_snapshot,metadata)
   VALUES(payment_id,w,'postal_service',CASE WHEN p_command='collection' THEN 'postal_cod' ELSE 'postal_settlement' END,s.id,rec,direction,abs(amount),'iqd',method,now(),
    CASE WHEN p_command='collection' THEN s.recipient_name ELSE (SELECT name FROM public.postal_organizations WHERE id=s.organization_id) END,
    s.id::text,p_payload->>'notes',actor,NULLIF(p_payload->>'account_id','')::uuid,p_payload->>'account_name_snapshot',jsonb_build_object('postalSignedAmount',amount,'organizationId',s.organization_id));
   INSERT INTO public.postal_cod_records(id,workspace_id,shipment_id,organization_id,kind,signed_amount,payment_transaction_id,actor_id,notes)
   VALUES(rec,w,s.id,s.organization_id,p_command,amount,payment_id,actor,p_payload->>'notes');
   event_kind:=CASE WHEN p_command='collection' THEN 'cod_recorded' ELSE 'merchant_account_updated' END;
   detail:=jsonb_build_object('signed_amount',amount,'direction',direction,'payment_transaction_id',payment_id);
  ELSE RAISE EXCEPTION 'postal_unknown_command'; END IF;
 END IF;
 IF event_kind IS NOT NULL THEN
  UPDATE public.postal_shipments SET revision=revision+CASE WHEN p_command='create_shipment' THEN 0 ELSE 1 END,updated_at=now() WHERE id=s.id RETURNING * INTO s;
  detail:=detail||jsonb_build_object('origin_name',(SELECT name FROM public.postal_branches WHERE id=origin),'destination_name',(SELECT name FROM public.postal_branches WHERE id=destination));
  INSERT INTO public.postal_events(workspace_id,shipment_id,event_type,previous_state,resulting_state,actor_id,actor_name,origin_id,destination_id,notes,metadata)
  VALUES(w,s.id,event_kind,previous,s.state,actor,actor_name,origin,destination,p_payload->>'notes',detail);
  result:=to_jsonb(s);
  IF payment_id IS NOT NULL THEN result:=result||jsonb_build_object('payment_transaction',(SELECT to_jsonb(p) FROM public.payment_transactions p WHERE p.id=payment_id)); END IF;
 END IF;
 IF p_command IN ('save_branch','save_organization','move_member') THEN
  INSERT INTO public.postal_admin_audit(workspace_id,actor_id,action,entity_id,before_data,after_data)
  VALUES(w,actor,p_command,COALESCE((result->>'id')::uuid,member_id),before_data,result);
 END IF;
 INSERT INTO postal_private.requests VALUES(w,actor,p_request_id,p_command,p_payload,result);
 RETURN result;
END $$;
CREATE FUNCTION public.postal_command(p_command text,p_payload jsonb,p_request_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT postal_private.command(p_command,p_payload,p_request_id) $$;
CREATE FUNCTION public.postal_financial_summary(p_shipment_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT jsonb_build_object('collected',COALESCE(sum(c.signed_amount) FILTER(WHERE c.kind='collection'),0),
  'settled',COALESCE(sum(c.signed_amount) FILTER(WHERE c.kind='settlement'),0),'record_count',count(c.id))
 FROM public.postal_cod_records c WHERE c.shipment_id=p_shipment_id
 AND c.workspace_id=public.current_workspace_id()
 HAVING EXISTS(SELECT 1 FROM public.postal_shipments s WHERE s.id=p_shipment_id AND s.workspace_id=public.current_workspace_id());
$$;
REVOKE ALL ON FUNCTION public.postal_financial_summary(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.postal_financial_summary(uuid) TO authenticated,service_role;

-- Explicit public API; private helpers are not exposed through PostgREST.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA postal_private FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION postal_private.prepare_registration(uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION postal_private.module_granted(uuid),postal_private.access_role(uuid),postal_private.can_read(uuid,uuid),postal_private.can_read_shipment(uuid,uuid),postal_private.command(text,jsonb,uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.postal_command(text,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.postal_command(text,jsonb,uuid) TO authenticated,service_role;
ALTER TABLE postal_private.requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON postal_private.requests FROM PUBLIC,anon,authenticated;

-- Shared payment tables have broader workspace policies. Add a restrictive
-- policy so postal metadata cannot leak another merchant's data through them.
CREATE POLICY postal_payment_visibility ON public.payment_transactions AS RESTRICTIVE FOR SELECT TO authenticated
 USING(source_module<>'postal_service' OR postal_private.can_read_shipment(workspace_id,source_record_id));
CREATE FUNCTION postal_private.protect_payment() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.source_module='postal_service' THEN RAISE EXCEPTION 'postal_history_is_immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'DELETE' AND NEW.source_module='postal_service' AND current_user IN ('authenticated','anon') THEN RAISE EXCEPTION 'postal_use_payment_workflow' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER postal_payment_integrity BEFORE INSERT OR UPDATE OR DELETE ON public.payment_transactions FOR EACH ROW EXECUTE FUNCTION postal_private.protect_payment();
REVOKE ALL ON FUNCTION postal_private.protect_payment() FROM PUBLIC,anon,authenticated;

-- Authorized clients refresh active pages after operations on another device.
-- A membership change also discards the former organization's in-memory view.
DO $$ DECLARE table_name text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  FOREACH table_name IN ARRAY ARRAY['postal_shipments','postal_events','postal_transfers','postal_cod_records','postal_branches','postal_organizations','postal_memberships'] LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=table_name) THEN
    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I',table_name);
   END IF;
  END LOOP;
 END IF;
END $$;

INSERT INTO public.postal_locations(governorate,area) VALUES
('baghdad','karrada'),
('baghdad','mansour'),
('baghdad','adhamiya'),
('baghdad','kadhimiya'),
('baghdad','sadr-city'),
('baghdad','rusafa'),
('baghdad','karkh'),
('basra','basra-centre'),
('basra','zubair'),
('basra','abu-al-khasib'),
('basra','qurna'),
('nineveh','mosul'),
('nineveh','tal-afar'),
('nineveh','hamdaniya'),
('nineveh','sinjar'),
('erbil','erbil-centre'),
('erbil','ankawa'),
('erbil','soran'),
('erbil','shaqlawa'),
('erbil','koya'),
('sulaymaniyah','sulaymaniyah-centre'),
('sulaymaniyah','chamchamal'),
('sulaymaniyah','ranya'),
('sulaymaniyah','dukan'),
('sulaymaniyah','penjwen'),
('duhok','duhok-centre'),
('duhok','zakho'),
('duhok','akre'),
('duhok','sumel'),
('duhok','amadiya'),
('halabja','halabja-centre'),
('halabja','khurmal'),
('halabja','sirwan'),
('halabja','byara'),
('kirkuk','kirkuk-centre'),
('kirkuk','hawija'),
('kirkuk','daquq'),
('kirkuk','dibis'),
('anbar','ramadi'),
('anbar','fallujah'),
('anbar','hit'),
('anbar','haditha'),
('anbar','qaim'),
('babil','hillah'),
('babil','musayyib'),
('babil','hashimiya'),
('babil','mahawil'),
('karbala','karbala-centre'),
('karbala','hindiya'),
('karbala','ain-al-tamur'),
('najaf','najaf-centre'),
('najaf','kufa'),
('najaf','manathera'),
('najaf','mishkhab'),
('qadisiyah','diwaniyah'),
('qadisiyah','shamiya'),
('qadisiyah','afak'),
('qadisiyah','hamza'),
('muthanna','samawah'),
('muthanna','rumaitha'),
('muthanna','khidr'),
('muthanna','salman'),
('dhi-qar','nasiriyah'),
('dhi-qar','shatra'),
('dhi-qar','rifai'),
('dhi-qar','suq-al-shuyukh'),
('maysan','amarah'),
('maysan','majar-al-kabir'),
('maysan','qalaat-saleh'),
('maysan','ali-al-gharbi'),
('wasit','kut'),
('wasit','hay'),
('wasit','suwayra'),
('wasit','aziziya'),
('wasit','badra'),
('diyala','baqubah'),
('diyala','muqdadiya'),
('diyala','khanaqin'),
('diyala','khalis'),
('diyala','balad-ruz'),
('salah-al-din','tikrit'),
('salah-al-din','samarra'),
('salah-al-din','balad'),
('salah-al-din','baiji'),
('salah-al-din','tuz');
