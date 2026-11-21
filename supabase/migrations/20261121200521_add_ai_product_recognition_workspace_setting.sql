ALTER TABLE public.workspaces
    ADD COLUMN IF NOT EXISTS ai_product_recognition_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.ai_product_recognition_enabled IS
    'Enables local, on-device product image recognition in supported POS environments after local embeddings are initialized.';
