CREATE TABLE IF NOT EXISTS public.module_maintenance (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    module_name text NOT NULL,
    route_path text NOT NULL UNIQUE CHECK (route_path <> '/' AND route_path LIKE '/%'),
    maintenance_mode boolean NOT NULL DEFAULT false
);

ALTER TABLE public.module_maintenance ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.module_maintenance TO authenticated;
GRANT ALL ON TABLE public.module_maintenance TO service_role;

CREATE POLICY "Authenticated users can read module maintenance settings"
    ON public.module_maintenance
    FOR SELECT
    TO authenticated
    USING (true);

INSERT INTO public.module_maintenance (module_name, route_path)
VALUES
    ('Point of Sale', '/pos'),
    ('Instant POS', '/instant-pos'),
    ('Kitchen Display System', '/kds'),
    ('Sales History', '/sales'),
    ('Business Partners', '/business-partners'),
    ('Online Customers', '/online-customers'),
    ('Agents', '/agents'),
    ('Postal Service', '/post-service'),
    ('Car Rental', '/car-rental'),
    ('Garden', '/garden'),
    ('Customers', '/customers'),
    ('Suppliers', '/suppliers'),
    ('Orders', '/orders'),
    ('E-Commerce', '/ecommerce'),
    ('Commerce Operations', '/commerce-operations'),
    ('Real Estate', '/real-estate'),
    ('Travel & Transportation', '/travel-transportation'),
    ('Activities', '/activities'),
    ('Manual Entry', '/manual-entry'),
    ('Currency Exchange', '/currency-exchange'),
    ('Clinical Appointments', '/clinical-appointments'),
    ('Clinical Presets', '/clinical-presets'),
    ('Ledger', '/ledger'),
    ('Payments', '/payments'),
    ('Direct Transactions', '/direct-transactions'),
    ('Revenue', '/revenue'),
    ('Customer Profitability', '/customer-profitability'),
    ('Budget', '/budget'),
    ('Performance', '/performance'),
    ('WhatsApp', '/whatsapp'),
    ('Products', '/products'),
    ('Payment Accounts', '/payment-accounts'),
    ('Services', '/services'),
    ('Units', '/units'),
    ('Discounts', '/discounts'),
    ('Storages', '/storages'),
    ('Inventory Transfer', '/inventory-transfer'),
    ('Inventory Transactions', '/inventory-transactions'),
    ('Stock Adjustments', '/stock-adjustments'),
    ('Human Resources', '/hr'),
    ('Loans', '/loans'),
    ('Installments', '/installments'),
    ('Invoice History', '/invoices-history'),
    ('Currency Converter', '/currency-converter'),
    ('Notebook', '/notebook'),
    ('Members', '/members'),
    ('Custom Templates', '/custom-templates'),
    ('Settings', '/settings'),
    ('Logs', '/logs')
ON CONFLICT (route_path) DO UPDATE
SET module_name = EXCLUDED.module_name;
