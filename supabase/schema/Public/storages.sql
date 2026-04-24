CREATE TABLE public.storages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_protected boolean NOT NULL DEFAULT false,
  is_primary boolean NOT NULL DEFAULT false,
  is_marketplace boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);
