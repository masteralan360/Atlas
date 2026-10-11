ALTER TABLE public.price_books
  ADD COLUMN IF NOT EXISTS color text NULL DEFAULT NULL;

ALTER TABLE public.price_books
  DROP CONSTRAINT IF EXISTS price_books_color_hex_check;

ALTER TABLE public.price_books
  ADD CONSTRAINT price_books_color_hex_check
  CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');

COMMENT ON COLUMN public.price_books.color IS
  'Optional six-digit hex color used to visually identify the Price Book.';
