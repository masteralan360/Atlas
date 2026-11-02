-- Cover the composite shipment/organization FK used by permanent QR claims.
CREATE INDEX postal_generated_qrs_shipment
  ON public.postal_generated_qrs(workspace_id,shipment_id,claimed_organization_id);
