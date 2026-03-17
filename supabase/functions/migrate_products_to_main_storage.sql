CREATE OR REPLACE FUNCTION public.migrate_products_to_main_storage(p_workspace_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
    v_main_storage_id uuid;
begin
    -- 1. Ensure 'Main' storage exists
    insert into public.storages (workspace_id, name, is_system, is_protected)
    values (p_workspace_id, 'Main', true, true)
    on conflict (workspace_id, name) do update set is_system = true
    returning id into v_main_storage_id;

    -- 2. Ensure 'Reserve' storage exists (optional)
    insert into public.storages (workspace_id, name, is_system, is_protected)
    values (p_workspace_id, 'Reserve', true, true)
    on conflict do nothing;

    -- 3. Move quantity from products to stocks (MAIN)
    insert into public.stocks (workspace_id, product_id, storage_id, quantity)
    select 
        p.workspace_id,
        p.id,
        v_main_storage_id,
        coalesce(p.quantity, 0)
    from public.products p
    where p.workspace_id = p_workspace_id
    on conflict (product_id, storage_id) do update 
    set quantity = EXCLUDED.quantity;
end;
$function$
