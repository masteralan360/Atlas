CREATE TABLE public.installment_sale_installments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  installment_sale_id uuid NOT NULL,
  installment_no integer NOT NULL,
  due_date timestamp without time zone NULL,
  planned_amount numeric NOT NULL,
  paid_amount numeric NOT NULL DEFAULT 0,
  balance_amount numeric NOT NULL,
  status text NOT NULL,
  paid_at timestamp with time zone NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);
