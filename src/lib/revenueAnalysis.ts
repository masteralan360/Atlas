import type { SalesOrder } from '@/local-db'
import type { Sale } from '@/types'
import { convertToStoreBase } from '@/lib/currency'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import {
    getOrderLineInventoryQuantity,
    getOrderLinePaidQuantity,
    getOrderLineReturnedInventoryQuantity,
    getOrderLineReturnedPaidInventoryQuantity,
    getOrderLineUnitFactor
} from '@/lib/orderLineItems'

export interface RevenueAnalysisItem {
    productId: string
    productName: string
    /** Storage captured when this line was sold, when the source supports inventory storage. */
    storageId?: string | null
    productCategory?: string
    quantity: number
    returnedQuantity: number
    costQuantity?: number
    returnedCostQuantity?: number
    unitPrice: number
    costPrice: number
}

export interface RevenueAnalysisRecord {
    key: string
    id: string
    source: 'sale' | 'sales_order' | 'exchange' | 'real_estate' | 'activities' | 'clinical_appointment' | 'post_service' | 'car_rental' | 'travel_transportation'
    sourceRecordId?: string | null
    referenceCode: string
    date: string
    currency: string
    origin: string
    sourceChannel?: string | null
    cashierId?: string | null
    createdBy?: string | null
    cashier: string
    partyId?: string | null
    partyName?: string
    sequenceId?: number
    paymentMethod?: string | null
    notes?: string | null
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

export interface RevenueProductSalesSummary {
    totalSales: number
    productsSold: number
    unitsSold: number
}

export type RevenueCategoryLookup = {
    productCategoryByProductId?: ReadonlyMap<string, string | null | undefined> | Record<string, string | null | undefined>
}

type CustomDates = {
    start: string | null
    end: string | null
}

function getOrderRevenueDate(order: SalesOrder) {
    return order.actualDeliveryDate || order.updatedAt || order.createdAt
}

function getSaleRevenueSource(sale: Sale) {
    if (sale.origin === 'exchange') return 'exchange'
    if (sale.origin === 'real_estate') return 'real_estate'
    if (sale.origin === 'activities') return 'activities'
    if (sale.origin === 'clinical_appointment') return 'clinical_appointment'
    if (sale.origin === 'post_service') return 'post_service'
    if (sale.origin === 'car_rental') return 'car_rental'
    if (sale.origin === 'travel_transportation') return 'travel_transportation'
    return 'sale'
}

function normalizeRevenueCategory(value: string | null | undefined) {
    const trimmed = value?.trim()
    return trimmed || undefined
}

function getProductCategoryFromLookup(productId: string, options?: RevenueCategoryLookup) {
    const lookup = options?.productCategoryByProductId
    if (!lookup) return undefined

    if (typeof (lookup as ReadonlyMap<string, string | null | undefined>).get === 'function') {
        return normalizeRevenueCategory((lookup as ReadonlyMap<string, string | null | undefined>).get(productId))
    }

    return normalizeRevenueCategory((lookup as Record<string, string | null | undefined>)[productId])
}

function resolveRevenueCategory(productId: string, candidates: Array<string | null | undefined>, options?: RevenueCategoryLookup) {
    const mappedCategory = getProductCategoryFromLookup(productId, options)
    if (mappedCategory) return mappedCategory

    for (const candidate of candidates) {
        const category = normalizeRevenueCategory(candidate)
        if (category) return category
    }

    return 'Uncategorized'
}

export function toRevenueRecordFromSale(sale: Sale, options: RevenueCategoryLookup = {}): RevenueAnalysisRecord {
    const externalSourceRecordId = (sale as Sale & {
        _realEstateTransactionId?: string | null
        _clinicalAppointmentId?: string | null
        _activityTransactionId?: string | null
        _rentalContractId?: string | null
        _travelBookingId?: string | null
    })._realEstateTransactionId
        || (sale as Sale & { _clinicalAppointmentId?: string | null })._clinicalAppointmentId
        || (sale as Sale & { _activityTransactionId?: string | null })._activityTransactionId
        || (sale as Sale & { _rentalContractId?: string | null })._rentalContractId
        || (sale as Sale & { _travelBookingId?: string | null })._travelBookingId
        || null
    const transactionNo = (sale as Sale & { _transactionNo?: string | null })._transactionNo
    const cashierId = sale.cashier_id || (sale as Sale & { cashierId?: string | null }).cashierId || null
    const paymentMethod = sale.payment_method || (sale as Sale & { paymentMethod?: string | null }).paymentMethod || null
    const partyId = (sale as Sale & {
        businessPartnerId?: string | null
        business_partner_id?: string | null
        customerId?: string | null
        customer_id?: string | null
    }).businessPartnerId
        || (sale as Sale & { business_partner_id?: string | null }).business_partner_id
        || (sale as Sale & { customerId?: string | null }).customerId
        || (sale as Sale & { customer_id?: string | null }).customer_id
        || null

    return {
        key: `sale:${sale.id}`,
        id: sale.id,
        source: getSaleRevenueSource(sale),
        sourceRecordId: externalSourceRecordId,
        referenceCode: transactionNo || (sale.sequenceId ? `#${String(sale.sequenceId).padStart(5, '0')}` : `#${sale.id.split('-')[0]}`),
        date: sale.created_at,
        currency: sale.settlement_currency || 'usd',
        origin: sale.origin,
        cashierId,
        createdBy: cashierId,
        cashier: sale.cashier_name || 'Staff',
        partyId,
        partyName: (sale as Sale & { partyName?: string; _counterpartyName?: string }).partyName
            || (sale as Sale & { partyName?: string; _counterpartyName?: string })._counterpartyName,
        sequenceId: sale.sequenceId,
        paymentMethod,
        notes: sale.notes || null,
        hasPartialReturn: !!sale.has_partial_return,
        isReturned: !!sale.is_returned,
        items: (sale.items || []).map((item) => ({
            productId: item.product_id,
            productName: item.product_name || item.product?.name || 'Unknown Product',
            storageId: item.storage_id || null,
            productCategory: resolveRevenueCategory(item.product_id, [item.product_category, item.product?.category], options),
            quantity: item.quantity || 0,
            returnedQuantity: item.is_returned ? (item.quantity || 0) : (item.returned_quantity || 0),
            unitPrice: item.converted_unit_price || item.unit_price || 0,
            costPrice: item.converted_cost_price || item.cost_price || 0
        }))
    }
}

export function toRevenueRecordFromSalesOrder(order: SalesOrder, options: RevenueCategoryLookup = {}): RevenueAnalysisRecord {
    return {
        key: `sales_order:${order.id}`,
        id: order.id,
        source: 'sales_order',
        referenceCode: order.orderNumber,
        date: getOrderRevenueDate(order),
        currency: order.currency || 'usd',
        origin: 'sales_order',
        sourceChannel: order.sourceChannel || null,
        cashierId: order.createdBy || null,
        createdBy: order.createdBy || null,
        cashier: '',
        partyId: order.businessPartnerId || order.customerId || null,
        partyName: order.customerName,
        paymentMethod: order.paymentMethod || null,
        notes: order.notes || null,
        hasPartialReturn: order.returnStatus === 'partial',
        isReturned: order.returnStatus === 'full',
        items: (order.items || []).map((item) => {
            const categorySource = item as typeof item & {
                productCategory?: string | null
                product_category?: string | null
                categoryName?: string | null
                category?: string | null
            }

            return {
                productId: item.productId,
                productName: item.productName || 'Unknown Product',
                storageId: item.storageId || order.sourceStorageId || null,
                productCategory: resolveRevenueCategory(item.productId, [
                    categorySource.productCategory,
                    categorySource.product_category,
                    categorySource.categoryName,
                    categorySource.category
                ], options),
                quantity: getOrderLinePaidQuantity(item),
                returnedQuantity: Math.min(
                    getOrderLinePaidQuantity(item),
                    getOrderLineReturnedPaidInventoryQuantity(item) / getOrderLineUnitFactor(item)
                ),
                costQuantity: getOrderLineInventoryQuantity(item),
                returnedCostQuantity: Math.min(
                    getOrderLineInventoryQuantity(item),
                    getOrderLineReturnedInventoryQuantity(item)
                ),
                unitPrice: item.convertedUnitPrice || 0,
                costPrice: item.convertedCostPrice || item.costPrice || 0
            }
        })
    }
}

export function buildRevenueAnalysisRecords(
    sales: Sale[],
    salesOrders: SalesOrder[],
    options: RevenueCategoryLookup = {}
): RevenueAnalysisRecord[] {
    return [
        ...sales.map((sale) => toRevenueRecordFromSale(sale, options)),
        ...salesOrders
            .filter((order) => !order.isDeleted && order.status === 'completed')
            .map((order) => toRevenueRecordFromSalesOrder(order, options))
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

export function isRecordInDateRange(
    date: string,
    dateRange: string,
    customDates: CustomDates,
    now = new Date()
) {
    return isDateInDateRange(
        date,
        dateRange as Parameters<typeof isDateInDateRange>[1],
        { start: customDates.start || '', end: customDates.end || '' },
        now
    )
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
        const netCostQuantity = Math.max(0, (item.costQuantity ?? item.quantity) - (item.returnedCostQuantity ?? item.returnedQuantity))
        if (netQuantity <= 0 && netCostQuantity <= 0) continue

        revenue += item.unitPrice * netQuantity
        cost += item.costPrice * netCostQuantity
    }

    const profit = revenue - cost
    return {
        revenue,
        cost,
        profit,
        margin: revenue > 0 ? (profit / revenue) * 100 : 0
    }
}

/**
 * Keeps only the revenue lines that were sold from a selected storage.
 *
 * A transaction may contain products from multiple storages. Returning a copy
 * with only matching lines makes all downstream totals, charts, and product
 * summaries reflect the selected storage instead of the whole transaction.
 */
export function filterRevenueRecordsByStorage(
    records: RevenueAnalysisRecord[],
    storageId: string
) {
    if (storageId === 'all') {
        return records
    }

    return records.flatMap((record) => {
        const items = record.items.filter((item) => item.storageId === storageId)
        return items.length > 0 ? [{ ...record, items }] : []
    })
}

export function getRevenueProductSalesSummary(records: RevenueAnalysisRecord[]): RevenueProductSalesSummary {
    const soldProductKeys = new Set<string>()
    let unitsSold = 0

    for (const record of records) {
        if (record.isReturned) continue

        for (const item of record.items) {
            const netQuantity = Math.max(0, item.quantity - item.returnedQuantity)
            if (netQuantity <= 0) continue

            const productKey = item.productId.trim() || `name:${item.productName.trim().toLowerCase()}`
            soldProductKeys.add(productKey)
            unitsSold += netQuantity
        }
    }

    return {
        totalSales: records.length,
        productsSold: soldProductKeys.size,
        unitsSold
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
    const isFullyReturned = record.isReturned
        || ((record.source !== 'sales_order' || !record.hasPartialReturn)
            && record.items.length > 0
            && record.items.every((item) => item.returnedQuantity >= item.quantity))
    const totalReturnedQuantity = record.items.reduce((sum, item) => sum + item.returnedQuantity, 0)

    return {
        isFullyReturned,
        hasAnyReturn: totalReturnedQuantity > 0,
        totalReturnedQuantity
    }
}
