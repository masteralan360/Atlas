export type StorefrontPromoCodeRow = {
    code: string
    discount_type: string
    discount_value: number | string
    is_active: boolean
    expires_at: string | null
    max_uses?: number | string
    used_count?: number | string
}

export type StorefrontPromoStatus = 'valid' | 'invalid' | 'inactive' | 'expired' | 'exhausted' | 'ineligible'

export type StorefrontPromoEvaluation = {
    status: StorefrontPromoStatus
    discount_amount: number
}

export function normalizeStorefrontPromoCode(value: unknown) {
    return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

export function roundStorefrontOrderAmount(value: number) {
    return Math.round((value + Number.EPSILON) * 1_000) / 1_000
}

export function evaluateStorefrontPromoCode(
    promo: StorefrontPromoCodeRow,
    subtotalValue: number,
    now = Date.now()
): StorefrontPromoEvaluation {
    const subtotal = roundStorefrontOrderAmount(subtotalValue)
    if (!promo.is_active) return { status: 'inactive', discount_amount: 0 }

    if (promo.expires_at) {
        const expiresAt = Date.parse(promo.expires_at)
        if (!Number.isFinite(expiresAt) || expiresAt <= now) return { status: 'expired', discount_amount: 0 }
    }

    const maxUses = Number(promo.max_uses ?? 1)
    const usedCount = Number(promo.used_count ?? 0)
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || !Number.isSafeInteger(usedCount) || usedCount < 0) {
        return { status: 'ineligible', discount_amount: 0 }
    }
    if (usedCount >= maxUses) return { status: 'exhausted', discount_amount: 0 }

    const discountValue = Number(promo.discount_value)
    if (!Number.isFinite(subtotal) || subtotal <= 0 || !Number.isFinite(discountValue) || discountValue <= 0) {
        return { status: 'ineligible', discount_amount: 0 }
    }

    let discountAmount: number
    if (promo.discount_type === 'percentage' && discountValue <= 100) {
        discountAmount = subtotal * discountValue / 100
    } else if (promo.discount_type === 'fixed') {
        discountAmount = discountValue
    } else {
        return { status: 'ineligible', discount_amount: 0 }
    }

    discountAmount = Math.min(subtotal, roundStorefrontOrderAmount(discountAmount))
    if (!Number.isFinite(discountAmount) || discountAmount <= 0) {
        return { status: 'ineligible', discount_amount: 0 }
    }

    return { status: 'valid', discount_amount: discountAmount }
}
