import type { WorkspacePermissionKey } from './workspacePermissionDefinitions'

export const SALES_ORDER_RETURN_NOT_ALLOWED = 'sales_order_return_not_allowed'

export interface SalesOrderReturnPermissionInput {
    actorRole?: string | null
    actorId?: string | null
    orderCreatedBy?: string | null
    permissionKeys?: readonly WorkspacePermissionKey[]
}

/**
 * Mirrors the server-side return policy for the local cache and UI. The
 * database remains authoritative in Cloud and Hybrid workspaces.
 */
export function canReturnSalesOrder({
    actorRole,
    actorId,
    orderCreatedBy,
    permissionKeys = []
}: SalesOrderReturnPermissionInput) {
    if (actorRole === 'admin') return true
    if (actorRole !== 'staff') return false
    if (!permissionKeys.includes('orders.saleOrdersAccess')) return false
    if (permissionKeys.includes('orders.requireSalesOrderRequest')) return false

    return !permissionKeys.includes('orders.view_own')
        || Boolean(actorId && orderCreatedBy === actorId)
}
