import type { CurrencyCode, SalesOrder } from '@/local-db'
import type { RevenueAnalysisRecord } from '@/lib/revenueAnalysis'
import { getRevenueAnalysisTotals, toRevenueRecordFromSalesOrder } from '@/lib/revenueAnalysis'
import type { LedgerCashMovementEntry } from '@/lib/ledgerCashMovementEntries'
import { summarizeLedgerCashMovements, type LedgerCashSummary } from '@/lib/ledgerCashSummary'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'

export type DashboardPeriod = 'today' | 'thisWeek' | 'lastMonth' | 'thisMonth'
export type DashboardMetric = 'netCashRevenue' | 'cashOperatingSurplus'
export type DashboardCashMetric = 'cashRevenueReceived' | 'cashRefundsPaid' | DashboardMetric | 'operatingCashPaid'

export function getDashboardPeriodBounds(period: DashboardPeriod, now = new Date()) {
    const range = period === 'lastMonth' ? 'lastMonth' : period === 'thisMonth' ? 'month' : 'today'
    const bounds = getDateRangeBounds(range, { start: '', end: '' }, now)
    const start = new Date(bounds.start!)
    const end = new Date(bounds.end!)
    if (period === 'thisWeek') start.setDate(start.getDate() - ((start.getDay() + 1) % 7))
    return { start, end }
}

export function isInDashboardPeriod(date: string, period: DashboardPeriod, now = new Date()) {
    const timestamp = new Date(date).getTime()
    const { start, end } = getDashboardPeriodBounds(period, now)
    return isWithinBounds(timestamp, start.getTime(), end.getTime())
}

function isWithinBounds(timestamp: number, start: number, end: number) {
    return Number.isFinite(timestamp) && timestamp >= start && timestamp < end
}

export function getDashboardCashSummaries(
    entries: readonly LedgerCashMovementEntry[],
    period: DashboardPeriod,
    now = new Date(),
) {
    const byCurrency = new Map<CurrencyCode, LedgerCashMovementEntry[]>()
    const { start, end } = getDashboardPeriodBounds(period, now)
    entries
        .filter((entry) => isWithinBounds(new Date(entry.date).getTime(), start.getTime(), end.getTime()))
        .forEach((entry) => {
            const group = byCurrency.get(entry.currency) || []
            group.push(entry)
            byCurrency.set(entry.currency, group)
        })
    return Array.from(byCurrency, ([currency, rows]) => ({ currency, summary: summarizeLedgerCashMovements(rows) }))
}

export function getDashboardCashTrend(
    entries: readonly LedgerCashMovementEntry[],
    period: DashboardPeriod,
    currency: CurrencyCode,
    metric: DashboardCashMetric,
    now = new Date(),
) {
    const { start, end } = getDashboardPeriodBounds(period, now)
    const hourly = period === 'today'
    const points: { timestamp: number; value: number }[] = []
    for (
        let cursor = new Date(start);
        cursor < end;
        hourly ? cursor.setHours(cursor.getHours() + 1) : cursor.setDate(cursor.getDate() + 1)
    ) {
        points.push({ timestamp: cursor.getTime(), value: 0 })
    }
    const groups = points.map(() => [] as LedgerCashMovementEntry[])
    entries.forEach((entry) => {
        const timestamp = new Date(entry.date).getTime()
        if (entry.currency !== currency || !isWithinBounds(timestamp, start.getTime(), end.getTime())) return
        const index = points.findIndex(
            (point, position) =>
                timestamp >= point.timestamp &&
                (position === points.length - 1 || timestamp < points[position + 1].timestamp),
        )
        if (groups[index]) groups[index].push(entry)
    })
    return points.map((point, index) => ({
        ...point,
        value: getDashboardMetricValue(summarizeLedgerCashMovements(groups[index]), metric),
    }))
}

export interface DashboardTransaction {
    record: RevenueAnalysisRecord
    status: SalesOrder['status'] | 'sold' | 'returned'
    revenue: number
    profit: number
}

export function getDashboardTransactions(
    records: readonly RevenueAnalysisRecord[],
    orders: readonly SalesOrder[],
    limit = 8,
): DashboardTransaction[] {
    const orderById = new Map(orders.map((order) => [order.id, order] as const))
    const existing = new Set(records.filter((record) => record.source === 'sales_order').map((record) => record.id))
    const pending = orders
        .filter((order) => !order.isDeleted && !existing.has(order.id))
        .map(toRevenueRecordFromSalesOrder)
    return [...records, ...pending]
        .map((record) => {
            const totals = getRevenueAnalysisTotals(record)
            const order = record.source === 'sales_order' ? orderById.get(record.id) : undefined
            return {
                record,
                status: order?.status || (record.isReturned ? 'returned' : 'sold'),
                revenue: order && order.status !== 'completed' ? 0 : totals.revenue,
                profit: order && order.status !== 'completed' ? 0 : totals.profit,
            } satisfies DashboardTransaction
        })
        .sort((a, b) => new Date(b.record.date).getTime() - new Date(a.record.date).getTime())
        .slice(0, limit)
}

export function getDashboardPartnerProfit(
    records: readonly RevenueAnalysisRecord[],
    period: DashboardPeriod,
    currency: string,
    partnerNameById: ReadonlyMap<string, string>,
    now = new Date(),
) {
    const profits = new Map<string, { name: string; profit: number }>()
    const { start, end } = getDashboardPeriodBounds(period, now)
    records.forEach((record) => {
        if (
            record.currency !== currency ||
            !isWithinBounds(new Date(record.date).getTime(), start.getTime(), end.getTime())
        )
            return
        const partnerId = record.partyId || ''
        const name = partnerNameById.get(partnerId) || record.partyName?.trim()
        if (!partnerId || !name) return
        const current = profits.get(partnerId) || { name, profit: 0 }
        current.profit += getRevenueAnalysisTotals(record).profit
        profits.set(partnerId, current)
    })
    return Array.from(profits, ([id, value]) => ({ id, ...value, profit: Number(value.profit.toFixed(8)) }))
        .filter((item) => item.profit > 0)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 5)
}

export function getDashboardMetricValue(summary: LedgerCashSummary, metric: DashboardCashMetric) {
    return metric === 'netCashRevenue' || metric === 'cashOperatingSurplus'
        ? summary[metric]
        : summary.buckets[metric].amount
}
