import type { DateRangeType } from '@/context/DateRangeContext'
import { getDateRangeBounds, type DateRangeCustomDates } from '@/lib/dateRangeFilters'
import type { PartnerAccountStatementPeriod } from '@/lib/partnerAccountStatement'

/** Converts the shared date-range selection into this statement's inclusive period shape. */
export function createPartnerAccountStatementPeriod(
  dateRange: DateRangeType,
  customDates: DateRangeCustomDates
): PartnerAccountStatementPeriod {
  if (dateRange === 'allTime') return { type: 'allTime' }

  const { start, end } = getDateRangeBounds(dateRange, customDates)
  return {
    type: dateRange === 'yesterday' ? 'custom' : dateRange,
    start: start?.toISOString(),
    end: end ? new Date(end.getTime() - 1).toISOString() : undefined
  }
}
