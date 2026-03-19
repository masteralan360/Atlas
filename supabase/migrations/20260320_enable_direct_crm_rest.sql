ALTER ROLE authenticator RESET pgrst.db_schemas;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

DROP VIEW IF EXISTS public.customers;
DROP VIEW IF EXISTS public.suppliers;
DROP VIEW IF EXISTS public.sales_orders;
DROP VIEW IF EXISTS public.purchase_orders;

NOTIFY pgrst, 'reload schema';
