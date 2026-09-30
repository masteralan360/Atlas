import type { PaymentMethodOption } from '@/lib/paymentMethods'

export type QuickOrderPaymentStatus = 'paid' | 'unpaid'
export type QuickOrderStatus = 'draft' | 'pending' | 'completed'

export type QuickOrderPaymentStatusPolicy = {
    requiredStatus: QuickOrderPaymentStatus | null
    selectorDisabled: boolean
    paidDisabled: boolean
    unpaidDisabled: boolean
}

/**
 * Cash is paid on save for active orders, while financed orders must remain
 * unpaid. Draft cash orders keep both statuses available for later editing.
 */
export function getQuickOrderPaymentStatusPolicy(
    paymentMethod: PaymentMethodOption | null,
    orderStatus: QuickOrderStatus
): QuickOrderPaymentStatusPolicy {
    const isFinanced = paymentMethod === 'loan' || paymentMethod === 'installments'
    const cashRequiresPaid = paymentMethod === 'cash' && orderStatus !== 'draft'

    return {
        requiredStatus: isFinanced ? 'unpaid' : cashRequiresPaid ? 'paid' : null,
        selectorDisabled: paymentMethod === null,
        paidDisabled: isFinanced,
        unpaidDisabled: cashRequiresPaid
    }
}

/** Apply the selected method's required status, or clear it when no method remains. */
export function getQuickOrderPaymentStatusAfterMethodChange(
    currentStatus: QuickOrderPaymentStatus | null,
    paymentMethod: PaymentMethodOption | null,
    orderStatus: QuickOrderStatus
): QuickOrderPaymentStatus | null {
    if (!paymentMethod) return null
    return getQuickOrderPaymentStatusPolicy(paymentMethod, orderStatus).requiredStatus ?? currentStatus
}

/** Reapply an active method's required status when the order lifecycle changes. */
export function getQuickOrderPaymentStatusAfterOrderStatusChange(
    currentStatus: QuickOrderPaymentStatus | null,
    paymentMethod: PaymentMethodOption | null,
    orderStatus: QuickOrderStatus
): QuickOrderPaymentStatus | null {
    return getQuickOrderPaymentStatusPolicy(paymentMethod, orderStatus).requiredStatus ?? currentStatus
}
