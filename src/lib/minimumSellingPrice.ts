import type { UserRole } from '@/local-db/models'

/** Compares values already expressed in the same currency and selling unit. */
export function isBelowMinimumSellingPrice(
    role: UserRole | undefined,
    effectiveSellingPrice: number,
    minimumSellingPrice: number | null | undefined
) {
    return role === 'staff'
        && minimumSellingPrice != null
        && Number.isFinite(effectiveSellingPrice)
        && effectiveSellingPrice < minimumSellingPrice
}

export function shouldShowMinimumSellingPriceField(role: UserRole | undefined, workspaceHasStaff: boolean) {
    return role === 'admin' && workspaceHasStaff
}
