ALTER TABLE public.storefront_order_reward_milestones
  ADD COLUMN node_types text[];

UPDATE public.storefront_order_reward_milestones
SET node_types = ARRAY[node_type];

CREATE OR REPLACE FUNCTION public.sync_storefront_order_reward_milestone_nodes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF NEW.node_types IS NULL THEN
    IF NEW.node_type IS NULL THEN
      RAISE EXCEPTION 'Choose at least one milestone type';
    END IF;
    NEW.node_types := ARRAY[NEW.node_type];
  END IF;

  NEW.node_type := CASE
    WHEN 'FreeDelivery' = ANY(NEW.node_types) THEN 'FreeDelivery'
    ELSE 'ProgressNode'
  END;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER storefront_order_reward_milestones_sync_nodes
  BEFORE INSERT OR UPDATE ON public.storefront_order_reward_milestones
  FOR EACH ROW EXECUTE FUNCTION public.sync_storefront_order_reward_milestone_nodes();

REVOKE ALL ON FUNCTION public.sync_storefront_order_reward_milestone_nodes() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.storefront_order_reward_milestones
  ALTER COLUMN node_types SET NOT NULL,
  ADD CONSTRAINT storefront_order_reward_milestones_node_types_valid CHECK (
    cardinality(node_types) BETWEEN 1 AND 3
    AND node_types <@ ARRAY['FreeDelivery', 'ProgressNode', 'Gift']::text[]
    AND cardinality(node_types) =
      (CASE WHEN 'FreeDelivery' = ANY(node_types) THEN 1 ELSE 0 END)
      + (CASE WHEN 'ProgressNode' = ANY(node_types) THEN 1 ELSE 0 END)
      + (CASE WHEN 'Gift' = ANY(node_types) THEN 1 ELSE 0 END)
  ),
  ADD CONSTRAINT storefront_order_reward_milestones_legacy_node_type_consistent CHECK (
    node_type = CASE
      WHEN 'FreeDelivery' = ANY(node_types) THEN 'FreeDelivery'
      ELSE 'ProgressNode'
    END
  );

COMMENT ON COLUMN public.storefront_order_reward_milestones.node_types IS
  'Reward/status nodes attached to this threshold. The legacy node_type column remains as a compatibility alias.';

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
  v_node_json jsonb;
  v_threshold numeric;
  v_node_type text;
  v_legacy_node_type text;
  v_node_types text[];
  v_normalized_milestones jsonb := '[]'::jsonb;
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
      RAISE EXCEPTION 'Each milestone needs a valid threshold and at least one node type';
    END IF;
    BEGIN
      v_threshold := (v_item ->> 'threshold')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Enter a positive order-total threshold with up to three decimal places';
    END;
    IF v_threshold IS NULL OR v_threshold <= 0 OR v_threshold > 999999999.999 OR scale(v_threshold) > 3 THEN
      RAISE EXCEPTION 'Enter a positive order-total threshold with up to three decimal places';
    END IF;

    v_node_types := ARRAY[]::text[];
    IF v_item ? 'node_types' THEN
      IF jsonb_typeof(v_item -> 'node_types') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Choose at least one milestone type';
      END IF;
      IF jsonb_array_length(v_item -> 'node_types') = 0 THEN
        RAISE EXCEPTION 'Choose at least one milestone type';
      END IF;
      FOR v_node_json IN SELECT value FROM jsonb_array_elements(v_item -> 'node_types')
      LOOP
        IF jsonb_typeof(v_node_json) IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Choose valid milestone types';
        END IF;
        v_node_type := v_node_json #>> '{}';
        IF v_node_type IS NULL OR v_node_type NOT IN ('FreeDelivery', 'ProgressNode', 'Gift') THEN
          RAISE EXCEPTION 'Choose a valid milestone type';
        END IF;
        IF v_node_type = ANY(v_node_types) THEN
          RAISE EXCEPTION 'A milestone cannot contain the same node type more than once';
        END IF;
        v_node_types := array_append(v_node_types, v_node_type);
      END LOOP;
    ELSE
      v_node_type := COALESCE(v_item ->> 'node_type', v_item ->> 'nodeType');
      IF v_node_type IS NULL OR v_node_type NOT IN ('FreeDelivery', 'ProgressNode', 'Gift') THEN
        RAISE EXCEPTION 'Choose a valid milestone type';
      END IF;
      v_node_types := ARRAY[v_node_type];
    END IF;

    IF v_threshold = ANY(v_thresholds) THEN
      RAISE EXCEPTION 'Milestone thresholds must be unique within a shopping mode';
    END IF;
    v_thresholds := array_append(v_thresholds, v_threshold);

    IF 'FreeDelivery' = ANY(v_node_types) THEN
      v_free_delivery_count := v_free_delivery_count + 1;
      IF v_free_delivery_count > 1 THEN
        RAISE EXCEPTION 'Free delivery can appear only once in a shopping mode';
      END IF;
    END IF;

    v_legacy_node_type := CASE
      WHEN 'FreeDelivery' = ANY(v_node_types) THEN 'FreeDelivery'
      ELSE 'ProgressNode'
    END;
    v_normalized_milestones := v_normalized_milestones || jsonb_build_array(
      jsonb_build_object(
        'threshold', v_threshold::text,
        'node_type', v_legacy_node_type,
        'node_types', to_jsonb(v_node_types)
      )
    );
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
  INSERT INTO public.storefront_order_reward_milestones (rule_set_id, threshold, node_type, node_types)
  SELECT
    v_rule_set_id,
    (item ->> 'threshold')::numeric,
    item ->> 'node_type',
    ARRAY(SELECT jsonb_array_elements_text(item -> 'node_types'))
  FROM jsonb_array_elements(v_normalized_milestones) AS items(item);

  RETURN v_rule_set_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_jumla_khaleej_order_reward_set(uuid, text, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_jumla_khaleej_order_reward_set(uuid, text, boolean, jsonb, uuid) TO service_role;
