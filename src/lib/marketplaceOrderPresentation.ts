export type MarketplaceOrderLifecycleStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'

export type MarketplaceSalesOrderReturnStatus = 'none' | 'partial' | 'full'

export type MarketplaceOrderDisplayStatus = MarketplaceOrderLifecycleStatus | 'returned'

export type MarketplaceInventoryDisplayStatus =
  | 'deducted'
  | 'returned'
  | 'warning'
  | null

/**
 * Delivery actor names are stored as snapshots so historical deliveries remain
 * attributable after the user's profile changes. Older delivered orders do not
 * have that snapshot and use the supplied localized fallback instead.
 */
export function getMarketplaceDeliveryActorName(
  deliveredByName: string | null | undefined,
  unknownLabel: string,
): string {
  return deliveredByName?.trim() || unknownLabel
}

/**
 * Marketplace rows retain their delivery lifecycle for audit purposes. A
 * return is posted against the linked sales order, so expose it as the final
 * customer-facing state only after the marketplace order was delivered.
 */
export function getMarketplaceOrderDisplayStatus(
  lifecycleStatus: MarketplaceOrderLifecycleStatus,
  salesOrderReturnStatus: MarketplaceSalesOrderReturnStatus,
): MarketplaceOrderDisplayStatus {
  return lifecycleStatus === 'delivered' && salesOrderReturnStatus !== 'none'
    ? 'returned'
    : lifecycleStatus
}

export function getMarketplaceInventoryDisplayStatus(
  lifecycleStatus: MarketplaceOrderLifecycleStatus,
  salesOrderReturnStatus: MarketplaceSalesOrderReturnStatus,
  inventoryDeducted: boolean,
): MarketplaceInventoryDisplayStatus {
  if (lifecycleStatus !== 'delivered') return null
  if (salesOrderReturnStatus !== 'none') return 'returned'
  return inventoryDeducted ? 'deducted' : 'warning'
}
