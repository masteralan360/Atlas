CREATE OR REPLACE FUNCTION public.update_workspace_member_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
    if (TG_OP = 'INSERT' and NEW.workspace_id is not null) then
        update public.workspaces set member_count = member_count + 1 where id = NEW.workspace_id;
    elsif (TG_OP = 'DELETE' and OLD.workspace_id is not null) then
        update public.workspaces set member_count = member_count - 1 where id = OLD.workspace_id;
    elsif (TG_OP = 'UPDATE') then
        if (OLD.workspace_id is distinct from NEW.workspace_id) then
            if (OLD.workspace_id is not null) then
                update public.workspaces set member_count = member_count - 1 where id = OLD.workspace_id;
            end if;
            if (NEW.workspace_id is not null) then
                update public.workspaces set member_count = member_count + 1 where id = NEW.workspace_id;
            end if;
        end if;
    end if;
    return NEW;
end;
$function$
