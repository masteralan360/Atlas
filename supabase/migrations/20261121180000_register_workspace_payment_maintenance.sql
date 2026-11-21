INSERT INTO public.app_module_maintenance (module_name, route_path, maintenance_mode)
VALUES ('Workspace Payment', '/workspace-payment', false)
ON CONFLICT (route_path) DO UPDATE
SET module_name = EXCLUDED.module_name;
