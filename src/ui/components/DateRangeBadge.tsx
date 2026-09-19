import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { type DateRangeType, useDateRange } from '@/context/DateRangeContext'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { formatDate, cn } from '@/lib/utils'

type CustomDates = {
    start: string
    end: string
}

interface DateRangeBadgeProps {
    children?: ReactNode
    className?: string
    dateRange?: DateRangeType
    customDates?: CustomDates
}

function getDateRangeLabel(
    dateRange: DateRangeType,
    customDates: CustomDates,
    language: string,
    t: (key: string, options?: Record<string, unknown>) => string
) {
    const now = new Date()

    if (dateRange === 'today') return formatDate(now)
    if (dateRange === 'yesterday') {
        const yesterday = new Date(now)
        yesterday.setDate(yesterday.getDate() - 1)
        return formatDate(yesterday)
    }
    if (dateRange === 'month') return formatLocalizedMonthYear(now, language)
    if (dateRange === 'lastMonth') {
        return formatLocalizedMonthYear(new Date(now.getFullYear(), now.getMonth() - 1, 1), language)
    }
    if (dateRange === 'allTime') return t('performance.filters.allTime', { defaultValue: 'All Time' })

    const parts = [
        customDates.start ? `${t('performance.filters.from', { defaultValue: 'From' })} ${formatDate(customDates.start)}` : '',
        customDates.end ? `${t('performance.filters.to', { defaultValue: 'To' })} ${formatDate(customDates.end)}` : ''
    ].filter(Boolean)

    return parts.join(' ')
}

/**
 * Displays the active date range beside a page heading.
 */
export function DateRangeBadge({ children, className, dateRange, customDates }: DateRangeBadgeProps) {
    const { dateRange: contextDateRange, customDates: contextCustomDates } = useDateRange()
    const { t, i18n } = useTranslation()
    const label = children ?? getDateRangeLabel(
        dateRange ?? contextDateRange,
        customDates ?? contextCustomDates,
        i18n.language,
        t
    )

    if (!label) return null

    return (
        <span
            className={cn(
                'animate-pop-in rounded-lg bg-primary px-3 py-1 text-sm font-bold text-primary-foreground shadow-sm',
                className
            )}
            data-component="daterangebadge"
        >
            {label}
        </span>
    )
}
