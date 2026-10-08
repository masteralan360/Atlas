const DAY_MS = 24 * 60 * 60 * 1000

export const SUBSCRIPTION_EXPIRY_WARNING_DAYS = 5

export interface SubscriptionExpiryWarning {
    expiresAt: Date
    expiresAtIso: string
    daysRemaining: number
    msRemaining: number
}

export function getSubscriptionExpiryWarning(
    expiresAtIso?: string | null,
    now: Date = new Date()
): SubscriptionExpiryWarning | null {
    if (!expiresAtIso) return null

    const expiresAt = new Date(expiresAtIso)
    if (Number.isNaN(expiresAt.getTime())) return null

    const msRemaining = expiresAt.getTime() - now.getTime()
    if (msRemaining <= 0 || msRemaining > SUBSCRIPTION_EXPIRY_WARNING_DAYS * DAY_MS) {
        return null
    }

    return {
        expiresAt,
        expiresAtIso,
        daysRemaining: Math.max(1, Math.ceil(msRemaining / DAY_MS)),
        msRemaining
    }
}

export function getSubscriptionExpiryWarningSeenKey(
    workspaceId: string,
    expiresAtIso: string,
    billingMode?: string
) {
    const modeSegment = billingMode ? `:${billingMode}` : ''
    return `atlas_subscription_expiry_warning_seen:${workspaceId}${modeSegment}:${expiresAtIso}`
}
