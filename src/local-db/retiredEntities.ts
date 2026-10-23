/** Upgrade-only tombstones. Keep these names so old device queues cannot replay them. */
export const RETIRED_ENTITY_TYPES = [
  'delivery_merchant_profiles',
  'delivery_shipments',
  'delivery_shipment_events',
  'delivery_shipment_cod_adjustment_requests',
  'delivery_shipment_cod_corrections',
  'delivery_shipment_prepaid_corrections',
  'delivery_shipment_recipient_payout_adjustment_requests',
  'delivery_shipment_recipient_payout_corrections',
  'delivery_shipment_settlement_obligations',
  'delivery_runs',
  'delivery_run_items',
  'delivery_settlements',
  'delivery_ledger_entries',
  'delivery_voice_cleanup',
] as const

const retiredEntityTypes = new Set<string>(RETIRED_ENTITY_TYPES)

export function isRetiredEntityType(entityType: string): boolean {
  return retiredEntityTypes.has(entityType)
}
