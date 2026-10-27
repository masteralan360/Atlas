ALTER TABLE public.website_storefront_configs
  ADD CONSTRAINT website_storefront_configs_site_workspace_unique UNIQUE (site_key, workspace_id);

CREATE TABLE IF NOT EXISTS public.storefront_order_reward_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  site_key text NOT NULL,
  shopping_mode text NOT NULL CHECK (shopping_mode IN ('retail', 'wholesale')),
  is_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT storefront_order_reward_sets_site_mode_unique UNIQUE (site_key, shopping_mode),
  CONSTRAINT storefront_order_reward_sets_site_workspace_fkey
    FOREIGN KEY (site_key, workspace_id)
    REFERENCES public.website_storefront_configs(site_key, workspace_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.storefront_order_reward_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES public.storefront_order_reward_sets(id) ON DELETE CASCADE,
  threshold numeric NOT NULL CHECK (
    threshold > 0
    AND threshold <= 999999999.999
    AND threshold <> 'NaN'::numeric
    AND scale(threshold) <= 3
  ),
  node_type text NOT NULL CHECK (node_type IN ('FreeDelivery', 'ProgressNode')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT storefront_order_reward_milestones_threshold_unique UNIQUE (rule_set_id, threshold)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_order_reward_free_delivery
  ON public.storefront_order_reward_milestones (rule_set_id)
  WHERE node_type = 'FreeDelivery';

CREATE INDEX IF NOT EXISTS idx_storefront_order_reward_sets_workspace_mode
  ON public.storefront_order_reward_sets (workspace_id, shopping_mode, is_enabled);

CREATE INDEX IF NOT EXISTS idx_storefront_order_reward_milestones_set_threshold
  ON public.storefront_order_reward_milestones (rule_set_id, threshold);

ALTER TABLE public.storefront_order_reward_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_order_reward_milestones ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.enforce_storefront_order_reward_set_has_milestone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_rule_set_id uuid;
  v_rule_set_ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'storefront_order_reward_sets' THEN
    v_rule_set_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    v_rule_set_ids := ARRAY[NEW.rule_set_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_rule_set_ids := ARRAY[OLD.rule_set_id];
  ELSE
    v_rule_set_ids := ARRAY[OLD.rule_set_id, NEW.rule_set_id];
  END IF;

  FOREACH v_rule_set_id IN ARRAY v_rule_set_ids
  LOOP
    IF v_rule_set_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.storefront_order_reward_sets WHERE id = v_rule_set_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.storefront_order_reward_milestones WHERE rule_set_id = v_rule_set_id
      ) THEN
      RAISE EXCEPTION 'Each order reward rule set must contain at least one milestone'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER storefront_order_reward_sets_require_milestone
  AFTER INSERT ON public.storefront_order_reward_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_storefront_order_reward_set_has_milestone();

CREATE CONSTRAINT TRIGGER storefront_order_reward_milestones_keep_set_nonempty
  AFTER INSERT OR UPDATE OR DELETE ON public.storefront_order_reward_milestones
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_storefront_order_reward_set_has_milestone();

CREATE OR REPLACE FUNCTION public.save_jumla_khaleej_order_reward_set(
  p_workspace_id uuid,
  p_shopping_mode text,
  p_is_enabled boolean,
  p_milestones jsonb,
  p_rule_set_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_rule_set_id uuid;
  v_item jsonb;
  v_threshold numeric;
  v_node_type text;
  v_thresholds numeric[] := ARRAY[]::numeric[];
  v_free_delivery_count integer := 0;
BEGIN
  IF p_shopping_mode IS NULL OR p_shopping_mode NOT IN ('retail', 'wholesale') THEN
    RAISE EXCEPTION 'Choose a valid shopping mode';
  END IF;
  IF p_is_enabled IS NULL THEN
    RAISE EXCEPTION 'Choose whether this rule set is enabled';
  END IF;
  IF jsonb_typeof(p_milestones) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Add at least one milestone before saving';
  END IF;
  IF jsonb_array_length(p_milestones) = 0 THEN
    RAISE EXCEPTION 'Add at least one milestone before saving';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.website_storefront_configs
    WHERE site_key = 'jumla-khaleej' AND workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'Jumla Khaleej storefront workspace is not configured';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_milestones)
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Each milestone needs a valid threshold and node type';
    END IF;
    BEGIN
      v_threshold := (v_item ->> 'threshold')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Enter a positive order-total threshold with up to three decimal places';
    END;
    v_node_type := v_item ->> 'node_type';
    IF v_threshold IS NULL OR v_threshold <= 0 OR v_threshold > 999999999.999 OR scale(v_threshold) > 3 THEN
      RAISE EXCEPTION 'Enter a positive order-total threshold with up to three decimal places';
    END IF;
    IF v_node_type IS NULL OR v_node_type NOT IN ('FreeDelivery', 'ProgressNode') THEN
      RAISE EXCEPTION 'Choose a valid milestone type';
    END IF;
    IF v_threshold = ANY(v_thresholds) THEN
      RAISE EXCEPTION 'Milestone thresholds must be unique within a shopping mode';
    END IF;
    v_thresholds := array_append(v_thresholds, v_threshold);
    IF v_node_type = 'FreeDelivery' THEN
      v_free_delivery_count := v_free_delivery_count + 1;
      IF v_free_delivery_count > 1 THEN
        RAISE EXCEPTION 'Free delivery can appear only once in a shopping mode';
      END IF;
    END IF;
  END LOOP;

  IF p_rule_set_id IS NULL THEN
    INSERT INTO public.storefront_order_reward_sets (workspace_id, site_key, shopping_mode, is_enabled)
    VALUES (p_workspace_id, 'jumla-khaleej', p_shopping_mode, p_is_enabled)
    RETURNING id INTO v_rule_set_id;
  ELSE
    UPDATE public.storefront_order_reward_sets
    SET is_enabled = p_is_enabled,
        updated_at = timezone('utc', now())
    WHERE id = p_rule_set_id
      AND workspace_id = p_workspace_id
      AND site_key = 'jumla-khaleej'
      AND shopping_mode = p_shopping_mode
    RETURNING id INTO v_rule_set_id;
    IF v_rule_set_id IS NULL THEN
      RAISE EXCEPTION 'This rule set no longer exists for the selected shopping mode';
    END IF;
  END IF;

  DELETE FROM public.storefront_order_reward_milestones WHERE rule_set_id = v_rule_set_id;
  INSERT INTO public.storefront_order_reward_milestones (rule_set_id, threshold, node_type)
  SELECT v_rule_set_id, (item ->> 'threshold')::numeric, item ->> 'node_type'
  FROM jsonb_array_elements(p_milestones) AS items(item);

  RETURN v_rule_set_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_jumla_khaleej_order_reward_set(uuid, text, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_jumla_khaleej_order_reward_set(uuid, text, boolean, jsonb, uuid) TO service_role;
