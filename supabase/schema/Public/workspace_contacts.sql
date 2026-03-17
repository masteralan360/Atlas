CREATE TABLE public.workspace_contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  type text NOT NULL,
  value text NOT NULL,
  label text NULL,
  is_primary boolean NULL DEFAULT false,
  sync_status text NULL DEFAULT 'synced'::text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (id)
);
