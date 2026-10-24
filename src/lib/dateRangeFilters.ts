import type { DateRangeType } from '@/context/DateRangeContext'
import { getAppSettingSync, setAppSetting } from '@/local-db/settings'

export interface DateRangeCustomDates {
    start: string
    end: string
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^(\d{2}):(\d{2})$/

export const DATE_FILTER_DAY_BOUNDARY_KEY = 'date_filter_day_boundary'
export const DATE_FILTER_DAY_BOUNDARY_CHANGE_EVENT = 'atlas:date-filter-day-boundary-change'
export const DEFAULT_DATE_FILTER_DAY_BOUNDARY = '00:00'

let cachedDateFilterDayBoundary: string | undefined

export function normalizeDateFilterDayBoundary(value: string | null | undefined) {
    const match = value ? TIME_PATTERN.exec(value) : null
    if (!match) return DEFAULT_DATE_FILTER_DAY_BOUNDARY

    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 23 || minutes > 59) return DEFAULT_DATE_FILTER_DAY_BOUNDARY

    return `${match[1]}:${match[2]}`
}

/**
 * Returns the local display preference that defines when date filters roll to
 * the next day. This never changes the dates stored on business records.
 */
export function getDateFilterDayBoundary() {
    if (cachedDateFilterDayBoundary === undefined) {
        const storedValue = typeof localStorage === 'undefined'
            ? null
            : getAppSettingSync(DATE_FILTER_DAY_BOUNDARY_KEY)
        cachedDateFilterDayBoundary = normalizeDateFilterDayBoundary(storedValue)
    }

    return cachedDateFilterDayBoundary
}

export async function setDateFilterDayBoundary(value: string): Promise<void> {
    const normalizedValue = normalizeDateFilterDayBoundary(value)
    cachedDateFilterDayBoundary = normalizedValue
    await setAppSetting(DATE_FILTER_DAY_BOUNDARY_KEY, normalizedValue)

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(DATE_FILTER_DAY_BOUNDARY_CHANGE_EVENT, {
            detail: normalizedValue
        }))
    }
}

export interface DateRangeBounds {
    start?: Date
    /** Exclusive upper bound. */
    end?: Date
}

function toValidDate(value: Date | string | null | undefined, dateOnlyBoundary = DEFAULT_DATE_FILTER_DAY_BOUNDARY) {
    if (!value) return null
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value
    }

    const dateOnlyMatch = DATE_ONLY_PATTERN.exec(value)
    const date = dateOnlyMatch
        ? atDayBoundary(
            Number(dateOnlyMatch[1]),
            Number(dateOnlyMatch[2]) - 1,
            Number(dateOnlyMatch[3]),
            dateOnlyBoundary
        )
        : new Date(value)

    return Number.isNaN(date.getTime()) ? null : date
}

function getBoundaryTime(value: string) {
    const [hours, minutes] = normalizeDateFilterDayBoundary(value).split(':').map(Number)
    return { hours, minutes }
}

function atDayBoundary(year: number, month: number, date: number, boundary: string) {
    const { hours, minutes } = getBoundaryTime(boundary)
    return new Date(year, month, date, hours, minutes, 0, 0)
}

function getCurrentBusinessDayStart(now: Date, boundary: string) {
    const todayStart = atDayBoundary(now.getFullYear(), now.getMonth(), now.getDate(), boundary)
    if (now < todayStart) {
        todayStart.setDate(todayStart.getDate() - 1)
    }
    return todayStart
}

function addDays(date: Date, amount: number) {
    const result = new Date(date)
    result.setDate(result.getDate() + amount)
    return result
}

function getCustomDateBoundary(value: string, boundary: string) {
    const date = toValidDate(value)
    if (!date) return undefined

    return atDayBoundary(date.getFullYear(), date.getMonth(), date.getDate(), boundary)
}

/**
 * Resolves the selected filter into local timestamps. The end is exclusive so
 * a 10:00 boundary means "Today" is exactly 10:00 to the next 10:00.
 */
export function getDateRangeBounds(
    dateRange: DateRangeType,
    customDates: DateRangeCustomDates,
    now = new Date(),
    dayBoundary = getDateFilterDayBoundary()
): DateRangeBounds {
    if (dateRange === 'allTime' || (dateRange === 'custom' && !customDates.start && !customDates.end)) {
        return {}
    }

    const normalizedBoundary = normalizeDateFilterDayBoundary(dayBoundary)
    const currentBusinessDayStart = getCurrentBusinessDayStart(now, normalizedBoundary)

    if (dateRange === 'today') {
        return {
            start: currentBusinessDayStart,
            end: addDays(currentBusinessDayStart, 1)
        }
    }

    if (dateRange === 'yesterday') {
        return {
            start: addDays(currentBusinessDayStart, -1),
            end: currentBusinessDayStart
        }
    }

    if (dateRange === 'month' || dateRange === 'lastMonth') {
        const monthOffset = dateRange === 'lastMonth' ? -1 : 0
        const start = atDayBoundary(
            currentBusinessDayStart.getFullYear(),
            currentBusinessDayStart.getMonth() + monthOffset,
            1,
            normalizedBoundary
        )
        const end = atDayBoundary(
            currentBusinessDayStart.getFullYear(),
            currentBusinessDayStart.getMonth() + monthOffset + 1,
            1,
            normalizedBoundary
        )

        return { start, end }
    }

    const start = customDates.start
        ? getCustomDateBoundary(customDates.start, normalizedBoundary)
        : undefined
    const customEnd = customDates.end
        ? getCustomDateBoundary(customDates.end, normalizedBoundary)
        : undefined

    return {
        start,
        end: customEnd ? addDays(customEnd, 1) : undefined
    }
}

export function isDateInDateRange(
    value: Date | string | null | undefined,
    dateRange: DateRangeType,
    customDates: DateRangeCustomDates,
    now = new Date(),
    dayBoundary = getDateFilterDayBoundary()
) {
    const normalizedBoundary = normalizeDateFilterDayBoundary(dayBoundary)
    const date = toValidDate(value, normalizedBoundary)
    const { start, end } = getDateRangeBounds(dateRange, customDates, now, normalizedBoundary)

    if (!start && !end) return true
    if (!date) return false
    if (start && date < start) return false
    if (end && date >= end) return false
    return true
}
