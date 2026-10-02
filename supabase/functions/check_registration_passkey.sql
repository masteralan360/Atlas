CREATE OR REPLACE FUNCTION public.check_registration_passkey()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    provided_key text;
    requested_role text;
    valid_key text;
    configured_key_count integer;
begin
    provided_key := nullif(btrim(coalesce(NEW.raw_user_meta_data->>'passkey', '')), '');
    requested_role := nullif(btrim(coalesce(NEW.raw_user_meta_data->>'role', '')), '');

    if requested_role is null then
        raise exception 'Role is required for registration. Meta: %', NEW.raw_user_meta_data;
    end if;

    if requested_role not in ('admin', 'staff', 'viewer') then
        raise exception 'Invalid role requested: %. Meta: %', requested_role, NEW.raw_user_meta_data;
    end if;

    -- A single-use permit is created only by the controlled service-role provisioner.
    -- Auth applies app_metadata after INSERT, so editable metadata is never trusted.
    delete from sorl_private.actor_permits p
    using public.workspaces w
    where p.user_id = NEW.id and p.email = NEW.email
      and p.role = requested_role
      and p.workspace_id::text = NEW.raw_user_meta_data->>'workspace_id'
      and p.expires_at > now() and w.id = p.workspace_id
      and w.name like ('DEV TEST SORL ' || p.run_id::text || ' %')
      and w.deleted_at is null;
    if found then
        NEW.raw_user_meta_data = coalesce(NEW.raw_user_meta_data, '{}'::jsonb) - 'passkey';
        return NEW;
    end if;

    if provided_key is null then
        raise exception 'Registration passkey is required.';
    end if;

    perform 1
    from public.keys
    where key_name in ('admin', 'staff', 'viewer')
    order by key_name
    for update;

    select count(*)
    into configured_key_count
    from public.keys
    where key_name in ('admin', 'staff', 'viewer');

    if configured_key_count <> 3 then
        raise exception 'Registration keys are not fully configured. Expected 3 active keys, found %.', configured_key_count;
    end if;

    select key_value into valid_key
    from public.keys
    where key_name = requested_role;

    if valid_key is null or provided_key <> valid_key then
        raise exception 'Invalid passkey provided for role: %.', requested_role;
    end if;

    perform public.rotate_registration_keys();

    -- IMPORTANT: Remove the passkey from metadata so it is not saved to the database.
    NEW.raw_user_meta_data = coalesce(NEW.raw_user_meta_data, '{}'::jsonb) - 'passkey';

    return NEW;
end;
$function$
