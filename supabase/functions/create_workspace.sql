CREATE OR REPLACE FUNCTION public.create_workspace(w_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    new_id UUID;
    new_code TEXT;
BEGIN
    INSERT INTO public.workspaces (
        name, 
        subscription_expires_at, 
        locked_workspace
    ) 
    VALUES (
        w_name, 
        NOW() + INTERVAL '1 month', 
        false
    )
    RETURNING id, code INTO new_id, new_code;
    
    RETURN jsonb_build_object('id', new_id, 'code', new_code);
END;
$function$
