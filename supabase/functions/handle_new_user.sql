CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
    raw_ws_id text;
    valid_ws_id uuid;
begin
    raw_ws_id := new.raw_user_meta_data->>'workspace_id';
    
    -- Safely parse UUID
    if raw_ws_id is not null and raw_ws_id != '' then
        begin
            valid_ws_id := raw_ws_id::uuid;
        exception when others then
            valid_ws_id := null;
        end;
    else
        valid_ws_id := null;
    end if;

    INSERT INTO public.profiles (id, name, role, workspace_id)
    VALUES (
        new.id,
        new.raw_user_meta_data->>'name',
        new.raw_user_meta_data->>'role',
        valid_ws_id
    );
    RETURN new;
END;
$function$
