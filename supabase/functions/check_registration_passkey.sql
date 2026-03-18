CREATE OR REPLACE FUNCTION public.check_registration_passkey()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    provided_key text;
    requested_role text;
    required_key_name text;
    valid_key text;
    general_key text;
begin
    provided_key := NEW.raw_user_meta_data->>'passkey';
    requested_role := NEW.raw_user_meta_data->>'role';
    
    if requested_role is null then
        raise exception 'Role is required for registration. Meta: %', NEW.raw_user_meta_data;
    end if;

    case requested_role
        when 'admin' then required_key_name := 'admin_passkey';
        when 'staff' then required_key_name := 'staff_passkey';
        when 'viewer' then required_key_name := 'viewer_passkey';
        else raise exception 'Invalid role requested: %. Meta: %', requested_role, NEW.raw_user_meta_data;
    end case;

    -- Get the role-specific key
    select key_value into valid_key from public.app_permissions where key_name = required_key_name;
    -- Get the general registration key as fallback
    select key_value into general_key from public.app_permissions where key_name = 'registration_passkey';

    if provided_key is null or (provided_key != coalesce(valid_key, 'MISSING') and provided_key != coalesce(general_key, 'MISSING')) then
        raise exception 'Invalid Passkey provided: "%". For role: %. (Expected role-specific or general key)', provided_key, requested_role;
    end if;
    
    -- IMPORTANT: Remove the passkey from metadata so it is not saved to the database.
    NEW.raw_user_meta_data = NEW.raw_user_meta_data - 'passkey';
    
    return NEW;
end;
$function$
