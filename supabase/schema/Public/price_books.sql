CREATE TABLE public.price_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NULL DEFAULT NULL,
  save_warn boolean NOT NULL DEFAULT true,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  sync_status text NOT NULL DEFAULT 'synced'::text,
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT price_books_name_not_blank CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT price_books_color_hex_check CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE INDEX IF NOT EXISTS idx_price_books_workspace
  ON public.price_books (workspace_id);

CREATE INDEX IF NOT EXISTS idx_price_books_workspace_updated
  ON public.price_books (workspace_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_books_workspace_active_name_unique
  ON public.price_books (workspace_id, lower(btrim(name)))
  WHERE is_deleted = false;

DROP TRIGGER IF EXISTS update_price_books_updated_at ON public.price_books;
CREATE TRIGGER update_price_books_updated_at
BEFORE UPDATE ON public.price_books
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.price_books ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS price_books_select ON public.price_books;
CREATE POLICY price_books_select
  ON public.price_books
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_capability_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = price_books.workspace_id),
      'priceBooks'
    )
  );

DROP POLICY IF EXISTS price_books_insert ON public.price_books;
CREATE POLICY price_books_insert
  ON public.price_books
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.workspace_capability_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = price_books.workspace_id),
      'priceBooks'
    )
  );

DROP POLICY IF EXISTS price_books_update ON public.price_books;
CREATE POLICY price_books_update
  ON public.price_books
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.workspace_capability_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = price_books.workspace_id),
      'priceBooks'
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.workspace_capability_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = price_books.workspace_id),
      'priceBooks'
    )
  );

DROP POLICY IF EXISTS price_books_delete ON public.price_books;
CREATE POLICY price_books_delete
  ON public.price_books
  FOR DELETE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.workspace_capability_allowed(
      workspace_id,
      (SELECT workspace.plan::text FROM public.workspaces AS workspace WHERE workspace.id = price_books.workspace_id),
      'priceBooks'
    )
  );
