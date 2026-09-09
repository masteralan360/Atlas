CREATE TABLE public.workspaces (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text NOT NULL DEFAULT generate_workspace_code(),
  plan text NOT NULL DEFAULT 'basic'::text,
  created_at timestamp with time zone NULL DEFAULT now(),
  data_mode text NOT NULL DEFAULT 'cloud'::text,
  allow_pos boolean NOT NULL DEFAULT false,
  allow_invoices boolean NOT NULL DEFAULT false,
  is_configured boolean NOT NULL DEFAULT false,
  deleted_at timestamp with time zone NULL,
  default_currency text NOT NULL DEFAULT 'usd'::text,
  pos_convert_to_workspace_currency boolean NOT NULL DEFAULT true,
  iqd_display_preference text NOT NULL DEFAULT 'IQD'::text,
  locked_workspace boolean NULL DEFAULT false,
  max_discount_percent integer NULL DEFAULT 100,
  logo_url text NULL,
  allow_whatsapp boolean NULL DEFAULT false,
  member_count integer NULL DEFAULT 0,
  print_lang text NULL DEFAULT 'auto'::text,
  print_qr boolean NULL DEFAULT false,
  subscription_expires_at timestamp with time zone NULL,
  receipt_template text NULL DEFAULT 'primary'::text,
  a4_template text NULL DEFAULT 'professional'::text,

  coordination text NULL,
  kds_enabled boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'private'::text,
  store_slug text NULL,
  store_description text NULL,
  ecommerce boolean NOT NULL DEFAULT false,
  real_estate boolean NOT NULL DEFAULT true,
  upload_limit_mb integer NULL,
  usage_limit_locked boolean NOT NULL DEFAULT false,
  payment_renewal_locked boolean NOT NULL DEFAULT false,
  subscription_expiry_locked boolean NOT NULL DEFAULT false,
  sales_agent_commission_sheet_type text NOT NULL DEFAULT 'normal'::text,
  ledger_dashboard_config jsonb NOT NULL DEFAULT '{"version":1,"hiddenGroups":[],"groupOrder":["operating","borrowing","lending"]}'::jsonb,
  CONSTRAINT workspaces_data_mode_check CHECK ((data_mode::text) = ANY (ARRAY['cloud'::text, 'local'::text, 'hybrid'::text, 'demo'::text])),
  CONSTRAINT workspaces_plan_check CHECK (plan = ANY (ARRAY['basic'::text, 'business'::text, 'enterprise'::text])),
  CONSTRAINT workspaces_sales_agent_commission_sheet_type_check CHECK (sales_agent_commission_sheet_type IN ('normal', 'tier_based')),
  CONSTRAINT workspaces_ledger_dashboard_config_object_check CHECK (jsonb_typeof(ledger_dashboard_config) = 'object'),
  PRIMARY KEY (id)
);

CREATE OR REPLACE FUNCTION public.prevent_workspace_mode_switch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.data_mode IS DISTINCT FROM OLD.data_mode AND COALESCE(OLD.is_configured, false) THEN
    IF COALESCE(OLD.data_mode::text, 'cloud') = 'local' OR COALESCE(NEW.data_mode::text, 'cloud') = 'local' THEN
      RAISE EXCEPTION 'Workspace mode cannot enter or leave local mode after initial configuration';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_workspace_mode_switch_on_workspaces ON public.workspaces;

CREATE TRIGGER prevent_workspace_mode_switch_on_workspaces
BEFORE UPDATE ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION public.prevent_workspace_mode_switch();
