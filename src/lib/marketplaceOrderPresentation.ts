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
