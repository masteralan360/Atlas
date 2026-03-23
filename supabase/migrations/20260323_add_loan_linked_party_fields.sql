ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS linked_party_type text NULL,
  ADD COLUMN IF NOT EXISTS linked_party_id uuid NULL,
  ADD COLUMN IF NOT EXISTS linked_party_name text NULL;

UPDATE public.loans
SET
  linked_party_type = NULL,
  linked_party_id = NULL,
  linked_party_name = NULL
WHERE linked_party_type = 'supplier';

ALTER TABLE public.loans
  DROP CONSTRAINT IF EXISTS loans_linked_party_type_check;

ALTER TABLE public.loans
  ADD CONSTRAINT loans_linked_party_type_check CHECK (
    linked_party_type IS NULL
    OR linked_party_type = 'customer'::text
  );

ALTER TABLE public.loans
  DROP CONSTRAINT IF EXISTS loans_linked_party_presence_check;

ALTER TABLE public.loans
  ADD CONSTRAINT loans_linked_party_presence_check CHECK (
    (
      linked_party_type IS NULL
      AND linked_party_id IS NULL
      AND linked_party_name IS NULL
    )
    OR (
      linked_party_type IS NOT NULL
      AND linked_party_id IS NOT NULL
      AND linked_party_name IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_loans_workspace_linked_party
  ON public.loans (workspace_id, linked_party_type, linked_party_id)
  WHERE is_deleted = false;
