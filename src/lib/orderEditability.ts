import type { PurchaseOrderStatus, SalesOrder, SalesOrderStatus } from '@/local-db/models'
import { getOrderPaidAmount, getOrderPaymentStatus, ORDER_AMOUNT_EPSILON } from '@/local-db/orderInstallments'

type EditableOrderStatus = SalesOrderStatus | PurchaseOrderStatus

/**
 * Most orders may only be changed while they are drafts. A missing status
 * represents a new or still-loading order, whose loading guard blocks interaction.
 */
export function isOrderReadOnly(status: EditableOrderStatus | null | undefined): boolean {
    return status !== null && status !== undefined && status !== 'draft'
}

/** A pending sales order is editable only while it is genuinely unpaid. Financed orders require their linked loan. */
export function isEditableUnpaidReservedSalesOrder(order: SalesOrder | null | undefined): boolean {
    if (!order || order.status !== 'pending' || order.isArchived || order.isPaid) return false
    const isFinanced = order.paymentMethod === 'loan' || order.paymentMethod === 'installments'
    if (isFinanced !== Boolean(order.linkedLoanId)) return false
    return getOrderPaymentStatus(order) === 'unpaid'
        && getOrderPaidAmount(order) <= ORDER_AMOUNT_EPSILON
}
