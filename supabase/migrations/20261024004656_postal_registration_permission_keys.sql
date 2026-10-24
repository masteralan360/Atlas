-- The new module uses two explicit permissions. Keep the namespace blocked
-- for every other key while allowing merchant enrollment and office access.
ALTER TABLE public.workspace_permissions
  DROP CONSTRAINT IF EXISTS workspace_permissions_no_retired_modules,
  ADD CONSTRAINT workspace_permissions_no_retired_modules CHECK (
    (
      COALESCE(key, '') NOT LIKE 'postService.%'
      AND COALESCE(module, '') <> 'postService'
    )
    OR (
      module = 'postService'
      AND key IN ('postService.merchant', 'postService.officeEmployee')
    )
  );
