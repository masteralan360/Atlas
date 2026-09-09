import { useState, useEffect, useMemo, useRef } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { useAuth } from '@/auth'
import { Sale } from '@/types'
import { applySalesOrderReturnQuantities, getActiveTravelBookingPayments, useCategories, useProducts, useSales, useSalesOrderReturnItemsForWorkspace, useSalesOrders, useStorages, useExchangeTransactions, usePaymentTransactions, useClinicalAppointments, useActivityTransactions, useActivityTransactionLinesForWorkspace, useWorkspaceUsers, useBusinessPartners, useDeliveryMerchantProfiles, useDeliveryShipments, useRentalContracts, useRentalVehicles, toUISale, toUISaleFromExchangeTransaction, toUISaleFromRealEstateCommissionTransaction, toUISaleFromPaidClinicalAppointment, toUISaleFromActivityTransaction, toUISaleFromDeliveryShipment, toUISaleFromRentalContract, toUISaleFromTravelBookingPayment } from '@/local-db'
import { formatCurrency, formatDateTime, formatDate, formatTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { isMobile } from '@/lib/platform'
import { getReportOriginId } from '@/lib/printIdentity'
import { useWorkspace } from '@/workspace'
import { useDateRange } from '@/context/DateRangeContext'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { ProductAutocompleteInput } from '@/ui/components/orders/ProductAutocompleteInput'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    TooltipProvider,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SaleDetailsModal,
    MetricDetailModal,
    TopProductsModal,
    ProductSalesSummaryModal,
    SalesOverviewModal,
    PeakTradingModal,
    ReturnsAnalysisModal,
    PrintPreviewModal,
    AppPagination
} from '@/ui/components'
import { MiniHeatmap } from '@/ui/components/revenue/MiniHeatmap'
import type { MetricType } from '@/ui/components/MetricDetailModal'
import {
    Check,
    Square,
    X,
    FileSpreadsheet,
    Loader2,
    TrendingDown,
    DollarSign,
    TrendingUp,
    Package,
    Percent,
    BarChart3,
    Clock,
    ArrowRight,
    RotateCcw,
    Printer,
    Info,
    Grid3X3,
    LayoutGrid,
    List,
    Users,
    Search,
    SlidersHorizontal
} from 'lucide-react'
import { useTheme } from '@/ui/components/theme-provider'
import { Button, ExportPreviewModal, Progress } from '@/ui/components'
import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis } from 'recharts'
import {
    buildRevenueAnalysisRecords,
    filterRevenueAnalysisRecords,
    filterRevenueRecordsByStorage,
    filterSalesByDateRange,
    getRevenueAnalysisTotals,
    getRevenueProductSalesSummary,
    getRevenueRecordReturnSummary,
    type RevenueAnalysisRecord
} from '@/lib/revenueAnalysis'

type RevenueSortOption =
    | 'date_desc'
    | 'date_asc'
    | 'revenue_desc'
    | 'revenue_asc'
    | 'cost_desc'
    | 'cost_asc'
    | 'profit_desc'
    | 'profit_asc'
    | 'margin_desc'
    | 'margin_asc'
    | 'cashier_asc'
    | 'cashier_desc'
    | 'origin_asc'
    | 'origin_desc'

type RevenueReturnStatusFilter = 'all' | 'non_returned' | 'partial' | 'returned'
type RevenueProfitStatusFilter = 'all' | 'profitable' | 'break_even' | 'loss'
type RevenueDayFilter = 'all' | '0' | '1' | '2' | '3' | '4' | '5' | '6'

interface RevenueFilterState {
    search: string
    origin: string
    sourceChannel: string
    cashier: string
    party: string
    partyPartnerId: string
    partySearch: string
    currency: string
    paymentMethod: string
    category: string
    product: string
    productSearch: string
    storage: string
    returnStatus: RevenueReturnStatusFilter
    profitStatus: RevenueProfitStatusFilter
    dayOfWeek: RevenueDayFilter
    hour: string
    minRevenue: string
    maxRevenue: string
    minCost: string
    maxCost: string
    minProfit: string
    maxProfit: string
    minMargin: string
    maxMargin: string
    sort: RevenueSortOption
}

const DEFAULT_REVENUE_FILTERS: RevenueFilterState = {
    search: '',
    origin: 'all',
    sourceChannel: 'all',
    cashier: 'all',
    party: 'all',
    partyPartnerId: '',
    partySearch: '',
    currency: 'all',
    paymentMethod: 'all',
    category: 'all',
    product: 'all',
    productSearch: '',
    storage: 'all',
    returnStatus: 'all',
    profitStatus: 'all',
    dayOfWeek: 'all',
    hour: 'all',
    minRevenue: '',
    maxRevenue: '',
    minCost: '',
    maxCost: '',
    minProfit: '',
    maxProfit: '',
    minMargin: '',
    maxMargin: '',
    sort: 'date_desc'
}

function countActiveRevenueFilters(filters: RevenueFilterState) {
    return [
        !!filters.search.trim(),
        filters.origin !== 'all',
        filters.sourceChannel !== 'all',
        filters.cashier !== 'all',
        filters.party !== 'all',
        filters.currency !== 'all',
        filters.paymentMethod !== 'all',
        filters.category !== 'all',
        filters.product !== 'all',
        filters.storage !== 'all',
        filters.returnStatus !== 'all',
        filters.profitStatus !== 'all',
        filters.dayOfWeek !== 'all',
        filters.hour !== 'all',
        !!filters.minRevenue,
        !!filters.maxRevenue,
        !!filters.minCost,
        !!filters.maxCost,
        !!filters.minProfit,
        !!filters.maxProfit,
        !!filters.minMargin,
        !!filters.maxMargin,
        filters.sort !== 'date_desc'
    ].filter(Boolean).length
}

function parseOptionalNumber(value: string) {
    if (!value.trim()) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function normalizeRevenueFilterValue(value: string | null | undefined) {
    return value?.trim().toLowerCase() || ''
}

function getRevenueStaffId(record: RevenueAnalysisRecord) {
    return record.cashierId?.trim() || record.createdBy?.trim() || ''
}

function getRevenueStaffKey(record: RevenueAnalysisRecord) {
    const staffId = getRevenueStaffId(record)
    if (staffId) return `id:${staffId}`

    const cashier = record.cashier?.trim()
    if (cashier) return `name:${cashier.toLowerCase()}`

    return 'unknown'
}

function getRevenueStaffLabel(record: RevenueAnalysisRecord, userNameById?: ReadonlyMap<string, string>) {
    const staffId = getRevenueStaffId(record)
    if (staffId) {
        return userNameById?.get(staffId) || record.cashier?.trim() || staffId
    }

    return record.cashier?.trim() || 'Unknown'
}

function getRevenuePaymentMethod(record: RevenueAnalysisRecord) {
    return normalizeRevenueFilterValue(record.paymentMethod) || 'unknown'
}

function getRevenueProductKey(item: RevenueAnalysisRecord['items'][number]) {
    return item.productId?.trim() || `name:${normalizeRevenueFilterValue(item.productName)}`
}

function getRevenueReturnStatus(record: RevenueAnalysisRecord): Exclude<RevenueReturnStatusFilter, 'all'> {
    const totalQuantity = record.items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0)
    const returnedQuantity = record.items.reduce((sum, item) => sum + Math.max(0, Number(item.returnedQuantity || 0)), 0)
    const fullyReturned = record.isReturned || (totalQuantity > 0 && returnedQuantity >= totalQuantity)

    if (fullyReturned) return 'returned'
    if (record.hasPartialReturn || returnedQuantity > 0) return 'partial'
    return 'non_returned'
}

function getRevenueProfitStatus(profit: number): Exclude<RevenueProfitStatusFilter, 'all'> {
    if (Math.abs(profit) < 0.005) return 'break_even'
    return profit > 0 ? 'profitable' : 'loss'
}

function revenuePaymentMethodLabel(value: string | null | undefined, t: any) {
    switch (value) {
        case 'bank_transfer':
            return t('ledger.paymentMethod.bankTransfer', { defaultValue: 'Bank Transfer' })
        case 'credit':
            return t('ledger.paymentMethod.credit', { defaultValue: 'Credit' })
        case 'hawala':
            return t('ledger.paymentMethod.hawala', { defaultValue: 'Hawala' })
        case 'loan_adjustment':
            return t('ledger.paymentMethod.loanAdjustment', { defaultValue: 'Loan Adjustment' })
        case 'qicard':
            return t('ledger.paymentMethod.qicard', { defaultValue: 'QiCard' })
        case 'zaincash':
            return t('ledger.paymentMethod.zaincash', { defaultValue: 'ZainCash' })
        case 'fastpay':
            return t('ledger.paymentMethod.fastpay', { defaultValue: 'FastPay' })
        case 'fib':
            return t('ledger.paymentMethod.fib', { defaultValue: 'FIB' })
        case 'cash':
            return t('ledger.paymentMethod.cash', { defaultValue: 'Cash' })
        case 'loan':
            return t('ledger.paymentMethod.loan', { defaultValue: 'Loan' })
        case 'unknown':
            return t('ledger.paymentMethod.unknown', { defaultValue: 'Unknown' })
        default:
            return value ? value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) : t('ledger.paymentMethod.unknown', { defaultValue: 'Unknown' })
    }
}

function humanizeRevenueFilterValue(value: string | null | undefined) {
    return value ? value.replace(/[_-]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) : ''
}

function revenueOriginLabel(origin: string | null | undefined, sourceChannel: string | null | undefined, t: any) {
    if ((sourceChannel || '').trim().toLowerCase() === 'marketplace') {
        return t('revenue.filters.origins.ecommerce', { defaultValue: 'E-Commerce' })
    }

    const normalized = (origin || 'pos').trim().toLowerCase().replace(/[-\s]+/g, '_')

    switch (normalized) {
        case 'pos':
            return t('revenue.filters.origins.pos', { defaultValue: 'POS' })
        case 'instant_pos':
            return t('revenue.filters.origins.instantPos', { defaultValue: 'Instant POS' })
        case 'sales_order':
            return t('revenue.filters.origins.salesOrder', { defaultValue: 'Sales Order' })
        case 'purchase_order':
            return t('revenue.filters.origins.purchaseOrder', { defaultValue: 'Purchase Order' })
        case 'order_report':
            return t('revenue.filters.origins.orderReport', { defaultValue: 'Order Report' })
        case 'ecommerce':
        case 'e_commerce':
            return t('revenue.filters.origins.ecommerce', { defaultValue: 'E-Commerce' })
        case 'real_estate':
            return t('revenue.filters.origins.realEstate', { defaultValue: 'Real Estate' })
        case 'activities':
            return t('revenue.filters.origins.activities', { defaultValue: 'Activities' })
        case 'clinical_appointment':
            return t('revenue.filters.origins.appointments', { defaultValue: 'Appointments' })
        case 'agents':
        case 'agent':
            return t('revenue.filters.origins.agents', { defaultValue: 'Agents' })
        case 'accounting':
        case 'budget':
            return t('revenue.filters.origins.accounting', { defaultValue: 'Accounting' })
        case 'manual':
            return t('revenue.filters.origins.manual', { defaultValue: 'Manual' })
        case 'business_partner':
            return t('revenue.filters.origins.businessPartner', { defaultValue: 'Business Partner' })
        case 'loans':
        case 'loan':
            return t('revenue.filters.origins.loans', { defaultValue: 'Loans' })
        case 'loan_report':
            return t('revenue.filters.origins.loanReport', { defaultValue: 'Loan Report' })
        case 'upload':
        case 'uploads':
            return t('revenue.filters.origins.upload', { defaultValue: 'Upload' })
        case 'exchange':
            return t('revenue.filters.origins.exchange', { defaultValue: 'Exchange' })
        case 'post_service':
            return t('revenue.filters.origins.postService', { defaultValue: 'Post Service' })
        case 'car_rental':
            return t('revenue.filters.origins.carRental')
        case 'travel_transportation':
            return t('travelTransportation.title')
        default:
            return humanizeRevenueFilterValue(origin)
    }
}

function revenueSourceChannelLabel(value: string | null | undefined, t: any) {
    const normalized = (value || 'none').trim().toLowerCase().replace(/[-\s]+/g, '_')

    switch (normalized) {
        case 'manual':
            return t('revenue.filters.sourceChannels.manual', { defaultValue: 'Manual' })
        case 'marketplace':
            return t('revenue.filters.sourceChannels.marketplace', { defaultValue: 'Marketplace' })
        case 'none':
            return t('revenue.filters.sourceChannels.none', { defaultValue: 'None' })
        default:
            return humanizeRevenueFilterValue(value)
    }
}

function revenueSortOptionLabel(value: RevenueSortOption, t: any) {
    switch (value) {
        case 'date_asc':
            return t('revenue.filters.sortDateAsc', { defaultValue: 'Date: Oldest First' })
        case 'revenue_desc':
            return t('revenue.filters.sortRevenueDesc', { defaultValue: 'Revenue: High to Low' })
        case 'revenue_asc':
            return t('revenue.filters.sortRevenueAsc', { defaultValue: 'Revenue: Low to High' })
        case 'cost_desc':
            return t('revenue.filters.sortCostDesc', { defaultValue: 'Cost: High to Low' })
        case 'cost_asc':
            return t('revenue.filters.sortCostAsc', { defaultValue: 'Cost: Low to High' })
        case 'profit_desc':
            return t('revenue.filters.sortProfitDesc', { defaultValue: 'Profit: High to Low' })
        case 'profit_asc':
            return t('revenue.filters.sortProfitAsc', { defaultValue: 'Profit: Low to High' })
        case 'margin_desc':
            return t('revenue.filters.sortMarginDesc', { defaultValue: 'Margin: High to Low' })
        case 'margin_asc':
            return t('revenue.filters.sortMarginAsc', { defaultValue: 'Margin: Low to High' })
        case 'cashier_asc':
            return t('revenue.filters.sortCashierAsc', { defaultValue: 'Cashier / Created By: A to Z' })
        case 'cashier_desc':
            return t('revenue.filters.sortCashierDesc', { defaultValue: 'Cashier / Created By: Z to A' })
        case 'origin_asc':
            return t('revenue.filters.sortOriginAsc', { defaultValue: 'Origin: A to Z' })
        case 'origin_desc':
            return t('revenue.filters.sortOriginDesc', { defaultValue: 'Origin: Z to A' })
        default:
            return t('revenue.filters.sortDateDesc', { defaultValue: 'Date: Newest First' })
    }
}

function revenueReturnStatusLabel(value: RevenueReturnStatusFilter, t: any) {
    switch (value) {
        case 'non_returned':
            return t('revenue.filters.nonReturned', { defaultValue: 'Non-Returned' })
        case 'partial':
            return t('revenue.filters.partiallyReturned', { defaultValue: 'Partially Returned' })
        case 'returned':
            return t('revenue.filters.fullyReturned', { defaultValue: 'Fully Returned' })
        default:
            return t('revenue.filters.allReturnStates', { defaultValue: 'All Return States' })
    }
}

function revenueProfitStatusLabel(value: RevenueProfitStatusFilter, t: any) {
    switch (value) {
        case 'profitable':
            return t('revenue.filters.profitable', { defaultValue: 'Profitable' })
        case 'break_even':
            return t('revenue.filters.breakEven', { defaultValue: 'Break-Even' })
        case 'loss':
            return t('revenue.filters.lossMaking', { defaultValue: 'Loss-Making' })
        default:
            return t('revenue.filters.allProfitStates', { defaultValue: 'All Profit States' })
    }
}

function revenueDayLabel(value: RevenueDayFilter, t: any) {
    const labels = [
        t('revenue.filters.days.sunday', { defaultValue: 'Sunday' }),
        t('revenue.filters.days.monday', { defaultValue: 'Monday' }),
        t('revenue.filters.days.tuesday', { defaultValue: 'Tuesday' }),
        t('revenue.filters.days.wednesday', { defaultValue: 'Wednesday' }),
        t('revenue.filters.days.thursday', { defaultValue: 'Thursday' }),
        t('revenue.filters.days.friday', { defaultValue: 'Friday' }),
        t('revenue.filters.days.saturday', { defaultValue: 'Saturday' })
    ]

    return value === 'all' ? t('revenue.filters.allDays', { defaultValue: 'All Days' }) : labels[Number(value)] || value
}

function revenueHourLabel(value: string, t: any) {
    if (value === 'all') return t('revenue.filters.allHours', { defaultValue: 'All Hours' })
    const hour = Number(value)
    if (!Number.isFinite(hour)) return value
    return `${String(hour).padStart(2, '0')}:00`
}

function applyRevenueFilters(
    records: RevenueAnalysisRecord[],
    filters: RevenueFilterState,
    userNameById?: ReadonlyMap<string, string>,
    t?: any
) {
    const normalizedSearch = normalizeRevenueFilterValue(filters.search)
    const minRevenue = parseOptionalNumber(filters.minRevenue)
    const maxRevenue = parseOptionalNumber(filters.maxRevenue)
    const minCost = parseOptionalNumber(filters.minCost)
    const maxCost = parseOptionalNumber(filters.maxCost)
    const minProfit = parseOptionalNumber(filters.minProfit)
    const maxProfit = parseOptionalNumber(filters.maxProfit)
    const minMargin = parseOptionalNumber(filters.minMargin)
    const maxMargin = parseOptionalNumber(filters.maxMargin)

    const filtered = records.filter((record) => {
        const totals = getRevenueAnalysisTotals(record)
        const returnStatus = getRevenueReturnStatus(record)

        if (filters.origin !== 'all' && record.origin !== filters.origin) return false
        if (filters.sourceChannel !== 'all' && (record.sourceChannel || 'none') !== filters.sourceChannel) return false
        if (filters.cashier !== 'all' && getRevenueStaffKey(record) !== filters.cashier) return false
        if (filters.party !== 'all') {
            const normalizedParty = normalizeRevenueFilterValue(filters.party)
            const normalizedPartyId = normalizeRevenueFilterValue(filters.partyPartnerId)
            const recordPartyName = normalizeRevenueFilterValue(record.partyName)
            const recordPartyId = normalizeRevenueFilterValue(record.partyId)

            if (normalizedPartyId) {
                if (recordPartyId !== normalizedPartyId && recordPartyName !== normalizedParty) return false
            } else if (!recordPartyName.includes(normalizedParty)) {
                return false
            }
        }
        if (filters.currency !== 'all' && record.currency !== filters.currency) return false
        if (filters.paymentMethod !== 'all' && getRevenuePaymentMethod(record) !== filters.paymentMethod) return false
        if (filters.returnStatus !== 'all' && returnStatus !== filters.returnStatus) return false
        if (filters.profitStatus !== 'all' && getRevenueProfitStatus(totals.profit) !== filters.profitStatus) return false

        if (filters.category !== 'all' && !record.items.some((item) => (item.productCategory || 'Uncategorized') === filters.category)) return false
        if (filters.product !== 'all' && !record.items.some((item) => getRevenueProductKey(item) === filters.product)) return false

        const recordDate = new Date(record.date)
        if (filters.dayOfWeek !== 'all' && String(recordDate.getDay()) !== filters.dayOfWeek) return false
        if (filters.hour !== 'all' && String(recordDate.getHours()) !== filters.hour) return false

        if (minRevenue !== null && totals.revenue < minRevenue) return false
        if (maxRevenue !== null && totals.revenue > maxRevenue) return false
        if (minCost !== null && totals.cost < minCost) return false
        if (maxCost !== null && totals.cost > maxCost) return false
        if (minProfit !== null && totals.profit < minProfit) return false
        if (maxProfit !== null && totals.profit > maxProfit) return false
        if (minMargin !== null && totals.margin < minMargin) return false
        if (maxMargin !== null && totals.margin > maxMargin) return false

        if (!normalizedSearch) return true

        const searchValues = [
            record.id,
            record.sourceRecordId,
            record.referenceCode,
            record.origin,
            revenueOriginLabel(record.origin, record.sourceChannel, t),
            record.sourceChannel,
            record.currency,
            record.paymentMethod,
            record.notes,
            record.partyId,
            record.partyName,
            record.cashier,
            getRevenueStaffId(record),
            getRevenueStaffLabel(record, userNameById),
            ...record.items.flatMap((item) => [
                item.productId,
                item.productName,
                item.productCategory
            ])
        ]

        return searchValues.some((value) => normalizeRevenueFilterValue(value).includes(normalizedSearch))
    })

    return filtered.sort((a, b) => {
        const totalsA = getRevenueAnalysisTotals(a)
        const totalsB = getRevenueAnalysisTotals(b)
        const staffA = getRevenueStaffLabel(a, userNameById)
        const staffB = getRevenueStaffLabel(b, userNameById)
        const originA = revenueOriginLabel(a.origin, a.sourceChannel, t)
        const originB = revenueOriginLabel(b.origin, b.sourceChannel, t)

        switch (filters.sort) {
            case 'date_asc':
                return new Date(a.date).getTime() - new Date(b.date).getTime()
            case 'revenue_desc':
                return totalsB.revenue - totalsA.revenue
            case 'revenue_asc':
                return totalsA.revenue - totalsB.revenue
            case 'cost_desc':
                return totalsB.cost - totalsA.cost
            case 'cost_asc':
                return totalsA.cost - totalsB.cost
            case 'profit_desc':
                return totalsB.profit - totalsA.profit
            case 'profit_asc':
                return totalsA.profit - totalsB.profit
            case 'margin_desc':
                return totalsB.margin - totalsA.margin
            case 'margin_asc':
                return totalsA.margin - totalsB.margin
            case 'cashier_asc':
                return staffA.localeCompare(staffB)
            case 'cashier_desc':
                return staffB.localeCompare(staffA)
            case 'origin_asc':
                return originA.localeCompare(originB)
            case 'origin_desc':
                return originB.localeCompare(originA)
            default:
                return new Date(b.date).getTime() - new Date(a.date).getTime()
        }
    })
}

export function Revenue() {
    const { user } = useAuth()
    const { t, i18n } = useTranslation()
    const [, setLocation] = useLocation()
    const { features, hasCapability } = useWorkspace()
    const { dateRange, customDates } = useDateRange()
    const { style } = useTheme()

    const dateBounds = useMemo<{ startDate?: string; endDate?: string }>(() => {
        const { start, end } = getDateRangeBounds(dateRange, customDates)
        return {
            startDate: start?.toISOString(),
            endDate: end ? new Date(end.getTime() - 1).toISOString() : undefined
        }
    }, [dateRange, customDates])
    const revenueReportOriginId = useMemo(() => getReportOriginId(
        user?.workspaceId,
        'revenue',
        `revenue:${dateRange}:${dateBounds.startDate || ''}:${dateBounds.endDate || ''}:${customDates.start || ''}:${customDates.end || ''}`
    ), [customDates.end, customDates.start, dateBounds.endDate, dateBounds.startDate, dateRange, user?.workspaceId])

    const rawSales = useSales(user?.workspaceId, dateBounds.startDate, dateBounds.endDate)
    const rawSalesOrders = useSalesOrders(user?.workspaceId, dateBounds.startDate, dateBounds.endDate)
    const salesOrderReturnItems = useSalesOrderReturnItemsForWorkspace(user?.workspaceId)
    const deliveryShipments = useDeliveryShipments(user?.workspaceId)
    const deliveryMerchantProfiles = useDeliveryMerchantProfiles(user?.workspaceId)
    const deliveryBusinessPartners = useBusinessPartners(user?.workspaceId)
    const rentalVehicles = useRentalVehicles(user?.workspaceId)
    const rentalContracts = useRentalContracts(user?.workspaceId)
    const rawExchangeTransactions = useExchangeTransactions(user?.workspaceId)
    const realEstateCommissionTransactions = usePaymentTransactions(user?.workspaceId, {
        direction: 'incoming',
        sourceModule: 'real_estate',
        sourceType: 'real_estate_commission',
        includeReversals: false
    })
    const travelBookingPayments = usePaymentTransactions(user?.workspaceId, {
        direction: 'incoming',
        sourceModule: 'travel_transportation',
        sourceType: 'travel_booking_payment',
        includeReversals: true
    }, { hydrateSourceTables: false })
    const clinicalAppointments = useClinicalAppointments(user?.workspaceId)
    const clinicalAppointmentTransactions = usePaymentTransactions(user?.workspaceId, {
        direction: 'incoming',
        sourceModule: 'clinical_appointments',
        sourceType: 'clinical_appointment',
        includeReversals: true
    }, { hydrateSourceTables: false })
    const activityTransactions = useActivityTransactions(user?.workspaceId)
    const activityTransactionLines = useActivityTransactionLinesForWorkspace(user?.workspaceId)
    const products = useProducts(user?.workspaceId)
    const categories = useCategories(user?.workspaceId)
    const storages = useStorages(user?.workspaceId)
    const workspaceUsers = useWorkspaceUsers(user?.workspaceId)
    const userNameById = useMemo(
        () => new Map(workspaceUsers.map((member) => [member.id, member.name || member.email || member.id] as const)),
        [workspaceUsers]
    )
    const deliveryMerchantNameByProfileId = useMemo(() => {
        const partnerNameById = new Map(deliveryBusinessPartners.map((partner) => [partner.id, partner.partnerName] as const))
        return new Map(deliveryMerchantProfiles.map((profile) => [profile.id, partnerNameById.get(profile.businessPartnerId) || null] as const))
    }, [deliveryBusinessPartners, deliveryMerchantProfiles])
    const deliveryMerchantBusinessPartnerIdByProfileId = useMemo(
        () => new Map(deliveryMerchantProfiles.map((profile) => [profile.id, profile.businessPartnerId] as const)),
        [deliveryMerchantProfiles]
    )
    const rentalVehicleById = useMemo(
        () => new Map(rentalVehicles.map((vehicle) => [vehicle.id, vehicle] as const)),
        [rentalVehicles]
    )
    const salesOrders = useMemo(
        () => applySalesOrderReturnQuantities(rawSalesOrders || [], salesOrderReturnItems),
        [rawSalesOrders, salesOrderReturnItems]
    )

    const allSales = useMemo<Sale[]>(() => {
        const sales = (rawSales || []).map(toUISale)
        const exchangeSales = (rawExchangeTransactions || [])
            .filter(tx => !tx.isDeleted && !tx.isReversed && tx.transactionType === 'sell' && tx.profitAmount != null && tx.profitAmount > 0)
            .map(toUISaleFromExchangeTransaction)
        const realEstateCommissionSales = (realEstateCommissionTransactions || [])
            .filter(transaction => transaction.amount > 0)
            .map(toUISaleFromRealEstateCommissionTransaction)
        const travelBookingProfitSales = getActiveTravelBookingPayments(travelBookingPayments || [])
            .map(toUISaleFromTravelBookingPayment)
        const clinicalSales = (clinicalAppointments || [])
            .map(appointment => toUISaleFromPaidClinicalAppointment(appointment, clinicalAppointmentTransactions))
            .filter((sale): sale is NonNullable<typeof sale> => !!sale)
        const activitySales = activityTransactions
            .filter((transaction) => transaction.status === 'completed')
            .map((transaction) => toUISaleFromActivityTransaction(
                transaction,
                activityTransactionLines.filter((line) => line.transactionId === transaction.id),
                transaction.createdBy ? userNameById.get(transaction.createdBy) : undefined
            ))
        const deliverySales = deliveryShipments
            .filter((shipment) => shipment.status === 'delivered' && !!shipment.deliveredAt)
            .filter((shipment) => (!dateBounds.startDate || shipment.deliveredAt! >= dateBounds.startDate)
                && (!dateBounds.endDate || shipment.deliveredAt! <= dateBounds.endDate))
            .map((shipment) => toUISaleFromDeliveryShipment(shipment, {
                merchantName: deliveryMerchantNameByProfileId.get(shipment.merchantProfileId),
                merchantBusinessPartnerId: deliveryMerchantBusinessPartnerIdByProfileId.get(shipment.merchantProfileId),
                serviceName: t('postService.reporting.serviceName', { defaultValue: 'Delivery service' }),
                serviceCategory: t('postService.reporting.serviceCategory', { defaultValue: 'Delivery service' }),
                feePayerNote: t('postService.reporting.feePayerNote', {
                    payer: t(`postService.feePayer.${shipment.feePayer}`, { defaultValue: shipment.feePayer }),
                    defaultValue: `Fee charged to ${shipment.feePayer}`
                })
            }))
        const rentalSales = rentalContracts
            .filter((contract) => ['active', 'returned', 'closed'].includes(contract.status))
            .filter((contract) => {
                const recognitionDate = contract.actualPickupAt || contract.plannedPickupAt
                return (!dateBounds.startDate || recognitionDate >= dateBounds.startDate)
                    && (!dateBounds.endDate || recognitionDate <= dateBounds.endDate)
            })
            .map((contract) => toUISaleFromRentalContract(contract, rentalVehicleById.get(contract.vehicleId), {
                serviceName: t('carRental.reporting.serviceName'),
                serviceCategory: t('carRental.reporting.serviceCategory'),
            }))
        return [...sales, ...exchangeSales, ...realEstateCommissionSales, ...travelBookingProfitSales, ...clinicalSales, ...activitySales, ...deliverySales, ...rentalSales]
    }, [rawSales, rawExchangeTransactions, realEstateCommissionTransactions, travelBookingPayments, clinicalAppointments, clinicalAppointmentTransactions, activityTransactions, activityTransactionLines, userNameById, dateBounds.endDate, dateBounds.startDate, deliveryMerchantBusinessPartnerIdByProfileId, deliveryMerchantNameByProfileId, deliveryShipments, rentalContracts, rentalVehicleById, t])
    const [selectedSale, setSelectedSale] = useState<Sale | null>(null)
    const [selectedMetric, setSelectedMetric] = useState<MetricType | null>(null)
    const [isMetricModalOpen, setIsMetricModalOpen] = useState(false)
    const [isTopProductsOpen, setIsTopProductsOpen] = useState(false)
    const [isProductSalesOpen, setIsProductSalesOpen] = useState(false)
    const [isSalesOverviewOpen, setIsSalesOverviewOpen] = useState(false)
    const [isPeakTradingOpen, setIsPeakTradingOpen] = useState(false)
    const [isReturnsOpen, setIsReturnsOpen] = useState(false)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const [selectedRecordKeys, setSelectedRecordKeys] = useState<Set<string>>(new Set())
    const [showPeakHeatmap, setShowPeakHeatmap] = useState(false)
    const [filters, setFilters] = useState<RevenueFilterState>(DEFAULT_REVENUE_FILTERS)
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
    const [draftFilters, setDraftFilters] = useState<RevenueFilterState>(DEFAULT_REVENUE_FILTERS)

    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('revenue_view_mode') as 'table' | 'grid') || 'table'
    })

    useEffect(() => {
        localStorage.setItem('revenue_view_mode', viewMode)
    }, [viewMode])

    const [isExportModalOpen, setIsExportModalOpen] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const [itemsPerPage, setItemsPerPage] = useState(() => {
        return Number(localStorage.getItem('revenue_page_size')) || 25
    })

    useEffect(() => {
        localStorage.setItem('revenue_page_size', String(itemsPerPage))
    }, [itemsPerPage])
    const listRef = useRef<HTMLDivElement>(null)

    const categoryNameById = useMemo(
        () => new Map(categories.map((category) => [category.id, category.name] as const)),
        [categories]
    )
    const productCategoryByProductId = useMemo(() => {
        const categoryByProduct = new Map<string, string>()

        products.forEach((product) => {
            const categoryName = product.categoryId
                ? categoryNameById.get(product.categoryId)
                : undefined
            const resolvedCategory = (categoryName || product.category || '').trim()

            if (resolvedCategory) {
                categoryByProduct.set(product.id, resolvedCategory)
            }
        })

        return categoryByProduct
    }, [categoryNameById, products])

    const revenueRecords = useMemo(
        () => buildRevenueAnalysisRecords(allSales, salesOrders, { productCategoryByProductId }),
        [allSales, salesOrders, productCategoryByProductId]
    )
    const revenueFilterOptions = useMemo(() => {
        const origins = new Map<string, string>()
        const sourceChannels = new Map<string, string>()
        const staff = new Map<string, string>()
        const currencies = new Set<string>()
        const paymentMethods = new Set<string>()
        const categories = new Set<string>()
        const products = new Map<string, string>()

        revenueRecords.forEach((record) => {
            if (record.origin) {
                origins.set(record.origin, revenueOriginLabel(record.origin, record.sourceChannel, t))
            }

            if (record.sourceChannel?.trim()) {
                sourceChannels.set(record.sourceChannel, revenueSourceChannelLabel(record.sourceChannel, t))
            }

            staff.set(getRevenueStaffKey(record), getRevenueStaffLabel(record, userNameById))

            if (record.currency?.trim()) {
                currencies.add(record.currency)
            }

            paymentMethods.add(getRevenuePaymentMethod(record))

            record.items.forEach((item) => {
                const category = item.productCategory || 'Uncategorized'
                categories.add(category)
                products.set(getRevenueProductKey(item), item.productName || 'Unknown Product')
            })
        })

        const byLabel = (left: { label: string }, right: { label: string }) => left.label.localeCompare(right.label)

        return {
            origins: Array.from(origins, ([value, label]) => ({ value, label })).sort(byLabel),
            sourceChannels: Array.from(sourceChannels, ([value, label]) => ({ value, label })).sort(byLabel),
            staff: Array.from(staff, ([value, label]) => ({ value, label })).sort(byLabel),
            currencies: Array.from(currencies).sort((left, right) => left.localeCompare(right)),
            paymentMethods: Array.from(paymentMethods).sort((left, right) => revenuePaymentMethodLabel(left, t).localeCompare(revenuePaymentMethodLabel(right, t))),
            categories: Array.from(categories).sort((left, right) => left.localeCompare(right)),
            products: Array.from(products, ([value, label]) => ({ value, label })).sort(byLabel)
        }
    }, [revenueRecords, t, userNameById])
    const dateScopedSales = useMemo(
        () => filterSalesByDateRange(allSales, dateRange, customDates),
        [allSales, dateRange, customDates]
    )
    const dateScopedRevenueRecords = useMemo(
        () => filterRevenueAnalysisRecords(revenueRecords, dateRange, customDates),
        [revenueRecords, dateRange, customDates]
    )
    const filteredRevenueRecords = useMemo(
        () => applyRevenueFilters(filterRevenueRecordsByStorage(dateScopedRevenueRecords, filters.storage), filters, userNameById, t),
        [dateScopedRevenueRecords, filters, t, userNameById]
    )
    const allTimeFilteredRevenueRecords = useMemo(
        () => applyRevenueFilters(filterRevenueRecordsByStorage(revenueRecords, filters.storage), filters, userNameById, t),
        [filters, revenueRecords, t, userNameById]
    )
    const draftPreviewRevenueRecords = useMemo(
        () => applyRevenueFilters(filterRevenueRecordsByStorage(dateScopedRevenueRecords, draftFilters.storage), draftFilters, userNameById, t),
        [dateScopedRevenueRecords, draftFilters, t, userNameById]
    )
    const filteredSales = useMemo(() => {
        const visibleSaleIds = new Set(
            filteredRevenueRecords
                .filter((record) => record.source === 'sale')
                .map((record) => record.id)
        )

        return dateScopedSales.filter((sale) => visibleSaleIds.has(sale.id))
    }, [dateScopedSales, filteredRevenueRecords])

    const isLoading = rawSales === undefined || rawSalesOrders === undefined || realEstateCommissionTransactions === undefined || clinicalAppointments === undefined
    const [isDateLoading, setIsDateLoading] = useState(false)
    const prevDateBoundsRef = useRef(dateBounds)

    useEffect(() => {
        const prev = prevDateBoundsRef.current
        prevDateBoundsRef.current = dateBounds
        if (dateRange !== 'allTime' && (prev.startDate !== dateBounds.startDate || prev.endDate !== dateBounds.endDate)) {
            setIsDateLoading(true)
        }
    }, [dateBounds, dateRange])

    useEffect(() => {
        if (isDateLoading && !isLoading && revenueRecords.length > 0) {
            setIsDateLoading(false)
        }
    }, [isDateLoading, isLoading, revenueRecords])

    // Clear selection when the visible result set changes.
    useEffect(() => {
        setSelectedRecordKeys(new Set())
        setCurrentPage(1)
    }, [dateRange, customDates, filters, itemsPerPage])

    useEffect(() => {
        if (!isFilterDialogOpen) return
        setDraftFilters(filters)
    }, [filters, isFilterDialogOpen])

    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }
        if (dateRange === 'month') {
            const now = new Date()
            return formatLocalizedMonthYear(now, i18n.language)
        }
        if (dateRange === 'lastMonth') {
            const now = new Date()
            return formatLocalizedMonthYear(new Date(now.getFullYear(), now.getMonth() - 1, 1), i18n.language)
        }
        if (dateRange === 'custom') {
            if (filteredRevenueRecords.length > 0) {
                const dates = filteredRevenueRecords.map((record) => new Date(record.date).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('revenue.filters.from', { defaultValue: 'From' })} ${formatDate(minDate)} ${t('revenue.filters.to', { defaultValue: 'To' })} ${formatDate(maxDate)}`
            }
            if (customDates.start && customDates.end) {
                return `${t('revenue.filters.from', { defaultValue: 'From' })} ${formatDate(customDates.start)} ${t('revenue.filters.to', { defaultValue: 'To' })} ${formatDate(customDates.end)}`
            }
        }
        if (dateRange === 'allTime') {
            if (filteredRevenueRecords.length > 0) {
                const dates = filteredRevenueRecords.map((record) => new Date(record.date).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('revenue.filters.allTime', { defaultValue: 'All Time' })}, ${t('revenue.filters.from', { defaultValue: 'From' })} ${formatDate(minDate)} ${t('revenue.filters.to', { defaultValue: 'To' })} ${formatDate(maxDate)}`
            }
            return t('revenue.filters.allTime', { defaultValue: 'All Time' })
        }
        return ''
    }

    const handleOpenPrintPreview = () => {
        setShowPrintPreview(true)
    }

    const openMetricModal = (type: MetricType) => {
        setSelectedMetric(type)
        setIsMetricModalOpen(true)
    }

    const trendStats = useMemo(() => {
        const calcTrend = (current: number, previous: number) => {
            if (previous === 0) return current > 0 ? 100 : 0
            return ((current - previous) / previous) * 100
        }

        const now = new Date()
        const currentStart = new Date(now)
        currentStart.setDate(currentStart.getDate() - 7)
        const previousStart = new Date(currentStart)
        previousStart.setDate(previousStart.getDate() - 7)

        let currentRevenue = 0
        let currentCost = 0
        let previousRevenue = 0
        let previousCost = 0

        allTimeFilteredRevenueRecords.forEach((record) => {
            if (record.isReturned) return
            const recordDate = new Date(record.date)
            if (recordDate < previousStart || recordDate > now) return

            const totals = getRevenueAnalysisTotals(record)
            if (recordDate >= currentStart) {
                currentRevenue += totals.revenue
                currentCost += totals.cost
            } else {
                previousRevenue += totals.revenue
                previousCost += totals.cost
            }
        })

        return {
            revenue: calcTrend(currentRevenue, previousRevenue),
            cost: calcTrend(currentCost, previousCost),
            profit: calcTrend(currentRevenue - currentCost, previousRevenue - previousCost),
            margin: 0
        }
    }, [allTimeFilteredRevenueRecords])

    const calculateStats = (records: RevenueAnalysisRecord[], defaultCurrency: string) => {
        const statsByCurrency: Record<string, {
            revenue: number,
            cost: number,
            salesCount: number,
            dailyTrend: Record<string, { revenue: number, cost: number, profit: number }>,
            categoryRevenue: Record<string, number>,
            productPerformance: Record<string, { name: string, revenue: number, cost: number, quantity: number }>,
            hourlySales: Record<number, number>
        }> = {}
        const saleStats: {
            key: string,
            id: string,
            source: 'sale' | 'sales_order' | 'exchange' | 'real_estate' | 'activities' | 'clinical_appointment' | 'post_service' | 'car_rental' | 'travel_transportation',
            sourceRecordId?: string | null,
            referenceCode: string,
            date: string,
            revenue: number,
            cost: number,
            profit: number,
            margin: number,
            currency: string,
            origin: string,
            sourceChannel?: string | null,
            cashierId?: string | null,
            createdBy?: string | null,
            cashier: string,
            partyName?: string,
            sequenceId?: number,
            paymentMethod?: string | null,
            hasPartialReturn?: boolean,
            isReturned?: boolean,
            returnStatus?: Exclude<RevenueReturnStatusFilter, 'all'>,
            totalReturnedQuantity?: number
        }[] = []

        records.forEach((record) => {
            const currency = record.currency || defaultCurrency
            if (!statsByCurrency[currency]) {
                statsByCurrency[currency] = {
                    revenue: 0,
                    cost: 0,
                    salesCount: 0,
                    dailyTrend: {},
                    categoryRevenue: {},
                    productPerformance: {},
                    hourlySales: {}
                }
            }
            statsByCurrency[currency].salesCount++

            const totals = getRevenueAnalysisTotals(record)
            const returnSummary = getRevenueRecordReturnSummary(record)
            const date = new Date(record.date).toISOString().split('T')[0]

            if (!statsByCurrency[currency].dailyTrend[date]) {
                statsByCurrency[currency].dailyTrend[date] = { revenue: 0, cost: 0, profit: 0 }
            }

            record.items.forEach((item) => {
                const netQuantity = Math.max(0, item.quantity - item.returnedQuantity)
                const netCostQuantity = Math.max(0, (item.costQuantity ?? item.quantity) - item.returnedQuantity)
                if (netQuantity <= 0 && netCostQuantity <= 0) return

                const itemRevenue = item.unitPrice * netQuantity
                const itemCost = item.costPrice * netCostQuantity

                // Category tracking
                const cat = item.productCategory || 'Uncategorized'
                statsByCurrency[currency].categoryRevenue[cat] = (statsByCurrency[currency].categoryRevenue[cat] || 0) + itemRevenue

                // Product performance tracking
                const prodId = item.productId
                if (!statsByCurrency[currency].productPerformance[prodId]) {
                    statsByCurrency[currency].productPerformance[prodId] = {
                        name: item.productName || 'Unknown Product',
                        revenue: 0,
                        cost: 0,
                        quantity: 0
                    }
                }
                statsByCurrency[currency].productPerformance[prodId].revenue += itemRevenue
                statsByCurrency[currency].productPerformance[prodId].cost += itemCost
                statsByCurrency[currency].productPerformance[prodId].quantity += netQuantity
            })

            // Hourly tracking
            const hour = new Date(record.date).getHours()
            statsByCurrency[currency].hourlySales[hour] = (statsByCurrency[currency].hourlySales[hour] || 0) + totals.revenue

            statsByCurrency[currency].revenue += totals.revenue
            statsByCurrency[currency].cost += totals.cost
            statsByCurrency[currency].dailyTrend[date].revenue += totals.revenue
            statsByCurrency[currency].dailyTrend[date].cost += totals.cost
            statsByCurrency[currency].dailyTrend[date].profit += totals.profit

            saleStats.push({
                key: record.key,
                id: record.id,
                source: record.source as any,
                sourceRecordId: record.sourceRecordId || null,
                referenceCode: record.referenceCode,
                date: record.date,
                revenue: totals.revenue,
                cost: totals.cost,
                profit: totals.profit,
                margin: totals.margin,
                currency: currency,
                origin: record.origin,
                sourceChannel: record.sourceChannel || null,
                cashierId: record.cashierId || null,
                createdBy: record.createdBy || null,
                cashier: getRevenueStaffLabel(record, userNameById),
                partyName: record.partyName,
                sequenceId: record.sequenceId,
                paymentMethod: record.paymentMethod || null,
                hasPartialReturn: record.hasPartialReturn || (returnSummary.hasAnyReturn && !returnSummary.isFullyReturned),
                isReturned: returnSummary.isFullyReturned,
                returnStatus: getRevenueReturnStatus(record),
                totalReturnedQuantity: returnSummary.totalReturnedQuantity
            })
        })

        return {
            statsByCurrency,
            saleStats
        }
    }

    const stats = useMemo(() => {
        const { statsByCurrency, saleStats } = calculateStats(filteredRevenueRecords, features.default_currency || 'usd')
        return { statsByCurrency, saleStats }
    }, [filteredRevenueRecords, features.default_currency, userNameById])

    const currencySettings = useMemo(() => ({
        currency: Object.keys(stats.statsByCurrency)[0] || features.default_currency || 'usd',
        iqdPreference: features.iqd_display_preference
    }), [stats.statsByCurrency, features.default_currency, features.iqd_display_preference])

    const primaryStats = useMemo(() => stats.statsByCurrency[currencySettings.currency] || {
        revenue: 0,
        cost: 0,
        salesCount: 0,
        dailyTrend: {},
        categoryRevenue: {},
        productPerformance: {}
    }, [stats.statsByCurrency, currencySettings.currency])

    const productSalesSummary = useMemo(
        () => getRevenueProductSalesSummary(filteredRevenueRecords),
        [filteredRevenueRecords]
    )

    const quantityFormatter = useMemo(
        () => new Intl.NumberFormat(i18n.language),
        [i18n.language]
    )

    const trendData = useMemo(() => {
        const dailyTrend = primaryStats.dailyTrend || {}
        return Object.entries(dailyTrend)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, values]) => ({
                date,
                revenue: values.revenue,
                cost: values.cost,
                profit: values.profit
            }))
    }, [primaryStats.dailyTrend])

    const topProductsData = useMemo(() => {
        const perf = primaryStats.productPerformance || {}
        const totalRevenue = primaryStats.revenue || 1
        return Object.values(perf)
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 3)
            .map(p => ({
                name: p.name,
                revenue: p.revenue,
                percentage: Math.min((p.revenue / totalRevenue) * 100, 100)
            }))
    }, [primaryStats.productPerformance, primaryStats.revenue])

    const peakTradingData = useMemo(() => {
        const hourly = primaryStats.hourlySales || {}
        const hours = [12, 17, 20, 22] // Example hours mapping to 12 PM, 05 PM, 08 PM, 10 PM
        const maxSales = Math.max(...Object.values(hourly), 1)

        return hours.map(h => {
            const date = new Date()
            date.setHours(h, 0, 0, 0)
            return {
                hour: formatTime(date, { includeMinutes: false }),
                hourValue: h,
                value: ((hourly[h] || 0) / maxSales) * 100
            }
        })
    }, [primaryStats.hourlySales])

    const SparklineArea = ({ data, dataKey, color }: { data: any[], dataKey: string, color: string }) => (
        <div className="h-12 w-full mt-4 -mx-2">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                    <defs>
                        <linearGradient id={`gradient-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <Area
                        type="monotone"
                        dataKey={dataKey}
                        stroke={color}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill={`url(#gradient-${dataKey})`}
                        isAnimationActive={true}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    )

    const timingEntries = useMemo(
        () => filteredRevenueRecords.map((record) => ({
            id: record.key,
            created_at: record.date,
            is_returned: record.isReturned
        })),
        [filteredRevenueRecords]
    )
    const salesById = useMemo(() => new Map(filteredSales.map((sale) => [sale.id, sale])), [filteredSales])

    const activeFilterCount = useMemo(
        () => countActiveRevenueFilters(filters),
        [filters]
    )

    const activeFilterChips = useMemo(() => {
        const optionLabel = (options: { value: string; label: string }[], value: string) =>
            options.find((option) => option.value === value)?.label || value

        const chips: string[] = []

        if (filters.search.trim()) {
            chips.push(t('revenue.filters.chipSearch', { term: filters.search.trim(), defaultValue: `Search: ${filters.search.trim()}` }))
        }
        if (filters.origin !== 'all') {
            chips.push(t('revenue.filters.chipOrigin', { name: optionLabel(revenueFilterOptions.origins, filters.origin), defaultValue: `Origin: ${optionLabel(revenueFilterOptions.origins, filters.origin)}` }))
        }
        if (filters.sourceChannel !== 'all') {
            chips.push(t('revenue.filters.chipChannel', { name: optionLabel(revenueFilterOptions.sourceChannels, filters.sourceChannel), defaultValue: `Channel: ${optionLabel(revenueFilterOptions.sourceChannels, filters.sourceChannel)}` }))
        }
        if (filters.cashier !== 'all') {
            chips.push(t('revenue.filters.chipCashier', { name: optionLabel(revenueFilterOptions.staff, filters.cashier), defaultValue: `Cashier / Created By: ${optionLabel(revenueFilterOptions.staff, filters.cashier)}` }))
        }
        if (filters.party !== 'all') {
            const partyLabel = filters.partySearch || filters.party
            chips.push(t('revenue.filters.chipParty', { name: partyLabel, defaultValue: `Party: ${partyLabel}` }))
        }
        if (filters.currency !== 'all') {
            chips.push(t('revenue.filters.chipCurrency', { code: filters.currency.toUpperCase(), defaultValue: `Currency: ${filters.currency.toUpperCase()}` }))
        }
        if (filters.paymentMethod !== 'all') {
            chips.push(t('revenue.filters.chipMethod', { name: revenuePaymentMethodLabel(filters.paymentMethod, t), defaultValue: `Method: ${revenuePaymentMethodLabel(filters.paymentMethod, t)}` }))
        }
        if (filters.category !== 'all') {
            chips.push(t('revenue.filters.chipCategory', { name: filters.category, defaultValue: `Category: ${filters.category}` }))
        }
        if (filters.product !== 'all') {
            const productLabel = filters.productSearch || optionLabel(revenueFilterOptions.products, filters.product)
            chips.push(t('revenue.filters.chipProduct', { name: productLabel, defaultValue: `Product: ${productLabel}` }))
        }
        if (filters.storage !== 'all') {
            const storageName = storages.find((storage) => storage.id === filters.storage)?.name || filters.storage
            chips.push(t('revenue.filters.chipStorage', { name: storageName, defaultValue: `Storage: ${storageName}` }))
        }
        if (filters.returnStatus !== 'all') {
            chips.push(revenueReturnStatusLabel(filters.returnStatus, t))
        }
        if (filters.profitStatus !== 'all') {
            chips.push(revenueProfitStatusLabel(filters.profitStatus, t))
        }
        if (filters.dayOfWeek !== 'all') {
            chips.push(revenueDayLabel(filters.dayOfWeek, t))
        }
        if (filters.hour !== 'all') {
            chips.push(revenueHourLabel(filters.hour, t))
        }
        if (filters.minRevenue) chips.push(t('revenue.filters.chipMinRevenue', { value: filters.minRevenue, defaultValue: `Min revenue: ${filters.minRevenue}` }))
        if (filters.maxRevenue) chips.push(t('revenue.filters.chipMaxRevenue', { value: filters.maxRevenue, defaultValue: `Max revenue: ${filters.maxRevenue}` }))
        if (filters.minCost) chips.push(t('revenue.filters.chipMinCost', { value: filters.minCost, defaultValue: `Min cost: ${filters.minCost}` }))
        if (filters.maxCost) chips.push(t('revenue.filters.chipMaxCost', { value: filters.maxCost, defaultValue: `Max cost: ${filters.maxCost}` }))
        if (filters.minProfit) chips.push(t('revenue.filters.chipMinProfit', { value: filters.minProfit, defaultValue: `Min profit: ${filters.minProfit}` }))
        if (filters.maxProfit) chips.push(t('revenue.filters.chipMaxProfit', { value: filters.maxProfit, defaultValue: `Max profit: ${filters.maxProfit}` }))
        if (filters.minMargin) chips.push(t('revenue.filters.chipMinMargin', { value: filters.minMargin, defaultValue: `Min margin: ${filters.minMargin}%` }))
        if (filters.maxMargin) chips.push(t('revenue.filters.chipMaxMargin', { value: filters.maxMargin, defaultValue: `Max margin: ${filters.maxMargin}%` }))
        if (filters.sort !== 'date_desc') {
            chips.push(revenueSortOptionLabel(filters.sort, t))
        }

        return chips
    }, [filters, revenueFilterOptions, storages, t])

    const handleResetAllFilters = () => {
        setFilters(DEFAULT_REVENUE_FILTERS)
    }

    const handleResetDraftFilters = () => {
        setDraftFilters(DEFAULT_REVENUE_FILTERS)
    }

    const handleApplyFilters = () => {
        setFilters(draftFilters)
        setIsFilterDialogOpen(false)
    }

    // Calculate aggregated stats for selected records (grouped by currency)
    const selectionSummary = useMemo(() => {
        if (selectedRecordKeys.size === 0) return null

        const summaryByCurrency: Record<string, { revenue: number; cost: number; profit: number }> = {}

        stats.saleStats.forEach((sale) => {
            if (selectedRecordKeys.has(sale.key)) {
                const currency = sale.currency || 'usd'
                if (!summaryByCurrency[currency]) {
                    summaryByCurrency[currency] = { revenue: 0, cost: 0, profit: 0 }
                }
                summaryByCurrency[currency].revenue += sale.revenue
                summaryByCurrency[currency].cost += sale.cost
                summaryByCurrency[currency].profit += sale.profit
            }
        })

        return {
            count: selectedRecordKeys.size,
            byCurrency: summaryByCurrency
        }
    }, [selectedRecordKeys, stats.saleStats])

    // Selection toggle handlers
    const toggleRecordSelection = (recordKey: string) => {
        setSelectedRecordKeys((prev) => {
            const newSet = new Set(prev)
            if (newSet.has(recordKey)) {
                newSet.delete(recordKey)
            } else {
                newSet.add(recordKey)
            }
            return newSet
        })
    }

    const toggleSelectAll = () => {
        if (selectedRecordKeys.size === stats.saleStats.length) {
            setSelectedRecordKeys(new Set())
        } else {
            setSelectedRecordKeys(new Set(stats.saleStats.map((sale) => sale.key)))
        }
    }

    const clearSelection = () => {
        setSelectedRecordKeys(new Set())
    }

    const paginatedSales = useMemo(() => {
        const startIndex = (currentPage - 1) * itemsPerPage
        return stats.saleStats.slice(startIndex, startIndex + itemsPerPage)
    }, [stats.saleStats, currentPage, itemsPerPage])

    if (isExportModalOpen) {
        return (
            <TooltipProvider>
                <ExportPreviewModal
                    isOpen={isExportModalOpen}
                    onClose={() => setIsExportModalOpen(false)}
                    type="revenue"
                    filters={{
                        dateRange,
                        customDates,
                        selectedCashier: filters.cashier
                    }}
                    records={stats.saleStats}
                />
            </TooltipProvider>
        )
    }

    return (
        <TooltipProvider>
            <div className="space-y-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-3">
                            <h1 className="text-3xl font-bold tracking-tight">{t('revenue.title')}{(isLoading || isDateLoading) && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground inline-block ml-3" />}</h1>
                            {getDateDisplay() && (
                                <div className={cn(
                                    "px-3 py-1 text-sm font-bold bg-primary text-primary-foreground shadow-sm animate-pop-in",
                                    style === 'neo-orange' ? "rounded-[var(--radius)] neo-border" : "rounded-lg"
                                )}>
                                    {getDateDisplay()}
                                </div>
                            )}
                        </div>
                        <p className="text-muted-foreground">
                            {t('revenue.subtitle')} <ModulePageFreshness className="ms-2" />
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <div className="hidden md:flex items-center bg-background/30 p-1 rounded-xl border border-border/50 backdrop-blur-md">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewMode('table')}
                                className={cn(
                                    "h-8 px-4 font-black uppercase tracking-widest text-[10px] flex items-center gap-2 transition-all",
                                    viewMode === 'table'
                                        ? "bg-primary text-primary-foreground shadow-lg"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <List className="w-3.5 h-3.5" />
                                {t('sales.view.table')}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewMode('grid')}
                                className={cn(
                                    "h-8 px-4 font-black uppercase tracking-widest text-[10px] flex items-center gap-2 transition-all",
                                    viewMode === 'grid'
                                        ? "bg-primary text-primary-foreground shadow-lg"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                                {t('sales.view.grid')}
                            </Button>
                        </div>
                        <DateRangeFilters />
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setIsFilterDialogOpen(true)}
                            className={cn("h-11 px-4 font-black", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]" : "rounded-2xl")}
                        >
                            <SlidersHorizontal className="me-2 h-4 w-4" />
                            {t('revenue.filters.title', { defaultValue: 'Filters' })}
                            {activeFilterCount > 0 ? (
                                <span className="ms-2 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
                                    {activeFilterCount}
                                </span>
                            ) : null}
                        </Button>
                        {activeFilterCount > 0 ? (
                            <Button type="button" variant="ghost" onClick={handleResetAllFilters} className="h-11 rounded-2xl px-4 text-muted-foreground">
                                <RotateCcw className="me-2 h-4 w-4" />
                                {t('revenue.filters.clearFilters', { defaultValue: 'Clear Filters' })}
                            </Button>
                        ) : null}
                    </div>
                </div>

                <div className="space-y-6">

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        {/* Gross Revenue */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('grossRevenue')}
                        >
                            <CardHeader className="pb-2">
                                <div className="flex justify-between items-start">
                                    <CardTitle className="text-[10px] font-black text-blue-500 flex items-center gap-2 uppercase tracking-[0.2em]">
                                        <div className="p-1.5 bg-blue-500/10 rounded-lg">
                                            <DollarSign className="w-3.5 h-3.5" />
                                        </div>
                                        {t('revenue.grossRevenue')}
                                    </CardTitle>
                                    <div className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-[10px] font-bold flex items-center gap-1">
                                        {trendStats.revenue > 0 ? '+' : ''}{trendStats.revenue.toFixed(1)}%
                                        {trendStats.revenue >= 0 ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pb-0">
                                <div className="space-y-1">
                                    {Object.entries(stats.statsByCurrency).map(([curr, s]) => (
                                        <div key={curr} className="text-2xl font-black tracking-tight tabular-nums text-foreground leading-none">
                                            {formatCurrency(s.revenue, curr as any, currencySettings.iqdPreference)}
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-1">
                                    {Object.values(stats.statsByCurrency).reduce((acc, s) => acc + s.salesCount, 0)} {t('pos.totalItems')}
                                </p>
                                <SparklineArea data={trendData} dataKey="revenue" color="#3b82f6" />
                            </CardContent>
                        </Card>

                        {/* Total Cost */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('totalCost')}
                        >
                            <CardHeader className="pb-2">
                                <div className="flex justify-between items-start">
                                    <CardTitle className="text-[10px] font-black text-orange-500 flex items-center gap-2 uppercase tracking-[0.2em]">
                                        <div className="p-1.5 bg-orange-500/10 rounded-lg">
                                            <Package className="w-3.5 h-3.5" />
                                        </div>
                                        {t('revenue.totalCost')} (COGS)
                                    </CardTitle>
                                    <div className={cn(
                                        "px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1",
                                        trendStats.cost <= 0 ? "bg-emerald-500/10 text-emerald-500" : "bg-orange-500/10 text-orange-500"
                                    )}>
                                        {trendStats.cost > 0 ? '+' : ''}{trendStats.cost.toFixed(1)}%
                                        {trendStats.cost <= 0 ? <TrendingDown className="w-2.5 h-2.5" /> : <TrendingUp className="w-2.5 h-2.5" />}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pb-0">
                                <div className="space-y-1">
                                    {Object.entries(stats.statsByCurrency).map(([curr, s]) => (
                                        <div key={curr} className="text-2xl font-black tracking-tight tabular-nums text-foreground leading-none">
                                            {formatCurrency(s.cost, curr as any, currencySettings.iqdPreference)}
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-1">
                                    {((Object.values(stats.statsByCurrency).reduce((acc, s) => acc + s.cost, 0) / (Object.values(stats.statsByCurrency).reduce((acc, s) => acc + s.revenue, 0) || 1)) * 100).toFixed(1)}% {t('revenue.table.cost')} Ratio
                                </p>
                                <SparklineArea data={trendData} dataKey="cost" color="#f97316" />
                            </CardContent>
                        </Card>

                        {/* Gross Profit */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('grossProfit')}
                        >
                            <CardHeader className="pb-2">
                                <div className="flex justify-between items-start">
                                    <CardTitle className="text-[10px] font-black text-emerald-500 flex items-center gap-2 uppercase tracking-[0.2em]">
                                        <div className="p-1.5 bg-emerald-500/10 rounded-lg">
                                            <TrendingUp className="w-3.5 h-3.5" />
                                        </div>
                                        {t('revenue.grossProfit')}
                                    </CardTitle>
                                    <div className={cn(
                                        "px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1",
                                        trendStats.profit >= 0 ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"
                                    )}>
                                        {trendStats.profit > 0 ? '+' : ''}{trendStats.profit.toFixed(1)}%
                                        {trendStats.profit >= 0 ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pb-0">
                                <div className="space-y-1">
                                    {Object.entries(stats.statsByCurrency).map(([curr, s]) => (
                                        <div key={curr} className="text-2xl font-black tracking-tight tabular-nums text-foreground leading-none">
                                            {formatCurrency(s.revenue - s.cost, curr as any, currencySettings.iqdPreference)}
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-1">
                                    {t('revenue.detailedAnalysis')}
                                </p>
                                <SparklineArea data={trendData} dataKey="profit" color="#10b981" />
                            </CardContent>
                        </Card>

                        {/* Profit Margin */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('profitMargin')}
                        >
                            <CardHeader className="pb-2">
                                <CardTitle className="text-[10px] font-black text-purple-600 flex items-center gap-2 uppercase tracking-[0.2em]">
                                    <div className="p-1.5 bg-purple-500/10 rounded-lg text-purple-500">
                                        <Percent className="w-3.5 h-3.5" />
                                    </div>
                                    {t('revenue.profitMargin')}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="text-3xl font-black tracking-tighter tabular-nums text-foreground">
                                    {((primaryStats.revenue - primaryStats.cost) / (primaryStats.revenue || 1) * 100).toFixed(1)}%
                                </div>
                                <div className="space-y-2 mt-4">
                                    <Progress
                                        value={Math.min(((primaryStats.revenue - primaryStats.cost) / (primaryStats.revenue || 1)) * 100, 100)}
                                        className="h-2 bg-purple-500/10"
                                        indicatorClassName="bg-gradient-to-r from-purple-500 to-pink-500"
                                    />
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Preview Section - Charts & Highlights */}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                        {/* Top Products */}
                        <Card className="rounded-[2.5rem] border-border/40 shadow-sm bg-card overflow-hidden">
                            <CardHeader className="pb-4">
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-emerald-500/10 rounded-xl text-emerald-500">
                                            <Package className="w-5 h-5" />
                                        </div>
                                        <CardTitle className="text-sm font-black uppercase tracking-widest text-foreground">
                                            Top Products
                                        </CardTitle>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-primary font-bold text-xs hover:bg-primary/5 rounded-full"
                                        onClick={() => setIsTopProductsOpen(true)}
                                    >
                                        View All
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-6 pt-2">
                                {topProductsData.length > 0 ? topProductsData.map((prod, i) => (
                                    <div key={i} className="space-y-2 group">
                                        <div className="flex justify-between items-end">
                                            <div className="flex items-center justify-between w-full">
                                                <div className="text-[11px] font-black text-foreground uppercase tracking-wider">
                                                    {prod.name}
                                                </div>
                                                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                                                    {formatCurrency(prod.revenue, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <div className="text-xs font-black text-foreground">
                                                {prod.percentage.toFixed(0)}%
                                            </div>
                                            <Button
                                                variant="link"
                                                className="h-auto p-0 text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors"
                                                onClick={() => setIsTopProductsOpen(true)}
                                            >
                                                {t('common.viewAll') || 'View All'}
                                            </Button>
                                        </div>
                                        <Progress
                                            value={prod.percentage}
                                            className="h-1.5 bg-muted/50"
                                            indicatorClassName={cn(
                                                "rounded-full transition-all duration-1000",
                                                i === 0 ? "bg-blue-500" : i === 1 ? "bg-emerald-500" : "bg-orange-500"
                                            )}
                                        />
                                    </div>
                                )) : (
                                    <div className="h-40 flex flex-col items-center justify-center text-muted-foreground/50 border-2 border-dashed border-border/50 rounded-3xl">
                                        <Package className="w-8 h-8 mb-2 opacity-20" />
                                        <p className="text-xs font-bold uppercase tracking-widest">No Data Available</p>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Product Sales Summary */}
                        <Card
                            className="rounded-[2.5rem] border-primary/20 shadow-sm bg-primary/5 overflow-hidden cursor-pointer hover:scale-[1.02] hover:bg-primary/10 hover:shadow-md active:scale-95 transition-all group relative"
                            onClick={() => setIsProductSalesOpen(true)}
                        >
                            <div className="absolute top-4 end-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-primary" />
                            </div>
                            <CardHeader className="pb-4">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-primary/10 rounded-xl text-primary">
                                        <Package className="w-5 h-5" />
                                    </div>
                                    <CardTitle className="text-sm font-black uppercase tracking-widest text-foreground">
                                        {t('revenue.productSales')}
                                    </CardTitle>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4 pt-2">
                                <dl className="space-y-4">
                                    <div className="flex items-end justify-between gap-3">
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('revenue.salesCount')}</dt>
                                        <dd className="text-3xl font-black tracking-tighter tabular-nums text-foreground">{quantityFormatter.format(productSalesSummary.totalSales)}</dd>
                                    </div>
                                    <div className="flex items-end justify-between gap-3">
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('revenue.productsSold')}</dt>
                                        <dd className="text-3xl font-black tracking-tighter tabular-nums text-foreground">{quantityFormatter.format(productSalesSummary.productsSold)}</dd>
                                    </div>
                                    <div className="flex items-end justify-between gap-3">
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('revenue.unitsSold')}</dt>
                                        <dd className="text-3xl font-black tracking-tighter tabular-nums text-foreground">{quantityFormatter.format(productSalesSummary.unitsSold)}</dd>
                                    </div>
                                </dl>
                                <div className="pt-3 border-t border-primary/15 text-[10px] font-black uppercase tracking-widest text-primary flex items-center gap-2">
                                    {t('common.viewAll')}
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </div>
                            </CardContent>
                        </Card>

                        {/* Sales Overview */}
                        <Card className="rounded-[2.5rem] border-border/40 shadow-sm bg-card overflow-hidden">
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-blue-500/10 rounded-xl text-blue-500">
                                            <BarChart3 className="w-5 h-5" />
                                        </div>
                                        <CardTitle className="text-sm font-black uppercase tracking-widest text-foreground">
                                            {t('revenue.salesOverview') || 'Sales Overview'}
                                        </CardTitle>
                                    </div>
                                    <div className="flex items-center gap-3 text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-2">
                                        <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500" />{t('revenue.table.profit') || 'Profit'}</div>
                                        <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-orange-500" />{t('revenue.table.cost') || 'Cost'}</div>
                                        <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-blue-500" />{t('revenue.table.revenue') || 'Revenue'}</div>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="h-56 w-full -ml-4">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={trendData.slice(-7)}>
                                            <XAxis
                                                dataKey="date"
                                                axisLine={false}
                                                tickLine={false}
                                                tick={{ fill: '#888888', fontSize: 10, fontWeight: 700 }}
                                                tickFormatter={(str) => {
                                                    const date = new Date(str)
                                                    return date.toLocaleDateString(i18n.language, { weekday: 'short' }).toUpperCase()
                                                }}
                                            />
                                            <RechartsTooltip
                                                cursor={{ fill: 'rgba(59, 130, 246, 0.05)', radius: 8 }}
                                                content={({ active, payload }) => {
                                                    if (active && payload && payload.length) {
                                                        return (
                                                            <div className="bg-background/95 backdrop-blur-sm border border-border shadow-xl p-3 rounded-2xl">
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1.5 flex justify-center">
                                                                    {formatDate(payload[0].payload.date)}
                                                                </p>
                                                                <div className="space-y-0.5 flex flex-col items-center">
                                                                    <p className="text-sm font-black text-blue-500">
                                                                        {formatCurrency(payload[0].payload.revenue as number, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                                    </p>
                                                                    <p className="text-sm font-black text-orange-500">
                                                                        {formatCurrency(payload[0].payload.cost as number, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                                    </p>
                                                                    <p className="text-sm font-black text-emerald-500">
                                                                        {formatCurrency(payload[0].payload.profit as number, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        )
                                                    }
                                                    return null
                                                }}
                                            />
                                            <Bar dataKey="revenue" stackId="stack" fill="#3b82f6" radius={[4, 4, 4, 4]} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={24} />
                                            <Bar dataKey="cost" stackId="stack" fill="#f97316" radius={[4, 4, 4, 4]} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={24} />
                                            <Bar dataKey="profit" stackId="stack" fill="#10b981" radius={[4, 4, 4, 4]} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={24} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Peak Times */}
                        <Card className="rounded-[2.5rem] border-border/40 shadow-sm bg-card overflow-hidden">
                            <CardHeader className="pb-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-purple-500/10 rounded-xl text-purple-500">
                                            {showPeakHeatmap ? <Grid3X3 className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                                        </div>
                                        <CardTitle className="text-sm font-black uppercase tracking-widest text-foreground">
                                            {t('revenue.peakTradingTimes') || 'Peak Times'}
                                        </CardTitle>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-full hover:bg-purple-500/10 text-muted-foreground hover:text-purple-500 transition-colors"
                                        onClick={() => setShowPeakHeatmap(!showPeakHeatmap)}
                                        title={showPeakHeatmap ? t('revenue.showHourlyBars') || "Show Hourly Bars" : t('revenue.showWeeklyHeatmap') || "Show Weekly Heatmap"}
                                    >
                                        {showPeakHeatmap ? <BarChart3 className="w-4 h-4" /> : <Grid3X3 className="w-4 h-4" />}
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-6 pt-2">
                                {showPeakHeatmap ? (
                                    <MiniHeatmap sales={timingEntries} />
                                ) : (
                                    <>
                                        {peakTradingData.map((peak, i) => (
                                            <div key={i} className="space-y-2">
                                                <div className="flex items-center gap-4">
                                                    <div className="text-[11px] font-black text-muted-foreground w-12 tabular-nums">
                                                        {peak.hour}
                                                    </div>
                                                    <div className="flex-1">
                                                        <Progress
                                                            value={peak.value}
                                                            className="h-2.5 bg-muted/50"
                                                            indicatorClassName="bg-purple-500 rounded-full"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                        <div className="pt-4 border-t border-border/50">
                                            <div className="text-center text-xs font-bold text-muted-foreground">
                                                {t('revenue.busiestHour') || 'Busiest hour'}: <span className="text-purple-500 font-black">
                                                    {peakTradingData.length > 0 ? (
                                                        (() => {
                                                            const startDate = new Date()
                                                            startDate.setHours(peakTradingData[0].hourValue, 0, 0, 0)
                                                            const endDate = new Date()
                                                            endDate.setHours(peakTradingData[0].hourValue + 1, 0, 0, 0)

                                                            return `${formatTime(startDate)} - ${formatTime(endDate)}`
                                                        })()
                                                    ) : '--:--'}
                                                </span>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    {/* Analytics Quick Actions */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        {/* Top Products */}
                        <Card
                            className="bg-emerald-500/5 dark:bg-emerald-500/10 border-emerald-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-emerald-500/10 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsTopProductsOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-emerald-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-emerald-600 dark:text-emerald-400 flex items-center gap-2 uppercase tracking-widest">
                                    <Package className="w-4 h-4" />
                                    {t('revenue.topProducts') || 'Top Products'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.topProductsDesc') || 'Best sellers by revenue, quantity, or cost'}
                                </p>
                            </CardContent>
                        </Card>

                        {/* Sales Overview */}
                        <Card
                            className="bg-blue-500/5 dark:bg-blue-500/10 border-blue-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-blue-500/10 hover:shadow-[0_0_20px_-5px_rgba(59,130,246,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsSalesOverviewOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-blue-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-blue-600 dark:text-blue-400 flex items-center gap-2 uppercase tracking-widest">
                                    <BarChart3 className="w-4 h-4" />
                                    {t('revenue.salesOverview') || 'Sales Overview'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.salesOverviewDesc') || 'Revenue, cost & profit combined'}
                                </p>
                            </CardContent>
                        </Card>

                        {/* Peak Times */}
                        <Card
                            className="bg-violet-500/5 dark:bg-violet-500/10 border-violet-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-violet-500/10 hover:shadow-[0_0_20px_-5px_rgba(139,92,246,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsPeakTradingOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-violet-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-violet-600 dark:text-violet-400 flex items-center gap-2 uppercase tracking-widest">
                                    <Clock className="w-4 h-4" />
                                    {t('revenue.peakTimes') || 'Peak Times'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.peakTimesDesc') || 'Busiest hours of the day'}
                                </p>
                            </CardContent>
                        </Card>

                        {/* Returns */}
                        <Card
                            className="bg-red-500/5 dark:bg-red-500/10 border-red-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-red-500/10 hover:shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsReturnsOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-red-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-red-600 dark:text-red-400 flex items-center gap-2 uppercase tracking-widest">
                                    <RotateCcw className="w-4 h-4" />
                                    {t('revenue.returns') || 'Returns'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.returnsDesc') || 'Track refunds and product returns'}
                                </p>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Sale Profitability Table */}
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                            <div className="flex flex-col gap-1">
                                <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
                                    <TrendingUp className="w-5 h-5 text-primary" />
                                    {t('revenue.listTitle') || 'Recent Sales Profit Analysis'}
                                    {getDateDisplay() && (
                                        <span className="ml-2 px-2 py-0.5 text-xs font-semibold bg-primary/10 text-primary border border-primary/20 rounded-full">
                                            {getDateDisplay()}
                                        </span>
                                    )}
                                </CardTitle>
                                {stats.saleStats.length > 0 && (
                                    <p className="text-[10px] text-muted-foreground font-black uppercase tracking-[0.2em] opacity-70">
                                        {`${stats.saleStats.length} records found`}
                                    </p>
                                )}
                                <p className="text-xs text-muted-foreground">
                                    {t('revenue.includesCompletedSalesOrders', { defaultValue: 'Includes completed sales orders. Loan repayments remain excluded to avoid double counting.' })}
                                </p>
                                {activeFilterChips.length > 0 ? (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {activeFilterChips.map((chip) => (
                                            <span key={chip} className="rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-primary">
                                                {chip}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                                {selectionSummary && (
                                    <div className="flex items-center gap-2 mt-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 transition-all animate-in fade-in slide-in-from-left-2 duration-200 w-fit">
                                        <Check className="w-4 h-4" />
                                        <div className="text-xs font-bold font-mono flex items-center gap-3">
                                            <span>{selectionSummary.count} {t('common.selected') || 'selected'}</span>
                                            <span className="w-px h-3 bg-emerald-500/20" />
                                            {Object.entries(selectionSummary.byCurrency).map(([currency, data], idx) => (
                                                <div key={currency} className="flex items-center gap-3">
                                                    {idx > 0 && <span className="w-px h-3 bg-emerald-500/20" />}
                                                    <span>{t('revenue.table.revenue') || 'Rev'}: {formatCurrency(data.revenue, currency, features.iqd_display_preference)}</span>
                                                    <span className="w-px h-3 bg-emerald-500/20" />
                                                    <span>{t('revenue.table.profit') || 'Prof'}: {formatCurrency(data.profit, currency, features.iqd_display_preference)}</span>
                                                </div>
                                            ))}
                                        </div>
                                        <button onClick={clearSelection} className="p-0.5 rounded hover:bg-emerald-500/20 transition-colors">
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-4">
                                <AppPagination
                                    currentPage={currentPage}
                                    totalCount={stats.saleStats.length}
                                    pageSize={itemsPerPage}
                                    onPageChange={setCurrentPage}
                                    onPageSizeChange={(newSize) => {
                                        setItemsPerPage(newSize)
                                        setCurrentPage(1)
                                    }}
                                    className="w-auto"
                                />
                                <div className="flex items-center gap-2">
                                    {hasCapability('excelExportRevenue') && (
                                        <Button
                                            onClick={() => setIsExportModalOpen(true)}
                                            disabled={stats.saleStats.length === 0}
                                            className={cn(
                                                "h-10 px-6 rounded-full font-black transition-all flex gap-3 items-center group relative overflow-hidden",
                                                "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400",
                                                "hover:bg-emerald-100 dark:hover:bg-emerald-500/20 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] hover:scale-[1.02] active:scale-95",
                                                "uppercase tracking-widest text-[10px]"
                                            )}
                                        >
                                            <FileSpreadsheet className="w-4 h-4 transition-transform group-hover:rotate-12" />
                                            <span className="hidden sm:inline">
                                                {t('sales.export.button')}
                                            </span>
                                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 dark:via-white/5 to-transparent -translate-x-full group-hover:animate-shimmer" />
                                        </Button>
                                    )}

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleOpenPrintPreview}
                                        className="gap-2 h-10 px-6 rounded-full font-black bg-primary/5 hover:bg-primary/10 border-primary/20 text-primary transition-all duration-200 uppercase tracking-widest text-[10px]"
                                    >
                                        <Printer className="w-4 h-4" />
                                        <span className="hidden lg:inline">{t('revenue.printList') || 'Print List'}</span>
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent ref={listRef} className="print:p-0 [print-color-adjust:exact] -webkit-print-color-adjust:exact">
                            {(isLoading || isDateLoading) ? (
                                <div className="flex justify-center py-8">
                                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                                </div>
                            ) : (isMobile() || viewMode === 'grid') ? (
                                <div className={cn(
                                    "grid gap-4",
                                    viewMode === 'grid' && !isMobile() ? "grid-cols-1 lg:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
                                )}>
                                    {paginatedSales.map((sale) => {
                                        const originalSale = sale.source === 'sale' ? salesById.get(sale.id) : undefined
                                        const isFullyReturned = !!sale.isReturned || sale.returnStatus === 'returned'
                                        const hasAnyReturn = isFullyReturned || !!sale.hasPartialReturn || sale.returnStatus === 'partial'
                                        const totalReturnedQuantity = sale.totalReturnedQuantity || 0
                                        const canOpenSaleDetails = !!originalSale || sale.source === 'sales_order' || sale.source === 'exchange' || sale.source === 'real_estate' || sale.source === 'activities' || sale.source === 'clinical_appointment' || sale.source === 'post_service' || sale.source === 'car_rental' || sale.source === 'travel_transportation'

                                        const handleRecordClick = () => {
                                            if (sale.source === 'sales_order') {
                                                setLocation(`/orders/${sale.id}`)
                                            } else if (sale.source === 'exchange') {
                                                setLocation('/currency-exchange')
                                            } else if (sale.source === 'real_estate') {
                                                setLocation(`/real-estate/${sale.sourceRecordId || sale.id}`)
                                            } else if (sale.source === 'activities') {
                                                setLocation(`/activities?transaction=${sale.sourceRecordId || sale.id}`)
                                            } else if (sale.source === 'clinical_appointment') {
                                                setLocation(`/clinical-appointments/${sale.sourceRecordId || sale.id}/edit`)
                                            } else if (sale.source === 'post_service') {
                                                setLocation('/post-service')
                                            } else if (sale.source === 'car_rental') {
                                                setLocation('/car-rental/contracts')
                                            } else if (sale.source === 'travel_transportation') {
                                                setLocation(`/travel-transportation/${sale.sourceRecordId || sale.id}`)
                                            } else if (originalSale) {
                                                setSelectedSale(originalSale)
                                            }
                                        }

                                        return (
                                            <div
                                                key={sale.key}
                                                className={cn(
                                                    "p-4 border shadow-sm space-y-4 transition-all active:scale-[0.98]",
                                                    style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "rounded-[2rem] md:rounded-2xl border-border",
                                                    isFullyReturned ? 'bg-destructive/5 border-destructive/20' : hasAnyReturn ? 'bg-orange-500/5 border-orange-500/20 dark:bg-orange-500/5 dark:border-orange-500/10' : 'bg-card',
                                                    canOpenSaleDetails && 'cursor-pointer'
                                                )}
                                                onClick={handleRecordClick}
                                            >
                                                <div className="flex justify-between items-start">
                                                    <div className="space-y-1">
                                                        <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
                                                            {formatDateTime(sale.date)}
                                                        </div>
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="text-xs font-mono font-black text-primary">
                                                                {sale.referenceCode}
                                                            </span>
                                                            {canOpenSaleDetails && (
                                                                <Tooltip>
                                                                    <TooltipTrigger asChild>
                                                                        <Info
                                                                            className="w-3.5 h-3.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation()
                                                                                handleRecordClick()
                                                                            }}
                                                                        />
                                                                    </TooltipTrigger>
                                                                    <TooltipContent>
                                                                        {t('revenue.viewDetails') || 'View Sale Details'}
                                                                    </TooltipContent>
                                                                </Tooltip>
                                                            )}

                                                            {isFullyReturned && (
                                                                <span className="px-1.5 py-0.5 text-[8px] font-bold bg-destructive/20 text-destructive dark:bg-destructive/30 dark:text-destructive-foreground rounded-full border border-destructive/30 uppercase">
                                                                    {t('sales.return.returnedStatus') || 'RETURNED'}
                                                                </span>
                                                            )}

                                                            {!isFullyReturned && hasAnyReturn && (
                                                                <span className="px-1.5 py-0.5 rounded-full text-[8px] font-bold bg-orange-500/10 text-orange-600 border border-orange-500/20 uppercase whitespace-nowrap">
                                                                    {totalReturnedQuantity > 0
                                                                        ? <>-{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}</>
                                                                        : (t('sales.return.partialReturn') || 'PARTIALLY RETURNED')}
                                                                </span>
                                                            )}

                                                            <span className="px-1.5 py-0.5 rounded-full text-[8px] font-bold bg-secondary uppercase">
                                                                {revenueOriginLabel(sale.origin, sale.sourceChannel, t)}
                                                            </span>
                                                        </div>
                                                        {sale.partyName && (
                                                            <div className="text-[10px] font-semibold text-muted-foreground">
                                                                {sale.partyName}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="text-right">
                                                        <span className={cn(
                                                            "px-2 py-1 rounded-full text-xs font-black",
                                                            sale.margin > 20 ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20" :
                                                                sale.margin > 0 ? "bg-orange-500/10 text-orange-600 border border-orange-500/20" :
                                                                    "bg-destructive/10 text-destructive border border-destructive/20"
                                                        )}>
                                                            {sale.margin.toFixed(1)}%
                                                        </span>
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border/50">
                                                    <div className="space-y-0.5 text-start">
                                                        <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-tight">{t('revenue.table.revenue')}</div>
                                                        <div className="text-sm font-black text-foreground">
                                                            {formatCurrency(sale.revenue, sale.currency, features.iqd_display_preference)}
                                                        </div>
                                                    </div>
                                                    <div className="space-y-0.5 text-center">
                                                        <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-tight">{t('revenue.table.cost')}</div>
                                                        <div className="text-sm font-bold text-muted-foreground">
                                                            {formatCurrency(sale.cost, sale.currency, features.iqd_display_preference)}
                                                        </div>
                                                    </div>
                                                    <div className="space-y-0.5 text-end">
                                                        <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-tight">{t('revenue.table.profit')}</div>
                                                        <div className="text-sm font-black text-emerald-600">
                                                            {formatCurrency(sale.profit, sale.currency, features.iqd_display_preference)}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            {/* Master Checkbox */}
                                            <TableHead className="w-10 text-center print:hidden">
                                                <button
                                                    onClick={toggleSelectAll}
                                                    className="p-1.5 rounded hover:bg-secondary transition-colors"
                                                    title={selectedRecordKeys.size === stats.saleStats.length ? 'Deselect all' : 'Select all'}
                                                >
                                                    {selectedRecordKeys.size === stats.saleStats.length && stats.saleStats.length > 0 ? (
                                                        <Check className="w-4 h-4 text-emerald-500" />
                                                    ) : selectedRecordKeys.size > 0 ? (
                                                        <div className="w-4 h-4 border-2 border-emerald-500 rounded flex items-center justify-center">
                                                            <div className="w-2 h-1 bg-emerald-500" />
                                                        </div>
                                                    ) : (
                                                        <Square className="w-4 h-4 text-muted-foreground" />
                                                    )}
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-start">{t('sales.date') || 'Date'}</TableHead>
                                            <TableHead className="text-start">{t('sales.id') || 'Sale ID'}</TableHead>
                                            <TableHead className="text-start">{t('sales.origin') || 'Origin'}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.revenue')}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.cost')}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.profit')}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.margin')}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {paginatedSales.map((sale) => {
                                            const originalSale = sale.source === 'sale' ? salesById.get(sale.id) : undefined
                                            const isFullyReturned = !!sale.isReturned || sale.returnStatus === 'returned'
                                            const hasAnyReturn = isFullyReturned || !!sale.hasPartialReturn || sale.returnStatus === 'partial'
                                            const totalReturnedQuantity = sale.totalReturnedQuantity || 0
                                            const canOpenSaleDetails = !!originalSale || sale.source === 'sales_order' || sale.source === 'exchange' || sale.source === 'real_estate' || sale.source === 'activities' || sale.source === 'clinical_appointment' || sale.source === 'post_service' || sale.source === 'car_rental' || sale.source === 'travel_transportation'

                                            const handleRecordClick = () => {
                                                if (sale.source === 'sales_order') {
                                                    setLocation(`/orders/${sale.id}`)
                                                } else if (sale.source === 'exchange') {
                                                    setLocation('/currency-exchange')
                                                } else if (sale.source === 'real_estate') {
                                                    setLocation(`/real-estate/${sale.sourceRecordId || sale.id}`)
                                                } else if (sale.source === 'activities') {
                                                    setLocation(`/activities?transaction=${sale.sourceRecordId || sale.id}`)
                                                } else if (sale.source === 'clinical_appointment') {
                                                    setLocation(`/clinical-appointments/${sale.sourceRecordId || sale.id}/edit`)
                                                } else if (sale.source === 'post_service') {
                                                    setLocation('/post-service')
                                                } else if (sale.source === 'car_rental') {
                                                    setLocation('/car-rental/contracts')
                                                } else if (sale.source === 'travel_transportation') {
                                                    setLocation(`/travel-transportation/${sale.sourceRecordId || sale.id}`)
                                                } else if (originalSale) {
                                                    setSelectedSale(originalSale)
                                                }
                                            }

                                            return (
                                                <TableRow
                                                    key={sale.key}
                                                    className={cn(
                                                        "group",
                                                        isFullyReturned ? 'bg-red-500/10 dark:bg-red-500/20 border-red-500/20' :
                                                            hasAnyReturn ? 'bg-orange-500/10 border-orange-500/20 dark:bg-orange-500/5 dark:border-orange-500/10' : '',
                                                        selectedRecordKeys.has(sale.key) && 'bg-emerald-500/5 hover:bg-emerald-500/10',
                                                        "print:bg-opacity-100"
                                                    )}
                                                >
                                                    {/* Row Checkbox - visible on hover or when selected */}
                                                    <TableCell className="w-10 text-center print:hidden">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation()
                                                                toggleRecordSelection(sale.key)
                                                            }}
                                                            className={cn(
                                                                "p-1.5 rounded transition-all",
                                                                selectedRecordKeys.has(sale.key)
                                                                    ? "opacity-100"
                                                                    : "opacity-0 group-hover:opacity-100",
                                                                "hover:bg-secondary"
                                                            )}
                                                        >
                                                            {selectedRecordKeys.has(sale.key) ? (
                                                                <Check className="w-4 h-4 text-emerald-500" />
                                                            ) : (
                                                                <Square className="w-4 h-4 text-muted-foreground" />
                                                            )}
                                                        </button>
                                                    </TableCell>
                                                    <TableCell className="text-start font-mono text-xs">
                                                        {formatDateTime(sale.date)}
                                                    </TableCell>
                                                    <TableCell className="text-start">
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={handleRecordClick}
                                                                className={cn(
                                                                    "font-mono text-[10px]",
                                                                    canOpenSaleDetails ? "text-primary hover:underline" : "text-foreground"
                                                                )}
                                                            >
                                                                {sale.referenceCode}
                                                            </button>
                                                            {canOpenSaleDetails && (
                                                                <Tooltip>
                                                                    <TooltipTrigger asChild>
                                                                        <Info
                                                                            className="w-3.5 h-3.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation()
                                                                                handleRecordClick()
                                                                            }}
                                                                        />
                                                                    </TooltipTrigger>
                                                                    <TooltipContent>
                                                                        {t('revenue.viewDetails') || 'View Sale Details'}
                                                                    </TooltipContent>
                                                                </Tooltip>
                                                            )}

                                                            {isFullyReturned && (
                                                                <span className="px-1.5 py-0.5 text-[8px] font-bold bg-destructive/20 text-destructive dark:bg-destructive/30 dark:text-destructive-foreground rounded-full border border-destructive/30 uppercase">
                                                                    {t('sales.return.returnedStatus') || 'RETURNED'}
                                                                </span>
                                                            )}

                                                            {!isFullyReturned && hasAnyReturn && (
                                                                <span className="px-1.5 py-0.5 rounded-full text-[8px] font-bold bg-orange-500/10 text-orange-600 border border-orange-500/20 uppercase whitespace-nowrap">
                                                                    {totalReturnedQuantity > 0
                                                                        ? <>-{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}</>
                                                                        : (t('sales.return.partialReturn') || 'PARTIALLY RETURNED')}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {sale.partyName && (
                                                            <div className="mt-1 text-[10px] font-semibold text-muted-foreground">
                                                                {sale.partyName}
                                                            </div>
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="text-start">
                                                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-secondary uppercase">
                                                            {revenueOriginLabel(sale.origin, sale.sourceChannel, t)}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell className="text-end font-medium">
                                                        {formatCurrency(sale.revenue, sale.currency, features.iqd_display_preference)}
                                                    </TableCell>
                                                    <TableCell className="text-end text-muted-foreground">
                                                        {formatCurrency(sale.cost, sale.currency, features.iqd_display_preference)}
                                                    </TableCell>
                                                    <TableCell className="text-end font-bold text-emerald-600">
                                                        {formatCurrency(sale.profit, sale.currency, features.iqd_display_preference)}
                                                    </TableCell>
                                                    <TableCell className="text-end">
                                                        <span className={cn(
                                                            "px-2 py-0.5 rounded-full text-[10px] font-bold",
                                                            sale.margin > 20 ? "bg-emerald-500/10 text-emerald-600" :
                                                                sale.margin > 0 ? "bg-orange-500/10 text-orange-600" :
                                                                    "bg-destructive/10 text-destructive"
                                                        )}>
                                                            {sale.margin.toFixed(1)}%
                                                        </span>
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>

                    {/* Sale Details Modal */}
                    <SaleDetailsModal
                        isOpen={!!selectedSale}
                        onClose={() => setSelectedSale(null)}
                        sale={selectedSale}
                    />

                    {/* Metric Analytics Deep-Dive Modal */}
                    <MetricDetailModal
                        isOpen={isMetricModalOpen}
                        onClose={() => setIsMetricModalOpen(false)}
                        metricType={selectedMetric}
                        currency={Object.keys(stats.statsByCurrency)[0] || features.default_currency || 'usd'}
                        iqdPreference={features.iqd_display_preference}
                        data={stats.statsByCurrency}
                    />

                    {/* Top Products Modal */}
                    <TopProductsModal
                        isOpen={isTopProductsOpen}
                        onClose={() => setIsTopProductsOpen(false)}
                        data={stats.statsByCurrency}
                        iqdPreference={features.iqd_display_preference}
                    />

                    <ProductSalesSummaryModal
                        isOpen={isProductSalesOpen}
                        onClose={() => setIsProductSalesOpen(false)}
                        summary={productSalesSummary}
                    />

                    {/* Sales Overview Modal */}
                    <SalesOverviewModal
                        isOpen={isSalesOverviewOpen}
                        onClose={() => setIsSalesOverviewOpen(false)}
                        data={stats.statsByCurrency}
                        iqdPreference={features.iqd_display_preference}
                    />

                    {/* Peak Trading Times Modal */}
                    <PeakTradingModal
                        isOpen={isPeakTradingOpen}
                        onClose={() => setIsPeakTradingOpen(false)}
                        sales={timingEntries}
                    />

                    {/* Returns Analysis Modal */}
                    <ReturnsAnalysisModal
                        isOpen={isReturnsOpen}
                        onClose={() => setIsReturnsOpen(false)}
                        sales={filteredSales}
                        iqdPreference={features.iqd_display_preference}
                        defaultCurrency={features.default_currency || 'usd'}
                    />

                    {/* Print Preview Modal */}
                    <PrintPreviewModal
                        isOpen={showPrintPreview}
                        onClose={() => setShowPrintPreview(false)}
                        module="revenue"
                        title={t('revenue.printList') || 'Print Revenue List'}
                        originId={revenueReportOriginId}
                        onConfirm={() => setShowPrintPreview(false)}
                    >
                        <div ref={listRef} className="p-4 bg-white dark:bg-zinc-900">
                            <h2 className="text-xl font-bold mb-4">{t('revenue.listTitle') || 'Revenue List'}</h2>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('sales.date') || 'Date'}</TableHead>
                                        <TableHead>{t('sales.id') || 'Sale ID'}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.revenue')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.cost')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.profit')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.margin')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {stats.saleStats.map((sale) => (
                                        <TableRow key={sale.key}>
                                            <TableCell className="font-mono text-xs">
                                                {formatDateTime(sale.date)}
                                            </TableCell>
                                            <TableCell className="font-mono text-xs">
                                                {sale.referenceCode}
                                            </TableCell>
                                            <TableCell className="text-end">
                                                {formatCurrency(sale.revenue, sale.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end text-muted-foreground">
                                                {formatCurrency(sale.cost, sale.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end font-bold text-emerald-600">
                                                {formatCurrency(sale.profit, sale.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end">
                                                <span className={cn(
                                                    "px-2 py-0.5 rounded-full text-[10px] font-bold",
                                                    sale.margin > 20 ? "bg-emerald-500/10 text-emerald-600" :
                                                        sale.margin > 0 ? "bg-orange-500/10 text-orange-600" :
                                                            "bg-destructive/10 text-destructive"
                                                )}>
                                                    {sale.margin.toFixed(1)}%
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </PrintPreviewModal>

                    <Dialog open={isFilterDialogOpen} onOpenChange={setIsFilterDialogOpen}>
                        <DialogContent className={cn("top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] w-[calc(100vw-0.75rem)] max-w-7xl overflow-hidden p-0 sm:w-[calc(100vw-2rem)]", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]" : "rounded-[2rem] border-border/60")}>
                            <div className="flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] flex-col">
                                <DialogHeader className={cn("border-b border-border/60 px-6 py-5 text-start", style === 'neo-orange' ? "bg-neo-blue/10" : "bg-gradient-to-r from-primary/8 via-background to-emerald-500/5")}>
                                    <DialogTitle className="flex items-center gap-3 text-xl font-black tracking-tight">
                                        <div className={cn("p-2.5", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white bg-white text-black" : "rounded-2xl bg-primary/10 text-primary")}>
                                            <SlidersHorizontal className="h-5 w-5" />
                                        </div>
                                        {t('revenue.filters.dialogTitle', { defaultValue: 'Revenue Analytics Filters' })}
                                    </DialogTitle>
                                    <DialogDescription className="max-w-3xl">
                                        {t('revenue.filters.dialogDescription', { defaultValue: 'Refine revenue analytics by source, cashier or creator, party, product, return state, profitability, timing, and metric ranges. The page date range stays outside this modal.' })}
                                    </DialogDescription>
                                </DialogHeader>

                                <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
                                    <div className="grid gap-3 md:grid-cols-3">
                                        <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4">
                                            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-700">{t('revenue.filters.preview', { defaultValue: 'Preview' })}</div>
                                            <div className="mt-2 text-2xl font-black text-emerald-700">{draftPreviewRevenueRecords.length}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">{t('revenue.filters.previewDescription', { defaultValue: 'records match the draft filters inside the current date range' })}</div>
                                        </div>
                                        <div className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
                                            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{t('revenue.filters.pageRange', { defaultValue: 'Page Range' })}</div>
                                            <div className="mt-2 text-sm font-bold">{getDateDisplay() || t('revenue.filters.allTime', { defaultValue: 'All Time' })}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">{t('revenue.filters.pageRangeDescription', { defaultValue: 'Controlled directly from the Revenue Analytics page header' })}</div>
                                        </div>
                                        <div className="rounded-2xl border border-border/60 bg-secondary/20 p-4">
                                            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{t('revenue.filters.draftFilters', { defaultValue: 'Draft Filters' })}</div>
                                            <div className="mt-2 text-2xl font-black">{countActiveRevenueFilters(draftFilters)}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">{t('revenue.filters.draftFiltersDescription', { defaultValue: 'advanced revenue conditions configured' })}</div>
                                        </div>
                                    </div>

                                    <section className="grid gap-4 lg:grid-cols-2">
                                        <div className={cn("space-y-4 p-5", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white bg-white dark:bg-black" : "rounded-[1.5rem] border border-border/60 bg-background/80")}>
                                            <div className="space-y-1">
                                                <h3 className="text-base font-black tracking-tight">{t('revenue.filters.searchSource', { defaultValue: 'Search, Source & Staff' })}</h3>
                                                <p className="text-sm text-muted-foreground">{t('revenue.filters.searchSourceDescription', { defaultValue: 'Search records and narrow them by origin, channel, cashier, or creator.' })}</p>
                                            </div>

                                            <div className="space-y-2">
                                                <Label htmlFor="revenue-filter-search">{t('revenue.filters.keywordSearch', { defaultValue: 'Keyword Search' })}</Label>
                                                <div className="relative">
                                                    <Search className="pointer-events-none absolute start-3 top-3.5 h-4 w-4 text-muted-foreground" />
                                                    <Input
                                                        id="revenue-filter-search"
                                                        value={draftFilters.search}
                                                        onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
                                                        placeholder={t('revenue.filters.searchPlaceholder', { defaultValue: 'Search ID, party, staff, product, category...' })}
                                                        className="ps-9"
                                                    />
                                                </div>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.sortBy', { defaultValue: 'Sort By' })}</Label>
                                                    <Select value={draftFilters.sort} onValueChange={(value: RevenueSortOption) => setDraftFilters((current) => ({ ...current, sort: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {([
                                                                'date_desc',
                                                                'date_asc',
                                                                'revenue_desc',
                                                                'revenue_asc',
                                                                'cost_desc',
                                                                'cost_asc',
                                                                'profit_desc',
                                                                'profit_asc',
                                                                'margin_desc',
                                                                'margin_asc',
                                                                'cashier_asc',
                                                                'cashier_desc',
                                                                'origin_asc',
                                                                'origin_desc'
                                                            ] as RevenueSortOption[]).map((option) => (
                                                                <SelectItem key={option} value={option}>{revenueSortOptionLabel(option, t)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>

                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.origin', { defaultValue: 'Source / Origin' })}</Label>
                                                    <Select value={draftFilters.origin} onValueChange={(value) => setDraftFilters((current) => ({ ...current, origin: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="all">{t('revenue.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                            {revenueFilterOptions.origins.map((origin) => (
                                                                <SelectItem key={origin.value} value={origin.value}>{origin.label}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.sourceChannel', { defaultValue: 'Source Channel' })}</Label>
                                                    <Select value={draftFilters.sourceChannel} onValueChange={(value) => setDraftFilters((current) => ({ ...current, sourceChannel: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="all">{t('revenue.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                            {revenueFilterOptions.sourceChannels.map((channel) => (
                                                                <SelectItem key={channel.value} value={channel.value}>{channel.label}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>

                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.cashierCreatedBy', { defaultValue: 'Cashier / Created By' })}</Label>
                                                    <Select value={draftFilters.cashier} onValueChange={(value) => setDraftFilters((current) => ({ ...current, cashier: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="all">{t('revenue.filters.allCashiers', { defaultValue: 'All Cashiers' })}</SelectItem>
                                                            {revenueFilterOptions.staff.map((staff) => (
                                                                <SelectItem key={staff.value} value={staff.value}>{staff.label}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>

                                            <div className="space-y-2">
                                                <Label>{t('revenue.filters.party', { defaultValue: 'Customer / Party' })}</Label>
                                                <div className="grid gap-3">
                                                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                                                        <PartnerAutocompleteInput
                                                            value={draftFilters.partySearch}
                                                            onChange={(value) => setDraftFilters((current) => ({
                                                                ...current,
                                                                partySearch: value,
                                                                party: value.trim() ? value.trim() : 'all',
                                                                partyPartnerId: ''
                                                            }))}
                                                            onSelectPartner={(partner) => setDraftFilters((current) => ({
                                                                ...current,
                                                                partySearch: partner.partnerName,
                                                                party: partner.partnerName,
                                                                partyPartnerId: partner.id
                                                            }))}
                                                            workspaceId={user?.workspaceId || ''}
                                                            roles={['customer']}
                                                            placeholder={t('revenue.filters.selectParty', { defaultValue: 'Select Customer / Party' })}
                                                            disabled={!user?.workspaceId}
                                                        />
                                                        {draftFilters.party !== 'all' || draftFilters.partySearch ? (
                                                            <Button
                                                                type="button"
                                                                variant="outline"
                                                                onClick={() => setDraftFilters((current) => ({ ...current, party: 'all', partyPartnerId: '', partySearch: '' }))}
                                                                className={cn("h-10", style === 'neo-orange' ? "rounded-none" : "rounded-2xl")}
                                                            >
                                                                <X className="me-2 h-4 w-4" />
                                                                {t('revenue.filters.clear', { defaultValue: 'Clear' })}
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                    {draftFilters.partyPartnerId && draftFilters.partySearch ? (
                                                        <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                                                            <div className="min-w-0">
                                                                <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-primary">
                                                                    <Users className="h-3.5 w-3.5" />
                                                                    {t('revenue.filters.linkedParty', { defaultValue: 'Linked Customer / Party' })}
                                                                </div>
                                                                <div className="truncate text-sm font-semibold">{draftFilters.partySearch}</div>
                                                            </div>
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-8 shrink-0 px-2 text-muted-foreground"
                                                                onClick={() => setDraftFilters((current) => ({ ...current, party: 'all', partyPartnerId: '', partySearch: '' }))}
                                                            >
                                                                <X className="me-1.5 h-4 w-4" />
                                                                {t('revenue.filters.clearLink', { defaultValue: 'Clear Link' })}
                                                            </Button>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>

                                        <div className={cn("space-y-4 p-5", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white bg-white dark:bg-black" : "rounded-[1.5rem] border border-border/60 bg-background/80")}>
                                            <div className="space-y-1">
                                                <h3 className="text-base font-black tracking-tight">{t('revenue.filters.revenueDetails', { defaultValue: 'Revenue Details' })}</h3>
                                                <p className="text-sm text-muted-foreground">{t('revenue.filters.revenueDetailsDescription', { defaultValue: 'Filter by currency, payment method, product, category, returns, and profitability.' })}</p>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.currency', { defaultValue: 'Currency' })}</Label>
                                                    <Select value={draftFilters.currency} onValueChange={(value) => setDraftFilters((current) => ({ ...current, currency: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="all">{t('revenue.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                            {revenueFilterOptions.currencies.map((currency) => (
                                                                <SelectItem key={currency} value={currency}>{currency.toUpperCase()}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>

                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.paymentMethod', { defaultValue: 'Payment Method' })}</Label>
                                                    <Select value={draftFilters.paymentMethod} onValueChange={(value) => setDraftFilters((current) => ({ ...current, paymentMethod: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="all">{t('revenue.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                            {revenueFilterOptions.paymentMethods.map((method) => (
                                                                <SelectItem key={method} value={method}>{revenuePaymentMethodLabel(method, t)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.category', { defaultValue: 'Product Category' })}</Label>
                                                    <Select value={draftFilters.category} onValueChange={(value) => setDraftFilters((current) => ({ ...current, category: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="all">{t('revenue.filters.allCategories', { defaultValue: 'All Categories' })}</SelectItem>
                                                            {revenueFilterOptions.categories.map((category) => (
                                                                <SelectItem key={category} value={category}>{category}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>

                                            <div className="space-y-2">
                                                <Label>{t('revenue.filters.storage', { defaultValue: 'Storage' })}</Label>
                                                <Select value={draftFilters.storage} onValueChange={(value) => setDraftFilters((current) => ({ ...current, storage: value }))}>
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="all">{t('revenue.filters.allStorages', { defaultValue: 'All Storages' })}</SelectItem>
                                                        {storages.map((storage) => (
                                                            <SelectItem key={storage.id} value={storage.id}>{storage.name}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.returnStatus', { defaultValue: 'Return Status' })}</Label>
                                                    <Select value={draftFilters.returnStatus} onValueChange={(value: RevenueReturnStatusFilter) => setDraftFilters((current) => ({ ...current, returnStatus: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {(['all', 'non_returned', 'partial', 'returned'] as RevenueReturnStatusFilter[]).map((status) => (
                                                                <SelectItem key={status} value={status}>{revenueReturnStatusLabel(status, t)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>

                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.profitStatus', { defaultValue: 'Profit Status' })}</Label>
                                                    <Select value={draftFilters.profitStatus} onValueChange={(value: RevenueProfitStatusFilter) => setDraftFilters((current) => ({ ...current, profitStatus: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {(['all', 'profitable', 'break_even', 'loss'] as RevenueProfitStatusFilter[]).map((status) => (
                                                                <SelectItem key={status} value={status}>{revenueProfitStatusLabel(status, t)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>
                                        </div>

                                        <div className={cn("space-y-4 p-5 lg:col-span-2", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white bg-white dark:bg-black" : "rounded-[1.5rem] border border-border/60 bg-background/80")}>
                                            <div className="space-y-1">
                                                <h3 className="text-base font-black tracking-tight">{t('revenue.filters.productSearchTitle', { defaultValue: 'Product Search' })}</h3>
                                                <p className="text-sm text-muted-foreground">{t('revenue.filters.productSearchDescription', { defaultValue: 'Filter revenue by a linked catalog product.' })}</p>
                                            </div>

                                            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.product', { defaultValue: 'Product / Service' })}</Label>
                                                    <ProductAutocompleteInput
                                                        value={draftFilters.productSearch}
                                                        onChange={(value) => setDraftFilters((current) => ({ ...current, productSearch: value, product: 'all' }))}
                                                        onSelectProduct={(product) => setDraftFilters((current) => ({ ...current, product: product.id, productSearch: product.name }))}
                                                        products={products}
                                                        placeholder={t('revenue.filters.selectProduct', { defaultValue: 'Select Product' })}
                                                        hasSelection={draftFilters.product !== 'all'}
                                                        linkedLabel={t('revenue.filters.linked', { defaultValue: 'Linked' })}
                                                        skuLabel={t('revenue.filters.sku', { defaultValue: 'SKU' })}
                                                    />
                                                </div>
                                                {draftFilters.product !== 'all' || draftFilters.productSearch ? (
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        onClick={() => setDraftFilters((current) => ({ ...current, product: 'all', productSearch: '' }))}
                                                        className={cn("h-10", style === 'neo-orange' ? "rounded-none" : "rounded-2xl")}
                                                    >
                                                        <X className="me-2 h-4 w-4" />
                                                        {t('revenue.filters.clear', { defaultValue: 'Clear' })}
                                                    </Button>
                                                ) : null}
                                            </div>
                                        </div>

                                        <div className={cn("space-y-4 p-5", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white bg-white dark:bg-black" : "rounded-[1.5rem] border border-border/60 bg-background/80")}>
                                            <div className="space-y-1">
                                                <h3 className="text-base font-black tracking-tight">{t('revenue.filters.metricRanges', { defaultValue: 'Metric Ranges' })}</h3>
                                                <p className="text-sm text-muted-foreground">{t('revenue.filters.metricRangesDescription', { defaultValue: 'Set min and max thresholds for revenue, cost, profit, or margin.' })}</p>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-min-revenue">{t('revenue.filters.minRevenue', { defaultValue: 'Min Revenue' })}</Label>
                                                    <Input id="revenue-filter-min-revenue" type="number" min="0" value={draftFilters.minRevenue} onChange={(event) => setDraftFilters((current) => ({ ...current, minRevenue: event.target.value }))} placeholder="0" />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-max-revenue">{t('revenue.filters.maxRevenue', { defaultValue: 'Max Revenue' })}</Label>
                                                    <Input id="revenue-filter-max-revenue" type="number" min="0" value={draftFilters.maxRevenue} onChange={(event) => setDraftFilters((current) => ({ ...current, maxRevenue: event.target.value }))} placeholder={t('revenue.filters.noCap', { defaultValue: 'No cap' })} />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-min-cost">{t('revenue.filters.minCost', { defaultValue: 'Min Cost' })}</Label>
                                                    <Input id="revenue-filter-min-cost" type="number" min="0" value={draftFilters.minCost} onChange={(event) => setDraftFilters((current) => ({ ...current, minCost: event.target.value }))} placeholder="0" />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-max-cost">{t('revenue.filters.maxCost', { defaultValue: 'Max Cost' })}</Label>
                                                    <Input id="revenue-filter-max-cost" type="number" min="0" value={draftFilters.maxCost} onChange={(event) => setDraftFilters((current) => ({ ...current, maxCost: event.target.value }))} placeholder={t('revenue.filters.noCap', { defaultValue: 'No cap' })} />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-min-profit">{t('revenue.filters.minProfit', { defaultValue: 'Min Profit' })}</Label>
                                                    <Input id="revenue-filter-min-profit" type="number" value={draftFilters.minProfit} onChange={(event) => setDraftFilters((current) => ({ ...current, minProfit: event.target.value }))} placeholder="0" />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-max-profit">{t('revenue.filters.maxProfit', { defaultValue: 'Max Profit' })}</Label>
                                                    <Input id="revenue-filter-max-profit" type="number" value={draftFilters.maxProfit} onChange={(event) => setDraftFilters((current) => ({ ...current, maxProfit: event.target.value }))} placeholder={t('revenue.filters.noCap', { defaultValue: 'No cap' })} />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-min-margin">{t('revenue.filters.minMargin', { defaultValue: 'Min Margin (%)' })}</Label>
                                                    <Input id="revenue-filter-min-margin" type="number" value={draftFilters.minMargin} onChange={(event) => setDraftFilters((current) => ({ ...current, minMargin: event.target.value }))} placeholder="0" />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="revenue-filter-max-margin">{t('revenue.filters.maxMargin', { defaultValue: 'Max Margin (%)' })}</Label>
                                                    <Input id="revenue-filter-max-margin" type="number" value={draftFilters.maxMargin} onChange={(event) => setDraftFilters((current) => ({ ...current, maxMargin: event.target.value }))} placeholder="100" />
                                                </div>
                                            </div>
                                        </div>

                                        <div className={cn("space-y-4 p-5", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white bg-white dark:bg-black" : "rounded-[1.5rem] border border-border/60 bg-background/80")}>
                                            <div className="space-y-1">
                                                <h3 className="text-base font-black tracking-tight">{t('revenue.filters.timing', { defaultValue: 'Timing' })}</h3>
                                                <p className="text-sm text-muted-foreground">{t('revenue.filters.timingDescription', { defaultValue: 'Narrow peak-time analytics by day of week or hour.' })}</p>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.dayOfWeek', { defaultValue: 'Day of Week' })}</Label>
                                                    <Select value={draftFilters.dayOfWeek} onValueChange={(value: RevenueDayFilter) => setDraftFilters((current) => ({ ...current, dayOfWeek: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {(['all', '0', '1', '2', '3', '4', '5', '6'] as RevenueDayFilter[]).map((day) => (
                                                                <SelectItem key={day} value={day}>{revenueDayLabel(day, t)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>

                                                <div className="space-y-2">
                                                    <Label>{t('revenue.filters.hour', { defaultValue: 'Hour' })}</Label>
                                                    <Select value={draftFilters.hour} onValueChange={(value) => setDraftFilters((current) => ({ ...current, hour: value }))}>
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="all">{revenueHourLabel('all', t)}</SelectItem>
                                                            {Array.from({ length: 24 }, (_, hour) => String(hour)).map((hour) => (
                                                                <SelectItem key={hour} value={hour}>{revenueHourLabel(hour, t)}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            </div>
                                        </div>
                                    </section>
                                </div>

                                <DialogFooter className="border-t border-border/60 bg-background/95 px-6 py-4 sm:justify-between">
                                    <Button type="button" variant="ghost" onClick={handleResetDraftFilters} className={cn(style === 'neo-orange' ? "rounded-none" : "rounded-2xl")}>
                                        <RotateCcw className="me-2 h-4 w-4" />
                                        {t('revenue.filters.resetDraft', { defaultValue: 'Reset Draft' })}
                                    </Button>
                                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                                        <Button type="button" variant="outline" onClick={() => setIsFilterDialogOpen(false)} className={cn(style === 'neo-orange' ? "rounded-none" : "rounded-2xl")}>
                                            {t('revenue.filters.cancel', { defaultValue: 'Cancel' })}
                                        </Button>
                                        <Button type="button" onClick={handleApplyFilters} className={cn(style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-y-[2px]" : "rounded-2xl")}>
                                            {t('revenue.filters.applyFilters', { count: draftPreviewRevenueRecords.length, defaultValue: `Apply Filters (${draftPreviewRevenueRecords.length})` })}
                                        </Button>
                                    </div>
                                </DialogFooter>
                            </div>
                        </DialogContent>
                    </Dialog>
                </div>
            </div>

        </TooltipProvider >
    )
}
