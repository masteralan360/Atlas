import type { PaymentMethodOption } from '@/lib/paymentMethods'

export type QuickOrderPaymentStatus = 'paid' | 'unpaid' | 'partial'
export type QuickOrderStatus = 'draft' | 'pending' | 'completed'

export type QuickOrderPaymentStatusPolicy = {
    requiredStatus: QuickOrderPaymentStatus | null
    selectorDisabled: boolean
    paidDisabled: boolean
    unpaidDisabled: boolean
    partialDisabled: boolean
}

/**
 * Cash is paid on save for active orders. Financed orders default to unpaid;
 * Quick Orders may also record a partial initial repayment for Loans.
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
        unpaidDisabled: cashRequiresPaid,
        partialDisabled: paymentMethod !== 'loan'
    }
}

/** Apply the selected method's required status, or clear it when no method remains. */
export function getQuickOrderPaymentStatusAfterMethodChange(
    currentStatus: QuickOrderPaymentStatus | null,
    paymentMethod: PaymentMethodOption | null,
    orderStatus: QuickOrderStatus
): QuickOrderPaymentStatus | null {
    if (!paymentMethod) return null
    const policy = getQuickOrderPaymentStatusPolicy(paymentMethod, orderStatus)
    if (policy.requiredStatus) return policy.requiredStatus
    return currentStatus === 'partial' && paymentMethod !== 'loan' ? 'unpaid' : currentStatus
}

/** Reapply an active method's required status when the order lifecycle changes. */
export function getQuickOrderPaymentStatusAfterOrderStatusChange(
    currentStatus: QuickOrderPaymentStatus | null,
    paymentMethod: PaymentMethodOption | null,
    orderStatus: QuickOrderStatus
): QuickOrderPaymentStatus | null {
    if (paymentMethod === 'loan' && currentStatus === 'partial') {
        return currentStatus
    }
    return getQuickOrderPaymentStatusPolicy(paymentMethod, orderStatus).requiredStatus ?? currentStatus
}
