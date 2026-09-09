ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS ledger_dashboard_config jsonb NOT NULL
  DEFAULT '{"version":1,"hiddenGroups":[],"groupOrder":["operating","borrowing","lending"]}'::jsonb;

UPDATE public.workspaces
SET ledger_dashboard_config = '{"version":1,"hiddenGroups":[],"groupOrder":["operating","borrowing","lending"]}'::jsonb
WHERE ledger_dashboard_config IS NULL
   OR jsonb_typeof(ledger_dashboard_config) <> 'object';

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_ledger_dashboard_config_object_check,
  ADD CONSTRAINT workspaces_ledger_dashboard_config_object_check
    CHECK (jsonb_typeof(ledger_dashboard_config) = 'object');

COMMENT ON COLUMN public.workspaces.ledger_dashboard_config IS
  'Workspace-shared presentation preferences for predefined Ledger cash calculation groups. Formulas remain application-controlled.';
