-- POS checkout must insert the selected unit label with the immutable UoM
-- snapshot. The sale-item trigger only fills this field when it is empty.
DO $patch_pos_uom_snapshot$
DECLARE
  checkout_definition text;
  column_marker text := E'            selling_unit_code,\n            base_unit_ref,';
  value_marker text := E'            NULLIF(item->>''selling_unit_code'', ''''),\n            NULLIF(item->>''base_unit_ref'', ''''),';
BEGIN
  SELECT pg_get_functiondef('private.complete_sale_once(jsonb)'::regprocedure)
  INTO checkout_definition;

  IF position('NULLIF(item->>''selling_unit_name_snapshot'', '''')' IN checkout_definition) > 0 THEN
    RETURN;
  END IF;

  IF position(column_marker IN checkout_definition) = 0
    OR position(value_marker IN checkout_definition) = 0
  THEN
    RAISE EXCEPTION 'complete_sale_once does not contain the expected POS UoM snapshot implementation';
  END IF;

  checkout_definition := replace(
    checkout_definition,
    column_marker,
    E'            selling_unit_code,\n            selling_unit_name_snapshot,\n            base_unit_ref,'
  );
  checkout_definition := replace(
    checkout_definition,
    value_marker,
    E'            NULLIF(item->>''selling_unit_code'', ''''),\n            NULLIF(item->>''selling_unit_name_snapshot'', ''''),\n            NULLIF(item->>''base_unit_ref'', ''''),'
  );

  IF position('selling_unit_name_snapshot' IN checkout_definition) = 0
    OR position('NULLIF(item->>''selling_unit_name_snapshot'', '''')' IN checkout_definition) = 0
  THEN
    RAISE EXCEPTION 'complete_sale_once POS UoM snapshot patch failed';
  END IF;

  EXECUTE checkout_definition;
END;
$patch_pos_uom_snapshot$;
