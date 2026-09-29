create table if not exists public.app_maintenance (
    id boolean primary key default true check (id),
    maintenance boolean not null default false
);

insert into public.app_maintenance (id, maintenance)
values (true, false)
on conflict (id) do nothing;

alter table public.app_maintenance enable row level security;

revoke all on table public.app_maintenance from anon, authenticated;
grant select on table public.app_maintenance to anon, authenticated;

create policy "Maintenance state is publicly readable"
    on public.app_maintenance
    for select
    to anon, authenticated
    using (true);

do $$
begin
    if not exists (
        select 1 from pg_publication where pubname = 'supabase_realtime'
    ) then
        raise exception 'Supabase Realtime publication supabase_realtime does not exist';
    end if;

    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'app_maintenance'
    ) then
        alter publication supabase_realtime add table public.app_maintenance;
    end if;
end
$$;
