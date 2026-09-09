-- Due moments are business-local wall times. Converting from date preserves
-- existing sales at midnight while allowing new schedules to retain a time.
ALTER TABLE public.installment_sales
  ALTER COLUMN first_due_date TYPE timestamp without time zone
    USING first_due_date::timestamp without time zone,
  ALTER COLUMN next_due_date TYPE timestamp without time zone
    USING next_due_date::timestamp without time zone;

ALTER TABLE public.installment_sale_installments
  ALTER COLUMN due_date TYPE timestamp without time zone
    USING due_date::timestamp without time zone;
