CREATE TABLE IF NOT EXISTS public.product_barcodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  barcode text NOT NULL,
  label text NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT product_barcodes_barcode_not_blank
    CHECK (char_length(trim(barcode)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_product_barcodes_workspace
  ON public.product_barcodes (workspace_id);

CREATE INDEX IF NOT EXISTS idx_product_barcodes_product
  ON public.product_barcodes (product_id);

CREATE INDEX IF NOT EXISTS idx_product_barcodes_workspace_barcode
  ON public.product_barcodes (workspace_id, barcode);

CREATE INDEX IF NOT EXISTS idx_product_barcodes_workspace_updated
  ON public.product_barcodes (workspace_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_barcodes_workspace_barcode_active
  ON public.product_barcodes (workspace_id, barcode)
  WHERE is_deleted = false;

DROP TRIGGER IF EXISTS update_product_barcodes_updated_at ON public.product_barcodes;
CREATE TRIGGER update_product_barcodes_updated_at
BEFORE UPDATE ON public.product_barcodes
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.product_barcodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_barcodes_select ON public.product_barcodes;
CREATE POLICY product_barcodes_select
  ON public.product_barcodes
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS product_barcodes_insert ON public.product_barcodes;
CREATE POLICY product_barcodes_insert
  ON public.product_barcodes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS product_barcodes_update ON public.product_barcodes;
CREATE POLICY product_barcodes_update
  ON public.product_barcodes
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS product_barcodes_delete ON public.product_barcodes;
CREATE POLICY product_barcodes_delete
  ON public.product_barcodes
  FOR DELETE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );
