-- Isolated PostgreSQL fixture for statement accounting and browser regression tests.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA crm;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
CREATE FUNCTION public.current_workspace_id() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.workspace',true),'')::uuid$$;
CREATE FUNCTION public.workspace_module_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
GRANT USAGE ON SCHEMA auth TO authenticated,anon;
CREATE TABLE crm.business_partners(id uuid PRIMARY KEY, workspace_id uuid, partner_name text, is_deleted boolean DEFAULT false);
CREATE TABLE crm.agents(id uuid PRIMARY KEY, workspace_id uuid, business_partner_id uuid, agent_type text, status text, is_deleted boolean DEFAULT false);
CREATE TABLE public.workspaces(id uuid PRIMARY KEY, name text DEFAULT 'Workspace', data_mode text DEFAULT 'cloud', deleted_at timestamptz);
CREATE TABLE public.profiles(id uuid PRIMARY KEY, name text, role text, workspace_id uuid, current_workspace uuid);
CREATE FUNCTION public.current_user_role() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$SELECT role FROM public.profiles WHERE id=auth.uid()$$;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}',raw_app_meta_data jsonb DEFAULT '{}');
CREATE TABLE public.keys(key_name text,key_value text);
CREATE TABLE public.workspace_access_overrides(workspace_id uuid,type text,key text,value text);
CREATE TABLE public.workspace_permissions(workspace_id uuid,user_uuid uuid,key text NOT NULL,module text NOT NULL,
  CONSTRAINT workspace_permissions_no_retired_modules CHECK(COALESCE(key,'') NOT LIKE 'postService.%' AND COALESCE(module,'')<>'postService'));
CREATE TABLE public.payment_transactions(id uuid PRIMARY KEY,workspace_id uuid,source_module text,source_type text,source_record_id uuid,source_subrecord_id uuid,direction text,amount numeric,currency text,payment_method text,paid_at timestamptz,counterparty_name text,reference_label text,note text,created_by uuid,account_id uuid,account_name_snapshot text,metadata jsonb);
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.payment_transactions TO authenticated;
CREATE POLICY payment_read ON public.payment_transactions FOR SELECT TO authenticated USING(workspace_id=public.current_workspace_id());
INSERT INTO public.workspaces(id) VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
INSERT INTO public.workspace_access_overrides VALUES('00000000-0000-4000-8000-000000000001','module','postal_service','grant'),('00000000-0000-4000-8000-000000000002','module','postal_service','grant');
INSERT INTO public.profiles VALUES
 ('00000000-0000-4000-8000-000000000010','Admin','admin','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000011','Merchant','staff','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000012','Office','staff','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000013','Unpermitted','staff','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000014','Viewer','viewer','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000015','Other workspace','staff','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002');
