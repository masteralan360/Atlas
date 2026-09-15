export type OrderRecordLookupStatus = 'loading' | 'found' | 'not-found' | 'error'
export type OrderDetailsRemoteLookupStatus = 'loading' | 'complete' | 'error'
export type OrderDetailsLookupStatus = 'loading' | 'found' | 'not-found' | 'error'

/**
 * Keeps the order detail route from presenting absence until both local order
 * lookups and the authoritative cloud refresh have reached a conclusion.
 */
export function resolveOrderDetailsLookupStatus({
    salesOrderStatus,
    purchaseOrderStatus,
    remoteStatus
}: {
    salesOrderStatus: OrderRecordLookupStatus
    purchaseOrderStatus: OrderRecordLookupStatus
    remoteStatus: OrderDetailsRemoteLookupStatus
}): OrderDetailsLookupStatus {
    if (salesOrderStatus === 'found' || purchaseOrderStatus === 'found') {
        return 'found'
    }

    if (
        salesOrderStatus === 'loading'
        || purchaseOrderStatus === 'loading'
        || remoteStatus === 'loading'
    ) {
        return 'loading'
    }

    if (
        salesOrderStatus === 'error'
        || purchaseOrderStatus === 'error'
        || remoteStatus === 'error'
    ) {
        return 'error'
    }

    return 'not-found'
}
