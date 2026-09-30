CREATE TABLE public.product_uoms (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  unit_ref text NOT NULL,
  unit_code text NOT NULL,
  coefficient numeric NOT NULL,
  is_base boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  is_default_selling boolean NOT NULL DEFAULT false,
  selling_price numeric NOT NULL,
  cost_price numeric NULL,
  minimum_selling_price numeric NULL,
  sku text NULL,
  barcode text NULL,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  CONSTRAINT product_uoms_unit_ref_format CHECK (unit_ref ~ '^(builtin|custom):.+$'),
  CONSTRAINT product_uoms_unit_code_not_blank CHECK (char_length(btrim(unit_code)) > 0),
  CONSTRAINT product_uoms_coefficient_positive CHECK (coefficient > 0),
  CONSTRAINT product_uoms_base_coefficient_one CHECK (NOT is_base OR coefficient = 1),
  CONSTRAINT product_uoms_non_base_coefficient_not_one CHECK (is_base OR coefficient <> 1 OR NOT is_active),
  CONSTRAINT product_uoms_selling_price_nonnegative CHECK (selling_price >= 0),
  CONSTRAINT product_uoms_cost_nonnegative CHECK (cost_price IS NULL OR cost_price >= 0),
  CONSTRAINT product_uoms_minimum_nonnegative CHECK (minimum_selling_price IS NULL OR minimum_selling_price >= 0),
  CONSTRAINT product_uoms_product_unit_unique UNIQUE (product_id, unit_ref)
);

CREATE UNIQUE INDEX idx_product_uoms_one_active_base
  ON public.product_uoms (product_id)
  WHERE is_base AND is_active AND NOT is_deleted;
CREATE UNIQUE INDEX idx_product_uoms_active_barcode
  ON public.product_uoms (workspace_id, lower(btrim(barcode)))
  WHERE barcode IS NOT NULL AND btrim(barcode) <> '' AND is_active AND NOT is_deleted;
CREATE INDEX idx_product_uoms_active_sku
  ON public.product_uoms (workspace_id, lower(btrim(sku)))
  WHERE sku IS NOT NULL AND btrim(sku) <> '' AND is_active AND NOT is_deleted;
CREATE INDEX idx_product_uoms_workspace_product
  ON public.product_uoms (workspace_id, product_id, is_active)
  WHERE NOT is_deleted;
CREATE INDEX idx_product_uoms_workspace_updated
  ON public.product_uoms (workspace_id, updated_at DESC);

ALTER TABLE public.product_uoms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_uoms FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_uoms TO authenticated, service_role;
