CREATE OR REPLACE FUNCTION public.acknowledge_p2p_sync(p_queue_id uuid, p_session_id uuid)
 RETURNS TABLE(is_complete boolean, storage_path text, file_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_workspace_id uuid;
  v_session_count int;
  v_current_synced jsonb;
  v_storage_path text;
  v_file_name text;
begin
  -- 1. Get current item details
  select sq.workspace_id, sq.storage_path, sq.file_name, sq.synced_by
  into v_workspace_id, v_storage_path, v_file_name, v_current_synced
  from sync_queue sq
  where sq.id = p_queue_id;

  if v_workspace_id is null then
    return;
  end if;

  -- 2. Update if not present (track by session_id)
  if not (v_current_synced @> to_jsonb(p_session_id::text)) then
    update sync_queue sq
    set synced_by = coalesce(sq.synced_by, '[]'::jsonb) || to_jsonb(p_session_id::text)
    where sq.id = p_queue_id
    returning sq.synced_by into v_current_synced;
  end if;

  -- 3. Get Workspace Total Session Count
  -- Join auth.sessions with profiles table to target direct workspace
  select count(s.id) into v_session_count
  from auth.sessions s
  join public.profiles p on s.user_id = p.id
  where p.workspace_id = v_workspace_id;

  -- 4. Check completion
  if jsonb_array_length(v_current_synced) >= v_session_count then
    return query select true, v_storage_path, v_file_name;
  else
    return query select false, v_storage_path, v_file_name;
  end if;
end;
$function$
