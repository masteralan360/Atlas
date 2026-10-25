-- The signed settlement balance determines whether cash leaves for the
-- merchant or arrives from the merchant. Keep the linked payment aligned.
CREATE FUNCTION postal_private.enforce_cod_settlement_cash_direction()
RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_direction text;
  v_expected_direction text;
BEGIN
  IF NEW.kind <> 'settlement' THEN
    RETURN NEW;
  END IF;

  v_expected_direction := CASE
    WHEN NEW.signed_amount > 0 THEN 'outgoing'
    ELSE 'incoming'
  END;

  SELECT p.direction INTO v_direction
  FROM public.payment_transactions p
  WHERE p.id = NEW.payment_transaction_id
    AND p.workspace_id = NEW.workspace_id
    AND p.source_module = 'postal_service'
    AND p.source_type = 'postal_settlement';

  IF v_direction IS DISTINCT FROM v_expected_direction THEN
    RAISE EXCEPTION 'postal_invalid_payment' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION postal_private.enforce_cod_settlement_cash_direction()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER postal_settlement_cash_direction_guard
  BEFORE INSERT ON public.postal_cod_records
  FOR EACH ROW
  WHEN (NEW.kind = 'settlement')
  EXECUTE FUNCTION postal_private.enforce_cod_settlement_cash_direction();
