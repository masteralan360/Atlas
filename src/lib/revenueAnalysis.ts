import type { SalesOrder } from '@/local-db'
import type { Sale } from '@/types'
import { convertToStoreBase } from '@/lib/currency'

export interface RevenueAnalysisItem {
    productId: string
    productName: string
    productCategory?: string
    quantity: number
    returnedQuantity: number
    unitPrice: number
    costPrice: number
}

export interface RevenueAnalysisRecord {
    key: string
    id: string
    source: 'sale' | 'sales_order' | 'travel_agency'
    referenceCode: string
    date: string
    currency: string
    origin: string
    sourceChannel?: string | null
    cashier: string
    partyName?: string
    sequenceId?: number
    hasPartialReturn: boolean
    isReturned: boolean
    items: RevenueAnalysisItem[]
}

export interface RevenueAnalysisTotals {
    revenue: number
    cost: number
    profit: number
    margin: number
}

type CustomDates = {
    start: string | null
    end: string | null
}

function getStartOfToday(now: Date) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
}

function getStartOfMonth(now: Date) {
    return new Date(now.getFullYear(), now.getMonth(), 1)
}

function getOrderRevenueDate(order: SalesOrder) {
    return order.actualDeliveryDate || order.updatedAt || order.createdAt
}

export function toRevenueRecordFromSale(sale: Sale): RevenueAnalysisRecord {
    return {
        key: `sale:${sale.id}`,
        id: sale.id,
        source: sale.origin === 'travel_agency' ? 'travel_agency' : 'sale',
        referenceCode: sale.sequenceId ? `#${String(sale.sequenceId).padStart(5, '0')}` : `#${sale.id.split('-')[0]}`,
        date: sale.created_at,
        currency: sale.settlement_currency || 'usd',
        origin: sale.origin,
        cashier: sale.cashier_name || 'Staff',
        sequenceId: sale.sequenceId,
        hasPartialReturn: !!sale.has_partial_return,
        isReturned: !!sale.is_returned,
        items: (sale.items || []).map((item) => ({
            productId: item.product_id,
            productName: item.product_name || item.product?.name || 'Unknown Product',
            productCategory: item.product_category || item.product?.category || 'Uncategorized',
            quantity: item.quantity || 0,
            returnedQuantity: item.is_returned ? (item.quantity || 0) : (item.returned_quantity || 0),
            unitPrice: item.converted_unit_price || item.unit_price || 0,
            costPrice: item.converted_cost_price || item.cost_price || 0
        }))
    }
}

export function toRevenueRecordFromSalesOrder(order: SalesOrder): RevenueAnalysisRecord {
    return {
        key: `sales_order:${order.id}`,
        id: order.id,
        source: 'sales_order',
        referenceCode: order.orderNumber,
        date: getOrderRevenueDate(order),
        currency: order.currency || 'usd',
        origin: 'sales_order',
        sourceChannel: order.sourceChannel || null,
        cashier: '',
        partyName: order.customerName,
        hasPartialReturn: false,
        isReturned: false,
        items: (order.items || []).map((item) => ({
            productId: item.productId,
            productName: item.productName || 'Unknown Product',
            productCategory: 'Uncategorized',
            quantity: item.quantity || 0,
            returnedQuantity: 0,
            unitPrice: item.convertedUnitPrice || 0,
            costPrice: item.convertedCostPrice || item.costPrice || 0
        }))
    }
}

export function buildRevenueAnalysisRecords(sales: Sale[], salesOrders: SalesOrder[], travelAgencySales: Sale[] = []): RevenueAnalysisRecord[] {
    return [
        ...sales.map(toRevenueRecordFromSale),
        ...salesOrders
            .filter((order) => !order.isDeleted && order.status === 'completed')
            .map(toRevenueRecordFromSalesOrder),
        ...travelAgencySales.map(toRevenueRecordFromSale)
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

export function isRecordInDateRange(
    date: string,
    dateRange: string,
    customDates: CustomDates,
    now = new Date()
) {
    const value = new Date(date)

    if (dateRange === 'today') {
        return value >= getStartOfToday(now)
    }

    if (dateRange === 'month') {
        return value >= getStartOfMonth(now)
    }

    if (dateRange === 'custom' && (customDates.start || customDates.end)) {
        const start = customDates.start ? new Date(customDates.start) : null
        if (start) start.setHours(0, 0, 0, 0)
        const end = customDates.end ? new Date(customDates.end) : null
        if (end) end.setHours(23, 59, 59, 999)
        if (start && value < start) return false
        if (end && value > end) return false
        return true
    }

    return true
}

export function filterRevenueAnalysisRecords(
    records: RevenueAnalysisRecord[],
    dateRange: string,
    customDates: CustomDates,
    now = new Date()
) {
    return records.filter((record) => isRecordInDateRange(record.date, dateRange, customDates, now))
}

export function filterSalesByDateRange(
    sales: Sale[],
    dateRange: string,
    customDates: CustomDates,
    now = new Date()
) {
    return sales
        .filter((sale) => isRecordInDateRange(sale.created_at, dateRange, customDates, now))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export function getRevenueAnalysisTotals(record: RevenueAnalysisRecord): RevenueAnalysisTotals {
    if (record.isReturned) {
        return {
            revenue: 0,
            cost: 0,
            profit: 0,
            margin: 0
        }
    }

    let revenue = 0
    let cost = 0
    for (const item of record.items) {
        const netQuantity = Math.max(0, item.quantity - item.returnedQuantity)
        if (netQuantity <= 0) continue

        revenue += item.unitPrice * netQuantity
        cost += item.costPrice * netQuantity
    }

    const profit = revenue - cost
    return {
        revenue,
        cost,
        profit,
        margin: revenue > 0 ? (profit / revenue) * 100 : 0
    }
}

export function calculateRevenueAnalysisNetProfitBase(
    records: RevenueAnalysisRecord[],
    baseCurrency: string,
    rates: {
        usd_iqd: number
        eur_iqd: number
        try_iqd: number
    }
) {
    return records.reduce((sum, record) => {
        const totals = getRevenueAnalysisTotals(record)
        return sum + convertToStoreBase(totals.profit, record.currency || baseCurrency, baseCurrency, rates)
    }, 0)
}

export function getRevenueRecordReturnSummary(record: RevenueAnalysisRecord) {
    if (record.source !== 'sale') {
        return {
            isFullyReturned: false,
            hasAnyReturn: false,
            totalReturnedQuantity: 0
        }
    }

    const isFullyReturned = record.isReturned
        || (record.items.length > 0 && record.items.every((item) => item.returnedQuantity >= item.quantity))
    const totalReturnedQuantity = record.items.reduce((sum, item) => sum + item.returnedQuantity, 0)

    return {
        isFullyReturned,
        hasAnyReturn: totalReturnedQuantity > 0,
        totalReturnedQuantity
    }
}
