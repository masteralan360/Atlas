import type { DateRangeType } from '@/context/DateRangeContext'
import { getDateRangeBounds, isDateInDateRange, type DateRangeCustomDates } from '@/lib/dateRangeFilters'
import type { AgentCommissionEntry, SalesOrder, SalesOrderAgentAssignment } from '@/local-db'

/** Filter reporting activity without changing live settlement obligations. */
export function filterAgentCommissionPeriod(
    entries: AgentCommissionEntry[],
    assignments: SalesOrderAgentAssignment[],
    salesOrders: SalesOrder[],
    dateRange: DateRangeType,
    customDates: DateRangeCustomDates,
    now = new Date(),
    dayBoundary?: string,
) {
    const bounds = getDateRangeBounds(dateRange, customDates, now, dayBoundary)
    const isScoped = Boolean(bounds.start || bounds.end)
    const inPeriod = (value: string | null | undefined) => isDateInDateRange(value, dateRange, customDates, now, dayBoundary)
    const activeEntries = entries.filter((entry) => !entry.isDeleted)
    // Historical fulfillment can be missing on legacy orders. Original accruals
    // retain that activity date even when their records were backfilled later.
    const accrualDateByOrderId = new Map<string, string>()
    for (const entry of activeEntries) {
        if (!entry.orderId || entry.kind !== 'accrual' || !Number.isFinite(Date.parse(entry.occurredAt))) continue
        const previous = accrualDateByOrderId.get(entry.orderId)
        if (!previous || Date.parse(entry.occurredAt) < Date.parse(previous)) {
            accrualDateByOrderId.set(entry.orderId, entry.occurredAt)
        }
    }
    const periodOrders = salesOrders.filter((order) => !order.isDeleted && inPeriod(
        order.actualDeliveryDate
        || (order.status === 'completed' ? accrualDateByOrderId.get(order.id) : undefined)
        || order.createdAt,
    ))
    const orderIds = new Set(periodOrders.map((order) => order.id))
    return {
        isScoped,
        entries: activeEntries.filter((entry) => inPeriod(entry.occurredAt)),
        assignments: assignments.filter((assignment) => !assignment.isDeleted && (!isScoped || orderIds.has(assignment.orderId))),
        salesOrders: periodOrders,
    }
}
