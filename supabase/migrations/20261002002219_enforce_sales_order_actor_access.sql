-- UI route checks must also hold for direct authenticated database requests.
create or replace function public.current_user_can_access_sales_orders(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists (
   select 1 from public.workspaces w join public.profiles p on p.id=(select auth.uid())
   where w.id=p_workspace_id and p.current_workspace=w.id and w.deleted_at is null
     and public.workspace_module_allowed(w.id,w.plan::text,'orders')
     and (p.role='admin' or not public.workspace_capability_allowed(w.id,w.plan::text,'workspaceManagementPermissions')
       or exists(select 1 from public.workspace_permissions permission
         where permission.workspace_id=w.id and permission.user_uuid=p.id and permission.key='orders.saleOrdersAccess'))
 );
$$;
revoke all on function public.current_user_can_access_sales_orders(uuid) from public, anon;
grant execute on function public.current_user_can_access_sales_orders(uuid) to authenticated, service_role;

create policy crm_sales_orders_actor_select_guard on crm.sales_orders as restrictive for select to authenticated
using (public.current_user_can_access_sales_orders(workspace_id));
create policy crm_sales_orders_actor_insert_guard on crm.sales_orders as restrictive for insert to authenticated
with check (public.current_user_role() in ('admin','staff') and public.current_user_can_access_sales_orders(workspace_id));
create policy crm_sales_orders_actor_update_guard on crm.sales_orders as restrictive for update to authenticated
using (public.current_user_role() in ('admin','staff') and public.current_user_can_access_sales_orders(workspace_id))
with check (public.current_user_role() in ('admin','staff') and public.current_user_can_access_sales_orders(workspace_id));
create policy crm_sales_orders_actor_delete_guard on crm.sales_orders as restrictive for delete to authenticated
using (public.current_user_role() in ('admin','staff') and public.current_user_can_access_sales_orders(workspace_id));
