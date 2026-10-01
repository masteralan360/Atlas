import type { PurchaseOrder, SalesOrder } from '@/local-db/models'

export type OrderArchiveKind = 'sales' | 'purchase'
export type ArchivableOrder = Pick<SalesOrder | PurchaseOrder, 'status'> & {
    returnStatus?: SalesOrder['returnStatus']
    isArchived?: boolean
}

/** A full sales return is shown as Returned in the UI while its lifecycle status stays completed. */
export function isOrderArchiveEligible(order: ArchivableOrder, kind: OrderArchiveKind) {
    const status = String(order.status).toLowerCase()
    return status === 'cancelled'
        || status === 'returned'
        || (kind === 'sales' && order.returnStatus === 'full')
}

export function isActiveOrder(order: Pick<ArchivableOrder, 'isArchived'>) {
    return order.isArchived !== true
}
