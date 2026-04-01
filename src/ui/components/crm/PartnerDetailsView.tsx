import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CalendarDays, CreditCard, Eye, LayoutGrid, List, Mail, MapPin, Package, Phone, Receipt, ShoppingCart, Truck, UsersRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'wouter'

import { convertCurrencyAmountWithSnapshot } from '@/lib/orderCurrency'
import { getLoanDetailsPath, getLoanDirection, getLoanDirectionLabel, isSimpleLoan } from '@/lib/loanPresentation'
import { getTravelSaleCost, getTravelStatusLabel } from '@/lib/travelAgency'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import {
    useBusinessPartner,
    useCustomerSalesOrders,
    useLoans,
    useSupplierPurchaseOrders,
    useSupplierTravelAgencySales,
    type Loan,
    type PurchaseOrder,
    type SalesOrder,
    type TravelAgencySale
} from '@/local-db'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/ui/components'
import { useWorkspace } from '@/workspace'

type PartnerKind = 'customer' | 'supplier' | 'business_partner'
type RelatedProductOrder = SalesOrder | PurchaseOrder
type RelatedTransaction = {
    id: string
    source: 'sales_order' | 'purchase_order' | 'travel_sale' | 'loan' | 'simple_loan'
    reference: string
    displayDate: string
    sortDate: string
    activityDate: string
    status: string
    statusLabel: string
    isPaid: boolean
    summary: string
    total: number
    currency: SalesOrder['currency']
    totalInPartnerCurrency: number
    units: number
    viewHref: string
    isActive: boolean
    isCompleted: boolean
    isOutstanding: boolean
}
type TranslationFn = (key: string, options?: Record<string, unknown>) => string

function roleIncludesCustomer(role: 'customer' | 'supplier' | 'both') {
    return role === 'customer' || role === 'both'
}

function roleIncludesSupplier(role: 'customer' | 'supplier' | 'both') {
    return role === 'supplier' || role === 'both'
}

function roleBadgeLabel(role: 'customer' | 'supplier' | 'both', t: TranslationFn) {
    switch (role) {
        case 'customer':
            return t('customers.title', { defaultValue: 'Customer' })
        case 'supplier':
            return t('suppliers.title', { defaultValue: 'Supplier' })
        default:
            return t('businessPartners.roles.both', { defaultValue: 'Both' })
    }
}

function sourceLabel(source: RelatedTransaction['source'], t: TranslationFn) {
    switch (source) {
        case 'sales_order':
            return t('orders.tabs.sales', { defaultValue: 'Sales Order' })
        case 'purchase_order':
            return t('orders.tabs.purchase', { defaultValue: 'Purchase Order' })
        case 'travel_sale':
            return t('travelAgency.title', { defaultValue: 'Travel Sale' })
        case 'simple_loan':
            return t('loans.simpleTab', { defaultValue: 'Loans' })
        default:
            return t('loans.installmentLoan', { defaultValue: 'Installment Loan' })
    }
}

function sourceBadgeClass(source: RelatedTransaction['source']) {
    switch (source) {
        case 'sales_order':
            return 'border-emerald-200 bg-emerald-500/10 text-emerald-700'
        case 'purchase_order':
            return 'border-sky-200 bg-sky-500/10 text-sky-700'
        case 'travel_sale':
            return 'border-violet-200 bg-violet-500/10 text-violet-700'
        default:
            return 'border-orange-200 bg-orange-500/10 text-orange-700'
    }
}

function statusBadgeClass(status: string) {
    if (status === 'draft') return 'bg-slate-100 text-slate-700 border-slate-200'
    if (status === 'pending') return 'bg-amber-100 text-amber-800 border-amber-200'
    if (status === 'ordered') return 'bg-blue-100 text-blue-800 border-blue-200'
    if (status === 'received') return 'bg-cyan-100 text-cyan-800 border-cyan-200'
    if (status === 'completed') return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    if (status === 'cancelled') return 'bg-rose-100 text-rose-800 border-rose-200'
    if (status === 'active') return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    if (status === 'overdue') return 'bg-rose-100 text-rose-800 border-rose-200'
    return 'bg-muted text-muted-foreground border-border'
}

function statusLabel(t: TranslationFn, status: string) {
    return t(`orders.status.${status}`, { defaultValue: status })
}

function readViewMode(kind: PartnerKind) {
    return (localStorage.getItem(`partner_details_view_mode_${kind}`) as 'table' | 'grid') || 'table'
}

function getOrderSummary(items: Array<{ productName: string }>) {
    const firstItems = items.slice(0, 2).map((item) => item.productName)
    if (items.length <= 2) return firstItems.join(', ')
    return `${firstItems.join(', ')} +${items.length - 2}`
}

function getTravelSaleSummary(sale: TravelAgencySale) {
    if (sale.travelPackages.length > 0) {
        return sale.travelPackages.join(', ')
    }

    return sale.touristCount === 1 ? '1 traveller' : `${sale.touristCount} travellers`
}

function toPartnerCurrency(order: RelatedProductOrder, currency: SalesOrder['currency']) {
    return convertCurrencyAmountWithSnapshot(order.total, order.currency, currency, order.exchangeRates)
}

function toPartnerCurrencyFromTravelSale(sale: TravelAgencySale, currency: SalesOrder['currency']) {
    return convertCurrencyAmountWithSnapshot(
        getTravelSaleCost(sale),
        sale.currency,
        currency,
        sale.exchangeRateSnapshot ? [sale.exchangeRateSnapshot] as any : undefined
    )
}

function normalizeSalesOrder(order: SalesOrder, currency: SalesOrder['currency'], t: TranslationFn): RelatedTransaction {
    return {
        id: order.id,
        source: 'sales_order',
        reference: order.orderNumber,
        displayDate: order.createdAt,
        sortDate: order.updatedAt || order.createdAt,
        activityDate: order.actualDeliveryDate || order.paidAt || order.updatedAt || order.createdAt,
        status: order.status,
        statusLabel: statusLabel(t, order.status),
        isPaid: order.isPaid,
        summary: getOrderSummary(order.items),
        total: order.total,
        currency: order.currency,
        totalInPartnerCurrency: toPartnerCurrency(order, currency),
        units: order.items.reduce((sum, item) => sum + item.quantity, 0),
        viewHref: `/orders/${order.id}`,
        isActive: order.status !== 'cancelled',
        isCompleted: order.status === 'completed',
        isOutstanding: !order.isPaid && (order.status === 'pending' || order.status === 'completed')
    }
}

function normalizePurchaseOrder(order: PurchaseOrder, currency: SalesOrder['currency'], t: TranslationFn): RelatedTransaction {
    return {
        id: order.id,
        source: 'purchase_order',
        reference: order.orderNumber,
        displayDate: order.createdAt,
        sortDate: order.updatedAt || order.createdAt,
        activityDate: order.actualDeliveryDate || order.paidAt || order.updatedAt || order.createdAt,
        status: order.status,
        statusLabel: statusLabel(t, order.status),
        isPaid: order.isPaid,
        summary: getOrderSummary(order.items),
        total: order.total,
        currency: order.currency,
        totalInPartnerCurrency: toPartnerCurrency(order, currency),
        units: order.items.reduce((sum, item) => sum + item.quantity, 0),
        viewHref: `/orders/${order.id}`,
        isActive: order.status !== 'cancelled',
        isCompleted: order.status === 'received' || order.status === 'completed',
        isOutstanding: !order.isPaid && (order.status === 'ordered' || order.status === 'received' || order.status === 'completed')
    }
}

function normalizeTravelSale(sale: TravelAgencySale, currency: SalesOrder['currency']): RelatedTransaction {
    return {
        id: sale.id,
        source: 'travel_sale',
        reference: sale.saleNumber,
        displayDate: sale.saleDate,
        sortDate: sale.updatedAt || sale.saleDate || sale.createdAt,
        activityDate: sale.paidAt || sale.updatedAt || sale.saleDate || sale.createdAt,
        status: sale.status,
        statusLabel: getTravelStatusLabel(sale.status),
        isPaid: sale.isPaid,
        summary: getTravelSaleSummary(sale),
        total: getTravelSaleCost(sale),
        currency: sale.currency,
        totalInPartnerCurrency: toPartnerCurrencyFromTravelSale(sale, currency),
        units: 0,
        viewHref: `/travel-agency/${sale.id}/view`,
        isActive: sale.status !== 'draft',
        isCompleted: sale.status === 'completed',
        isOutstanding: !sale.isPaid && sale.status === 'completed'
    }
}

function loanStatusLabel(t: TranslationFn, status: Loan['status']) {
    if (status === 'active') return t('sales.loanActive', { defaultValue: 'Loan Active' })
    if (status === 'overdue') return t('sales.loanOverdue', { defaultValue: 'Loan Overdue' })
    if (status === 'completed') return t('sales.loanCompleted', { defaultValue: 'Loan Completed' })
    return status
}

function normalizeLoan(loan: Loan, currency: SalesOrder['currency'], t: TranslationFn): RelatedTransaction {
    const direction = getLoanDirection(loan)
    const directionLabel = getLoanDirectionLabel(direction, t)
    return {
        id: loan.id,
        source: isSimpleLoan(loan) ? 'simple_loan' : 'loan',
        reference: loan.loanNo,
        displayDate: loan.createdAt,
        sortDate: loan.updatedAt || loan.createdAt,
        activityDate: loan.updatedAt || loan.createdAt,
        status: loan.status,
        statusLabel: loanStatusLabel(t, loan.status),
        isPaid: loan.balanceAmount <= 0 || loan.status === 'completed',
        summary: isSimpleLoan(loan) ? `${directionLabel} • ${loan.borrowerName}` : loan.borrowerName,
        total: loan.balanceAmount,
        currency: loan.settlementCurrency,
        totalInPartnerCurrency: convertCurrencyAmountWithSnapshot(loan.balanceAmount, loan.settlementCurrency, currency),
        units: 0,
        viewHref: getLoanDetailsPath(loan, loan.id),
        isActive: loan.status !== 'completed',
        isCompleted: loan.status === 'completed',
        isOutstanding: loan.balanceAmount > 0
    }
}

function paymentBadgeClass(isPaid: boolean) {
    return isPaid
        ? 'border-emerald-200 bg-emerald-500/10 text-emerald-700'
        : 'border-amber-200 bg-amber-500/10 text-amber-700'
}

export function PartnerDetailsView({
    workspaceId,
    partnerId,
    kind
}: {
    workspaceId: string
    partnerId: string
    kind: PartnerKind
}) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [, navigate] = useLocation()
    const partner = useBusinessPartner(partnerId)
    const customerOrders = useCustomerSalesOrders(partnerId, workspaceId)
    const supplierOrders = useSupplierPurchaseOrders(partnerId, workspaceId)
    const supplierTravelSales = useSupplierTravelAgencySales(partnerId, workspaceId)
    const loans = useLoans(workspaceId)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => readViewMode(kind))

    useEffect(() => {
        localStorage.setItem(`partner_details_view_mode_${kind}`, viewMode)
    }, [kind, viewMode])

    const partnerLoans = useMemo(
        () => loans.filter((loan) => loan.linkedPartyType === 'business_partner' && loan.linkedPartyId === partner?.id),
        [loans, partner?.id]
    )
    const allowedByRoute = useMemo(() => {
        if (!partner) {
            return false
        }
        if (kind === 'customer') {
            return roleIncludesCustomer(partner.role)
        }
        if (kind === 'supplier') {
            return roleIncludesSupplier(partner.role)
        }
        return true
    }, [kind, partner])

    const defaultCurrency = partner?.defaultCurrency ?? features.default_currency
    const iqdPreference = features.iqd_display_preference
    const listHref = kind === 'customer'
        ? '/customers'
        : kind === 'supplier'
            ? '/suppliers'
            : '/business-partners'
    const listLabel = kind === 'customer'
        ? t('customers.title', { defaultValue: 'Customers' })
        : kind === 'supplier'
            ? t('suppliers.title', { defaultValue: 'Suppliers' })
            : t('businessPartners.title', { defaultValue: 'Business Partners' })
    const typeLabel = partner ? roleBadgeLabel(partner.role, t) : t('businessPartners.title', { defaultValue: 'Business Partner' })
    const contactName = partner?.contactName
    const emptyRelatedLabel = t('businessPartners.noActivity', { defaultValue: 'No related activity yet.' })
    const totalValueLabel = t('businessPartners.relationshipValue', { defaultValue: 'Relationship Value' })
    const completedLabel = t('businessPartners.completedItems', { defaultValue: 'Completed Items' })
    const paidLabel = t('businessPartners.settledItems', { defaultValue: 'Settled Items' })
    const activeLabel = t('businessPartners.activeItems', { defaultValue: 'Active Items' })
    const listTitle = t('businessPartners.activityTimeline', { defaultValue: 'Unified Activity Timeline' })
    const overviewTitle = t('businessPartners.overview', { defaultValue: 'Partner Overview' })
    const lastActivityLabel = t('businessPartners.lastActivity', { defaultValue: 'Last Activity' })
    const firstActivityLabel = t('businessPartners.firstActivity', { defaultValue: 'First Activity' })
    const detailsColumnLabel = t('common.details', { defaultValue: 'Details' })
    const referenceColumnLabel = t('common.reference', { defaultValue: 'Reference' })
    const productOrders = [...customerOrders, ...supplierOrders]

    const relatedTransactions = useMemo(
        () => [
            ...customerOrders.map((order) => normalizeSalesOrder(order, defaultCurrency, t)),
            ...supplierOrders.map((order) => normalizePurchaseOrder(order, defaultCurrency, t)),
            ...supplierTravelSales.map((sale) => normalizeTravelSale(sale, defaultCurrency)),
            ...partnerLoans.map((loan) => normalizeLoan(loan, defaultCurrency, t))
        ],
        [customerOrders, defaultCurrency, partnerLoans, supplierOrders, supplierTravelSales, t]
    )
    const activeTransactions = useMemo(
        () => relatedTransactions.filter((transaction) => transaction.isActive),
        [relatedTransactions]
    )
    const settledTransactions = useMemo(
        () => activeTransactions.filter((transaction) => transaction.isPaid),
        [activeTransactions]
    )
    const completedTransactions = useMemo(
        () => activeTransactions.filter((transaction) => transaction.isCompleted),
        [activeTransactions]
    )
    const sortedTransactions = useMemo(
        () => [...relatedTransactions].sort((a, b) => new Date(b.sortDate).getTime() - new Date(a.sortDate).getTime()),
        [relatedTransactions]
    )
    const totalValue = partner ? partner.totalSalesValue + partner.totalPurchaseValue : 0
    const outstandingValue = (partner?.receivableBalance || 0) + (partner?.payableBalance || 0) + (partner?.loanOutstandingBalance || 0)
    const averageOrderValue = (customerOrders.length + supplierOrders.length + supplierTravelSales.length) > 0
        ? totalValue / (customerOrders.length + supplierOrders.length + supplierTravelSales.length)
        : 0
    const totalUnits = useMemo(
        () => productOrders
            .filter((order) => order.status !== 'cancelled')
            .reduce((sum, order) => sum + order.items.reduce((lineSum, item) => lineSum + item.quantity, 0), 0),
        [productOrders]
    )
    const settledPercent = relatedTransactions.length > 0 ? Math.min(100, (settledTransactions.length / relatedTransactions.length) * 100) : 0
    const creditUsagePercent = partner?.creditLimit && partner.creditLimit > 0 ? Math.min(100, (Math.max(partner.netExposure, 0) / partner.creditLimit) * 100) : 0
    const latestTransaction = sortedTransactions[0]
    const earliestTransaction = sortedTransactions[sortedTransactions.length - 1]
    const locationLabel = partner ? [partner.city, partner.country].filter(Boolean).join(', ') || 'N/A' : 'N/A'
    const activityRows = useMemo(
        () => sortedTransactions.slice(0, 8).map((transaction) => ({
            id: transaction.id,
            date: transaction.activityDate,
            title: transaction.reference,
            statusLabel: transaction.statusLabel,
            total: transaction.total,
            currency: transaction.currency,
            source: transaction.source
        })),
        [sortedTransactions]
    )
    const topProducts = useMemo(() => {
        const rows = new Map<string, { id: string; name: string; quantity: number; amount: number }>()
        for (const order of productOrders.filter((row) => row.status !== 'cancelled')) {
            for (const item of order.items) {
                const current = rows.get(item.productId) ?? {
                    id: item.productId,
                    name: item.productName,
                    quantity: 0,
                    amount: 0
                }
                current.quantity += item.quantity
                current.amount += convertCurrencyAmountWithSnapshot(item.lineTotal, order.currency, defaultCurrency, order.exchangeRates)
                rows.set(item.productId, current)
            }
        }

        return Array.from(rows.values()).sort((a, b) => {
            if (b.amount !== a.amount) {
                return b.amount - a.amount
            }

            return b.quantity - a.quantity
        }).slice(0, 5)
    }, [defaultCurrency, productOrders])

    if (!partner || !allowedByRoute) {
        return (
            <Card>
                <CardContent className="space-y-4 py-10 text-center">
                    <div className="text-lg font-semibold">
                        {t('businessPartners.notFound', { defaultValue: 'Business partner not found' })}
                    </div>
                    <div className="text-sm text-muted-foreground">
                        {t('businessPartners.notFoundDescription', { defaultValue: 'The requested record may have been deleted or moved out of this workspace.' })}
                    </div>
                    <div>
                        <Button variant="outline" onClick={() => navigate(listHref)}>
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            {listLabel}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        )
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Link href={listHref} className="inline-flex items-center gap-1 hover:text-foreground">
                        <ArrowLeft className="h-4 w-4" />
                        {listLabel}
                    </Link>
                    <span>/</span>
                    <span className="font-semibold text-foreground">{partner.name}</span>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('businessPartners.profile', { defaultValue: 'Partner Profile' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <div className="flex items-start gap-3 rounded-2xl border bg-muted/20 p-4">
                                <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                    {partner.role === 'supplier' ? <Truck className="h-4 w-4" /> : <UsersRound className="h-4 w-4" />}
                                </div>
                                <div className="min-w-0">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{typeLabel}</div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <div className="truncate text-lg font-semibold">{partner.name}</div>
                                        {partner.isEcommerce ? (
                                            <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                                                {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                                            </span>
                                        ) : null}
                                    </div>
                                    <div className="mt-1 flex flex-wrap gap-2">
                                        <span className="rounded-full border bg-background/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em]">
                                            {partner.defaultCurrency.toUpperCase()}
                                        </span>
                                        <span className="rounded-full border bg-background/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em]">
                                            {formatDate(partner.createdAt)}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {contactName ? (
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="flex items-start gap-3">
                                        <UsersRound className="mt-0.5 h-4 w-4 text-muted-foreground" />
                                        <div>
                                            <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                                {t('suppliers.form.contactName', { defaultValue: 'Contact Name' })}
                                            </div>
                                            <div className="font-medium">{contactName}</div>
                                        </div>
                                    </div>
                                </div>
                            ) : null}

                            <div className="rounded-2xl border bg-background/70 p-4">
                                <div className="flex items-start gap-3">
                                    <Phone className="mt-0.5 h-4 w-4 text-muted-foreground" />
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                            {t('customers.form.phone', { defaultValue: 'Phone' })}
                                        </div>
                                        <div className="font-medium">{partner.phone || 'N/A'}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-2xl border bg-background/70 p-4">
                                <div className="flex items-start gap-3">
                                    <Mail className="mt-0.5 h-4 w-4 text-muted-foreground" />
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                            {t('customers.form.email', { defaultValue: 'Email' })}
                                        </div>
                                        <div className="break-all font-medium">{partner.email || 'N/A'}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-2xl border bg-background/70 p-4">
                                <div className="flex items-start gap-3">
                                    <MapPin className="mt-0.5 h-4 w-4 text-muted-foreground" />
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                            {t('customers.table.location', { defaultValue: 'Location' })}
                                        </div>
                                        <div className="font-medium">{locationLabel}</div>
                                    </div>
                                </div>
                            </div>

                            {partner.address ? (
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                        {t('customers.form.address', { defaultValue: 'Address' })}
                                    </div>
                                    <div className="mt-1 whitespace-pre-wrap">{partner.address}</div>
                                </div>
                            ) : null}

                            {partner.notes ? (
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                        {t('orders.details.notes', { defaultValue: 'Notes' })}
                                    </div>
                                    <div className="mt-2 whitespace-pre-wrap">{partner.notes}</div>
                                </div>
                            ) : null}
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden border-none bg-transparent shadow-none">
                        <CardHeader className="flex flex-row items-center justify-between pb-2">
                            <CardTitle className="text-xl font-bold">{t('businessPartners.relationship', { defaultValue: 'Relationship Summary' })}</CardTitle>
                            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                                {typeLabel}
                            </span>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="rounded-2xl border border-border/40 bg-muted/30 p-6 text-center">
                                <div className="text-sm font-medium text-muted-foreground">
                                    {totalValueLabel}
                                </div>
                                <div className="mt-1 text-4xl font-black tracking-tight">
                                    {formatCurrency(totalValue, defaultCurrency, iqdPreference)}
                                </div>
                                <div className="mt-2 text-sm text-muted-foreground">
                                    {outstandingValue > 0
                                        ? `${t('orders.details.outstanding', { defaultValue: 'Outstanding' })}: ${formatCurrency(outstandingValue, defaultCurrency, iqdPreference)}`
                                        : t('orders.details.fullySettled', { defaultValue: 'Fully settled' })}
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 text-center">
                                <div className="rounded-2xl border border-border/40 bg-muted/20 p-5">
                                    <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                                        {completedLabel}
                                    </div>
                                    <div className="text-2xl font-bold text-emerald-500">{completedTransactions.length}</div>
                                </div>
                                <div className="rounded-2xl border border-border/40 bg-muted/20 p-5">
                                    <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                                        {paidLabel}
                                    </div>
                                    <div className="text-2xl font-bold text-blue-500">{settledTransactions.length}</div>
                                </div>
                            </div>

                            <div className="space-y-2 pt-2">
                                <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                                    <span>{t('businessPartners.settlementProgress', { defaultValue: 'Settlement Progress' })}</span>
                                    <span>{Math.round(settledPercent)}%</span>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-muted/40">
                                    <div
                                        className="h-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)] transition-all duration-500"
                                        style={{ width: `${settledPercent}%` }}
                                    />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t('orders.details.activity.title', { defaultValue: 'Activity' })}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {activityRows.length === 0 ? (
                                <div className="py-6 text-sm text-muted-foreground">
                                    {emptyRelatedLabel}
                                </div>
                            ) : (
                                <div className="relative space-y-6 ps-4 before:absolute before:bottom-2 before:start-0 before:top-2 before:w-0.5 before:bg-border/60">
                                    {activityRows.map((row) => (
                                        <div key={row.id} className="group relative">
                                            <div className="absolute -start-[1.375rem] top-1.5 h-3 w-3 rounded-full border-2 border-background bg-primary shadow-[0_0_8px_rgba(59,130,246,0.35)] transition-transform group-hover:scale-125" />
                                            <div className="space-y-0.5">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <div className="font-bold leading-none transition-colors group-hover:text-primary">{row.title}</div>
                                                    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', sourceBadgeClass(row.source))}>
                                                        {sourceLabel(row.source, t)}
                                                    </span>
                                                </div>
                                                <div className="pt-1 text-xs font-medium text-muted-foreground">
                                                    {row.statusLabel}
                                                </div>
                                                <div className="flex items-center gap-1.5 pt-1 text-xs font-medium text-muted-foreground">
                                                    <span>{formatDateTime(row.date)}</span>
                                                    <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                                                    <span className="font-bold text-foreground/80">
                                                        {formatCurrency(row.total, row.currency, iqdPreference)}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-4 lg:col-span-2">
                    <Card>
                        <CardHeader>
                            <CardTitle>{overviewTitle}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
                                <div className="rounded-3xl border border-border/50 bg-background/80 p-5 shadow-sm">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-primary">
                                            {typeLabel}
                                        </span>
                                        <span className="rounded-full border bg-muted/30 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                                            {defaultCurrency.toUpperCase()}
                                        </span>
                                    </div>
                                    <div className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                                        {t('businessPartners.relationshipValue', { defaultValue: 'Relationship Value' })}
                                    </div>
                                    <div className="mt-2 text-4xl font-black tracking-tight">
                                        {formatCurrency(totalValue, defaultCurrency, iqdPreference)}
                                    </div>
                                    <div className="mt-2 text-sm text-muted-foreground">
                                        {latestTransaction
                                            ? `${lastActivityLabel}: ${formatDate(latestTransaction.displayDate)}`
                                            : emptyRelatedLabel}
                                    </div>
                                    <div className="mt-6 space-y-2">
                                        <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                                            <span>{t('businessPartners.creditUsage', { defaultValue: 'Credit Usage' })}</span>
                                            <span>{Math.round(creditUsagePercent)}%</span>
                                        </div>
                                        <div className="h-2 overflow-hidden rounded-full bg-background/80">
                                            <div
                                                className={cn(
                                                    'h-full rounded-full transition-all duration-500',
                                                    creditUsagePercent >= 80 ? 'bg-rose-500' : creditUsagePercent >= 50 ? 'bg-amber-500' : 'bg-primary'
                                                )}
                                                style={{ width: `${creditUsagePercent}%` }}
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                                    <div className="rounded-2xl border bg-muted/20 p-4">
                                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                            <CreditCard className="h-4 w-4" />
                                            {t('customers.form.creditLimit', { defaultValue: 'Credit Limit' })}
                                        </div>
                                        <div className="mt-2 text-xl font-black">
                                            {formatCurrency(partner.creditLimit || 0, defaultCurrency, iqdPreference)}
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-muted/20 p-4">
                                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                            <Receipt className="h-4 w-4" />
                                            {t('orders.details.outstanding', { defaultValue: 'Outstanding' })}
                                        </div>
                                        <div className="mt-2 text-xl font-black">
                                            {formatCurrency(outstandingValue, defaultCurrency, iqdPreference)}
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-muted/20 p-4">
                                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                            <ShoppingCart className="h-4 w-4" />
                                            {t('businessPartners.averageDocument', { defaultValue: 'Average Document' })}
                                        </div>
                                        <div className="mt-2 text-xl font-black">
                                            {formatCurrency(averageOrderValue, defaultCurrency, iqdPreference)}
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-muted/20 p-4">
                                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                            <CalendarDays className="h-4 w-4" />
                                            {firstActivityLabel}
                                        </div>
                                        <div className="mt-2 text-xl font-black">
                                            {earliestTransaction ? formatDate(earliestTransaction.displayDate) : 'N/A'}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {t('businessPartners.receivable', { defaultValue: 'Receivable' })}
                                    </div>
                                    <div className="mt-2 text-2xl font-black text-emerald-600">
                                        {formatCurrency(partner.receivableBalance || 0, defaultCurrency, iqdPreference)}
                                    </div>
                                </div>
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {t('businessPartners.payable', { defaultValue: 'Payable' })}
                                    </div>
                                    <div className="mt-2 text-2xl font-black text-amber-600">
                                        {formatCurrency(partner.payableBalance || 0, defaultCurrency, iqdPreference)}
                                    </div>
                                </div>
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {t('businessPartners.loans', { defaultValue: 'Loans' })}
                                    </div>
                                    <div className="mt-2 text-2xl font-black text-sky-600">
                                        {formatCurrency(partner.loanOutstandingBalance || 0, defaultCurrency, iqdPreference)}
                                    </div>
                                </div>
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {t('businessPartners.netExposure', { defaultValue: 'Net Exposure' })}
                                    </div>
                                    <div className="mt-2 text-2xl font-black text-primary">
                                        {formatCurrency(partner.netExposure || 0, defaultCurrency, iqdPreference)}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {activeLabel}
                                    </div>
                                    <div className="mt-2 text-2xl font-black">{activeTransactions.length}</div>
                                </div>
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {completedLabel}
                                    </div>
                                    <div className="mt-2 text-2xl font-black">{completedTransactions.length}</div>
                                </div>
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {paidLabel}
                                    </div>
                                    <div className="mt-2 text-2xl font-black">{settledTransactions.length}</div>
                                </div>
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                        {t('orders.details.units', { defaultValue: 'Units' })}
                                    </div>
                                    <div className="mt-2 text-2xl font-black">{totalUnits}</div>
                                </div>
                            </div>

                            <div className="mt-6 rounded-2xl border bg-background/70 p-4">
                                <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                    <Package className="h-4 w-4" />
                                    {t('products.topProducts', { defaultValue: 'Top Products' })}
                                </div>
                                {topProducts.length === 0 ? (
                                    <div className="text-sm text-muted-foreground">
                                        {t('businessPartners.topProductsEmpty', { defaultValue: 'Product activity will appear once orders are added.' })}
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        {topProducts.map((product, index) => (
                                            <div key={product.id} className="flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-black text-primary">
                                                            {index + 1}
                                                        </span>
                                                        <span className="truncate font-semibold">{product.name}</span>
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {product.quantity} {t('orders.details.units', { defaultValue: 'Units' })}
                                                    </div>
                                                </div>
                                                <div className="text-right text-sm font-semibold">
                                                    {formatCurrency(product.amount, defaultCurrency, iqdPreference)}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <CardTitle>{listTitle}</CardTitle>
                            <div className="hidden items-center rounded-lg border bg-muted/30 p-1 md:flex">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setViewMode('table')}
                                    className={cn(
                                        'h-8 gap-1.5 px-3 text-[10px] font-black uppercase tracking-[0.16em]',
                                        viewMode === 'table' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground'
                                    )}
                                >
                                    <List className="h-3 w-3" />
                                    {t('common.table', { defaultValue: 'Table' })}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setViewMode('grid')}
                                    className={cn(
                                        'h-8 gap-1.5 px-3 text-[10px] font-black uppercase tracking-[0.16em]',
                                        viewMode === 'grid' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground'
                                    )}
                                >
                                    <LayoutGrid className="h-3 w-3" />
                                    {t('common.grid', { defaultValue: 'Grid' })}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {relatedTransactions.length === 0 ? (
                                <div className="rounded-2xl border py-12 text-center text-muted-foreground">
                                    {emptyRelatedLabel}
                                </div>
                            ) : viewMode === 'grid' ? (
                                <div className="grid gap-4 md:grid-cols-2">
                                    {sortedTransactions.map((transaction) => (
                                        <div key={transaction.id} className="rounded-3xl border bg-background/80 p-4 shadow-sm">
                                            <div className="flex items-start justify-between gap-3">
                                                <div>
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <div className="text-lg font-semibold">{transaction.reference}</div>
                                                        <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', sourceBadgeClass(transaction.source))}>
                                                            {sourceLabel(transaction.source, t)}
                                                        </span>
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">{formatDate(transaction.displayDate)}</div>
                                                </div>
                                                <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', statusBadgeClass(transaction.status))}>
                                                    {transaction.statusLabel}
                                                </span>
                                            </div>

                                            <div className="mt-4 rounded-2xl border bg-muted/20 p-3">
                                                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                                    {detailsColumnLabel}
                                                </div>
                                                <div className="mt-1 text-sm font-medium">{transaction.summary}</div>
                                            </div>

                                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                                <div className="rounded-2xl border bg-muted/20 p-3">
                                                    <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                                        {t('common.status', { defaultValue: 'Status' })}
                                                    </div>
                                                    <div className="mt-1">
                                                        <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', paymentBadgeClass(transaction.isPaid))}>
                                                            {transaction.isPaid
                                                                ? t('customers.details.paid', { defaultValue: 'Paid' })
                                                                : t('customers.details.unpaid', { defaultValue: 'Unpaid' })}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="rounded-2xl border bg-muted/20 p-3">
                                                    <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                                        {t('common.total', { defaultValue: 'Total' })}
                                                    </div>
                                                    <div className="mt-1 font-medium">{formatCurrency(transaction.total, transaction.currency, iqdPreference)}</div>
                                                </div>
                                            </div>

                                            <div className="mt-4">
                                                <Button variant="outline" className="w-full gap-2" onClick={() => navigate(transaction.viewHref)}>
                                                    <Eye className="h-4 w-4" />
                                                    {t('common.view', { defaultValue: 'View' })}
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="overflow-x-auto rounded-2xl border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('common.type', { defaultValue: 'Type' })}</TableHead>
                                                <TableHead>{referenceColumnLabel}</TableHead>
                                                <TableHead>{t('common.date', { defaultValue: 'Date' })}</TableHead>
                                                <TableHead>{t('common.status', { defaultValue: 'Status' })}</TableHead>
                                                <TableHead>{detailsColumnLabel}</TableHead>
                                                <TableHead>{t('pos.paymentMethod', { defaultValue: 'Payment' })}</TableHead>
                                                <TableHead className="text-end">{t('common.total', { defaultValue: 'Total' })}</TableHead>
                                                <TableHead className="text-end">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {sortedTransactions.map((transaction) => (
                                                <TableRow key={transaction.id}>
                                                    <TableCell>
                                                        <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', sourceBadgeClass(transaction.source))}>
                                                            {sourceLabel(transaction.source, t)}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell className="font-semibold">{transaction.reference}</TableCell>
                                                    <TableCell>{formatDate(transaction.displayDate)}</TableCell>
                                                    <TableCell>
                                                        <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', statusBadgeClass(transaction.status))}>
                                                            {transaction.statusLabel}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell>{transaction.summary}</TableCell>
                                                    <TableCell>
                                                        <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide', paymentBadgeClass(transaction.isPaid))}>
                                                            {transaction.isPaid
                                                                ? t('customers.details.paid', { defaultValue: 'Paid' })
                                                                : t('customers.details.unpaid', { defaultValue: 'Unpaid' })}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell className="text-end font-semibold">
                                                        {formatCurrency(transaction.total, transaction.currency, iqdPreference)}
                                                    </TableCell>
                                                    <TableCell className="text-end">
                                                        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate(transaction.viewHref)}>
                                                            <Eye className="h-4 w-4" />
                                                            {t('common.view', { defaultValue: 'View' })}
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}
