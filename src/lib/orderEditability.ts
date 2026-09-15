import type { PurchaseOrderStatus, SalesOrderStatus } from '@/local-db/models'

type EditableOrderStatus = SalesOrderStatus | PurchaseOrderStatus

/**
 * Orders may only be changed while they are drafts. A missing status represents
 * a new or still-loading order, whose normal loading guard remains responsible
 * for blocking interaction.
 */
export function isOrderReadOnly(status: EditableOrderStatus | null | undefined): boolean {
    return status !== null && status !== undefined && status !== 'draft'
}
