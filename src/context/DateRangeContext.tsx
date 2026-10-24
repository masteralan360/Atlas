import React, { createContext, useContext, useState, useEffect, useSyncExternalStore } from 'react'
import {
    DATE_FILTER_DAY_BOUNDARY_CHANGE_EVENT,
    DEFAULT_DATE_FILTER_DAY_BOUNDARY,
    getDateFilterDayBoundary
} from '@/lib/dateRangeFilters'

export type DateRangeType = 'today' | 'yesterday' | 'month' | 'lastMonth' | 'allTime' | 'custom'

interface CustomDates {
    start: string
    end: string
}

interface DateRangeContextType {
    dateRange: DateRangeType
    customDates: CustomDates
    dateFilterDayBoundary: string
    setDateRange: (range: DateRangeType) => void
    setCustomDates: (dates: CustomDates | ((prev: CustomDates) => CustomDates)) => void
}

const DateRangeContext = createContext<DateRangeContextType | undefined>(undefined)

function subscribeToDateFilterDayBoundary(callback: () => void) {
    if (typeof window === 'undefined') return () => undefined

    window.addEventListener(DATE_FILTER_DAY_BOUNDARY_CHANGE_EVENT, callback)
    return () => window.removeEventListener(DATE_FILTER_DAY_BOUNDARY_CHANGE_EVENT, callback)
}

export function DateRangeProvider({ children }: { children: React.ReactNode }) {
    const dateFilterDayBoundary = useSyncExternalStore(
        subscribeToDateFilterDayBoundary,
        getDateFilterDayBoundary,
        () => DEFAULT_DATE_FILTER_DAY_BOUNDARY
    )
    const [dateRange, setDateRange] = useState<DateRangeType>(() => {
        // Migration: check for previous local page-specific settings first, then default to 'month'
        const cached = localStorage.getItem('global_date_range') ||
            localStorage.getItem('revenue_date_range') ||
            localStorage.getItem('sales_date_range')
        return (cached as DateRangeType) || 'month'
    })

    const [customDates, setCustomDates] = useState<CustomDates>(() => {
        const cached = localStorage.getItem('global_custom_dates') ||
            localStorage.getItem('revenue_custom_dates') ||
            localStorage.getItem('sales_custom_dates')
        return cached ? JSON.parse(cached) : { start: '', end: '' }
    })

    useEffect(() => {
        localStorage.setItem('global_date_range', dateRange)
    }, [dateRange])

    useEffect(() => {
        localStorage.setItem('global_custom_dates', JSON.stringify(customDates))
    }, [customDates])

    return (
        <DateRangeContext.Provider value={{ dateRange, customDates, dateFilterDayBoundary, setDateRange, setCustomDates }}>
            {children}
        </DateRangeContext.Provider>
    )
}

export function useDateRange() {
    const context = useContext(DateRangeContext)
    if (context === undefined) {
        throw new Error('useDateRange must be used within a DateRangeProvider')
    }
    return context
}
