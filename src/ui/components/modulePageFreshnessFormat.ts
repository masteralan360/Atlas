type RelativeTimeTranslator = (key: string, options?: { count?: number }) => string

export function formatModulePageRelativeTime(
    timestamp: string,
    locale: string,
    t: RelativeTimeTranslator,
    now = Date.now()
) {
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return null

    const elapsedMs = Math.max(0, now - date.getTime())

    if (elapsedMs < 60_000) return t('launcher.freshness.relative.now')
    if (elapsedMs < 3_600_000) return t('launcher.freshness.relative.minutesAgo', { count: Math.floor(elapsedMs / 60_000) })
    if (elapsedMs < 86_400_000) return t('launcher.freshness.relative.hoursAgo', { count: Math.floor(elapsedMs / 3_600_000) })
    if (elapsedMs < 604_800_000) return t('launcher.freshness.relative.daysAgo', { count: Math.floor(elapsedMs / 86_400_000) })

    return new Intl.DateTimeFormat(locale || 'en', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric'
    }).format(date)
}
