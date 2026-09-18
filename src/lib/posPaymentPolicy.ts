export type PosPaymentType = 'cash' | 'digital' | 'loan' | 'order'

interface PosPaymentPolicyInput {
    isActivitiesStorage: boolean
    isServicesStorage: boolean
    quickOrderEnabled: boolean
}

/**
 * Activities are recorded through their dedicated transaction flow, while
 * services use the normal POS sale flow and can therefore be financed just
 * like inventory products. Services also use the existing Sales Order flow
 * for Quick Orders; their order lines are intentionally non-inventory.
 */
export function isPosPaymentTypeAllowed(
    paymentType: PosPaymentType,
    { isActivitiesStorage, quickOrderEnabled }: PosPaymentPolicyInput
): boolean {
    if (paymentType === 'cash' || paymentType === 'digital') return true
    if (paymentType === 'loan') return !isActivitiesStorage
    if (paymentType === 'order') {
        return quickOrderEnabled && !isActivitiesStorage
    }

    return false
}

/** Route regular POS checkout without mixing its three transaction domains. */
export function getPosCheckoutRoute(paymentType: PosPaymentType, policy: PosPaymentPolicyInput) {
    if (!isPosPaymentTypeAllowed(paymentType, policy)) return 'blocked' as const
    if (paymentType === 'order') return 'quick-order' as const
    if (policy.isActivitiesStorage) return 'activity' as const
    return 'sale' as const
}
