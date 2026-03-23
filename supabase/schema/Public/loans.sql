CREATE TABLE public.loans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  sale_id uuid NULL,
  loan_no text NOT NULL,
  source text NOT NULL,
  linked_party_type text NULL,
  linked_party_id uuid NULL,
  linked_party_name text NULL,
  borrower_name text NOT NULL,
  borrower_phone text NOT NULL,
  borrower_address text NOT NULL,
  borrower_national_id text NOT NULL,
  principal_amount numeric NOT NULL,
  total_paid_amount numeric NOT NULL DEFAULT 0,
  balance_amount numeric NOT NULL,
  settlement_currency text NOT NULL,
  installment_count integer NOT NULL,
  installment_frequency text NOT NULL,
  first_due_date date NOT NULL,
  next_due_date date NULL,
  status text NOT NULL,
  notes text NULL,
  created_by uuid NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  overdue_reminder_snoozed_at timestamp with time zone NULL,
  overdue_reminder_snoozed_for_due_date date NULL,
  CONSTRAINT loans_linked_party_type_check CHECK (
    linked_party_type IS NULL
    OR linked_party_type = 'customer'::text
  ),
  CONSTRAINT loans_linked_party_presence_check CHECK (
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
  ),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_loans_workspace_linked_party
  ON public.loans (workspace_id, linked_party_type, linked_party_id)
  WHERE is_deleted = false;
