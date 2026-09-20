CREATE TABLE public.product_unit_conversions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  relationship_id uuid NOT NULL,
  factor numeric NOT NULL,
  parent_price numeric NOT NULL,
  created_by uuid NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  sync_status text NOT NULL DEFAULT 'synced'::text,
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  CONSTRAINT product_unit_conversions_product_unique UNIQUE (product_id),
  CONSTRAINT product_unit_conversions_factor_positive CHECK (factor > 0 AND factor::text NOT IN ('NaN', 'Infinity', '-Infinity')),
  CONSTRAINT product_unit_conversions_parent_price_nonnegative CHECK (parent_price >= 0 AND parent_price::text NOT IN ('NaN', 'Infinity', '-Infinity'))
);
