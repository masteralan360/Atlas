CREATE TABLE public.loan_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  amount numeric NOT NULL,
  payment_method text NOT NULL,
  paid_at timestamp with time zone NOT NULL,
  note text NULL,
  created_by uuid NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);
