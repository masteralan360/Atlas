import { describe, expect, it } from 'vitest'

import ku from '@/i18n/locales/ku.json'
import { formatModulePageRelativeTime } from './modulePageFreshnessFormat'

const translations = {
    'launcher.freshness.relative.now': ku.launcher.freshness.relative.now,
    'launcher.freshness.relative.minutesAgo': ku.launcher.freshness.relative.minutesAgo,
    'launcher.freshness.relative.hoursAgo': ku.launcher.freshness.relative.hoursAgo,
    'launcher.freshness.relative.daysAgo': ku.launcher.freshness.relative.daysAgo
}

function t(key: string, options?: { count?: number }) {
    return translations[key as keyof typeof translations].replace('{{count}}', String(options?.count ?? ''))
}

describe('formatModulePageRelativeTime', () => {
    const now = new Date('2026-09-20T12:00:00.000Z').getTime()
    const timestampBefore = (milliseconds: number) => new Date(now - milliseconds).toISOString()

    it('uses the Kurdish label for recent and future updates', () => {
        expect(formatModulePageRelativeTime(timestampBefore(59_999), 'ku', t, now)).toBe('ئێستا')
        expect(formatModulePageRelativeTime(new Date(now + 60_000).toISOString(), 'ku', t, now)).toBe('ئێستا')
    })

    it('uses localized minutes, hours, and days at their boundaries', () => {
        expect(formatModulePageRelativeTime(timestampBefore(60_000), 'ku', t, now)).toBe('1 خولەک پێش ئێستا')
        expect(formatModulePageRelativeTime(timestampBefore(3_599_999), 'ku', t, now)).toBe('59 خولەک پێش ئێستا')
        expect(formatModulePageRelativeTime(timestampBefore(3_600_000), 'ku', t, now)).toBe('1 کاتژمێر پێش ئێستا')
        expect(formatModulePageRelativeTime(timestampBefore(86_400_000), 'ku', t, now)).toBe('1 ڕۆژ پێش ئێستا')
    })

    it('returns null for an invalid timestamp', () => {
        expect(formatModulePageRelativeTime('not-a-date', 'ku', t, now)).toBeNull()
    })
})
