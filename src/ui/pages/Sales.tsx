import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { isSupabaseConfigured, useAuth } from '@/auth'
import { useDemoTutorial } from '@/demo'
import { supabase } from '@/auth/supabase'
import { Sale } from '@/types'
import { mapSaleToUniversal } from '@/lib/mappings'
import { clearPendingSaleDetailsId, readPendingSaleDetailsId } from '@/lib/saleNavigation'
import { formatCurrency, formatDateTime, formatCompactDateTime, formatDate, formatOriginLabel, formatSaleDetailsForWhatsApp, cn } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { getSalesHistoryRowTotal } from '@/lib/salesHistoryTotals'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { getLoanDetailsPath } from '@/lib/loanPresentation'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'

import { adjustInventoryQuantity, applySalesOrderReturnQuantities, appendPaymentTransaction, commitStockBatchAllocations, db, getActiveTravelBookingPayments, markPosLoanCancelledForFullSaleReturn, processSaleProductExchange, recordLoanPayment, resolveReturnStorageId, restoreStockBatchAllocations, splitStockBatchAllocationsForReturn, useLoanBySaleId, useLoanInstallments, useLoanPayments, useLoans, usePriceBookCatalogState, useProducts, useSales, useSalesOrderReturnItemsForWorkspace, useSalesOrders, useStorages, useInventory, useExchangeTransactions, usePaymentTransactions, useClinicalAppointments, useActivityTransactions, useActivityTransactionLinesForWorkspace, useWorkspaceUsers, useBusinessPartners, useDeliveryMerchantProfiles, useDeliveryShipments, useRentalContracts, useRentalVehicles, toUISale, toUISaleFromOrder, toUISaleFromExchangeTransaction, toUISaleFromRealEstateCommissionTransaction, toUISaleFromPaidClinicalAppointment, toUISaleFromActivityTransaction, toUISaleFromDeliveryShipment, toUISaleFromRentalContract, toUISaleFromTravelBookingPayment, type CurrencyCode, type Loan, type PaymentAccount, type SaleReturn as LocalSaleReturn, type SaleReturnItem as LocalSaleReturnItem, type StockBatchAllocation, type WorkspacePaymentMethod } from '@/local-db'
import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import { useWorkspace } from '@/workspace'
import { isMobile } from '@/lib/platform'
import { whatsappManager } from '@/lib/whatsappWebviewManager'
import { useDateRange } from '@/context/DateRangeContext'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { useTheme } from '@/ui/components/theme-provider'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Button,
    SaleDetailsModal,
    SaleReturnActionDialog,
    ProductExchangeModal,
    ProfileCardModal,
    ReturnConfirmationModal,
    ReturnDeclineModal,
    ReturnRulesDisplayModal,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    PrintPreviewModal,
    SalesNoteModal,
    ExportPreviewModal,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    useToast,
    AppPagination,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    Input,
    Label,
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    type ProductExchangeDraft,
    type ProductExchangeReplacementProduct,
    type ProductExchangeSaleItem,
} from '@/ui/components'
import { LoanDetailsPrintTemplate, LoanReceiptPrintTemplate } from '@/ui/components/loans/LoanPrintTemplates'
import { WhatsAppNumberInputModal } from '@/ui/components/modals/WhatsAppNumberInputModal'
import { SaleItem } from '@/types'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
import {
    SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
    SALES_HISTORY_A4_TEMPLATE_KEYS,
    SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY,
    SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
    buildCustomTemplateLayoutPdf,
    createCustomTemplatePreview,
    getCustomTemplatePrintLanguageWarning,
    getCustomTemplateTarget,
    getStoredCustomTemplateLabel,
    isCustomTemplatePrintLanguageCompatible,
    readCustomTemplateLayout,
    resolveCustomTemplatePrintLanguage,
    type StoredCustomTemplateRow
} from '@/lib/customTemplates'
import type { CustomTemplateLayout } from '@/lib/printPreviewEditorStore'
import type { OrderPrintVersion } from '@/lib/orderPrintReturnState'
import {
    Receipt,
    Eye,
    Loader2,
    Printer,
    RotateCcw,
    StickyNote,
    FileSpreadsheet,
    LayoutGrid,
    List,
    SlidersHorizontal,
    Search,
    ArrowUp,
    ArrowDown,
    ArrowUpDown,
    MessageCircle
} from 'lucide-react'

export type SalesSortOption = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc' | 'cashier_asc' | 'cashier_desc' | 'origin_asc' | 'origin_desc'

export interface SalesFilterState {
    search: string
    currency: string
    paymentMethod: string
    cashier: string
    origin: string
    minAmount: string
    maxAmount: string
    returnStatus: string
    productSku: string
    storage: string
    sort: SalesSortOption
}

export const DEFAULT_SALES_FILTERS: SalesFilterState = {
    search: '',
    currency: 'all',
    paymentMethod: 'all',
    cashier: 'all',
    origin: 'all',
    minAmount: '',
    maxAmount: '',
    returnStatus: 'all',
    productSku: '',
    storage: 'all',
    sort: 'date_desc'
}

function countActiveSalesFilters(filters: SalesFilterState) {
    return [
        !!filters.search.trim(),
        filters.currency !== 'all',
        filters.paymentMethod !== 'all',
        filters.cashier !== 'all',
        filters.origin !== 'all',
        !!filters.minAmount,
        !!filters.maxAmount,
        filters.returnStatus !== 'all',
        !!filters.productSku.trim(),
        filters.storage !== 'all',
        filters.sort !== 'date_desc'
    ].filter(Boolean).length
}

function getExternalSaleDetailsPath(sale: Sale) {
    if (sale.origin === 'sales_order') {
        return `/orders/${sale.id}`
    }
    if (sale.origin === 'exchange') {
        return '/currency-exchange'
    }
    if (sale.origin === 'real_estate') {
        return `/real-estate/${sale._realEstateTransactionId || sale.id}`
    }
    if (sale.origin === 'activities') {
        return `/activities?transaction=${sale._activityTransactionId || sale.id}`
    }
    if (sale.origin === 'clinical_appointment') {
        return `/clinical-appointments/${sale._clinicalAppointmentId || sale.id}/edit`
    }
    if (sale.origin === 'post_service') {
        return '/post-service'
    }
    if (sale.origin === 'car_rental') {
        return '/car-rental/contracts'
    }
    if (sale.origin === 'travel_transportation') {
        return `/travel-transportation/${sale._travelBookingId || sale.id}`
    }
    return null
}

function getSaleReferenceLabel(sale: Sale) {
    const transactionNo = (sale as Sale & { _transactionNo?: string | null })._transactionNo
    if (sale.origin === 'activities' && transactionNo) {
        return transactionNo
    }

    if (sale.origin === 'sales_order') {
        return (sale as Sale & { orderNumber?: string | null; _orderNumber?: string | null }).orderNumber
            || (sale as Sale & { _orderNumber?: string | null })._orderNumber
            || `#${sale.id.slice(0, 8)}`
    }

    if (sale.origin === 'post_service') {
        return (sale as Sale & { _trackingNumber?: string | null })._trackingNumber
            || String(sale.sequenceId || `PST-${sale.id.slice(0, 8)}`)
    }

    if (sale.origin === 'car_rental') {
        return (sale as Sale & { _rentalContractNo?: string | null })._rentalContractNo
            || String(sale.sequenceId || `RNT-${sale.id.slice(0, 8)}`)
    }
    if (sale.origin === 'travel_transportation') {
        return String(sale.sequenceId || `TT-${sale.id.slice(0, 8)}`)
    }

    return sale.sequenceId ? `#${String(sale.sequenceId).padStart(5, '0')}` : `#${sale.id.slice(0, 8)}`
}

type EffectiveLoanStatus = 'pending' | 'active' | 'overdue' | 'completed' | 'cancelled'

function resolveEffectiveLoanStatus(loan: Loan | undefined): EffectiveLoanStatus {
    if (!loan) return 'pending'
    if (loan.status === 'cancelled') return 'cancelled'
    if (loan.balanceAmount <= 0) return 'completed'
    const today = new Date().toISOString().slice(0, 10)
    if (loan.nextDueDate && loan.nextDueDate < today) return 'overdue'
    return 'active'
}

function getLoanStatusChipClass(status: EffectiveLoanStatus, neoStyle: boolean): string {
    const base = neoStyle ? "rounded-[var(--radius)]" : "rounded-full"
    if (status === 'cancelled') return `${base} bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/20`
    if (status === 'overdue') return `${base} bg-destructive/10 text-destructive border border-destructive/20`
    if (status === 'completed') return `${base} bg-blue-500/10 text-blue-600 dark:text-blue-300 border border-blue-500/20`
    if (status === 'active') return `${base} bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20`
    return `${base} bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/20`
}

function getLoanStatusLabelKey(status: EffectiveLoanStatus): string {
    if (status === 'active') return 'sales.loanActive'
    if (status === 'overdue') return 'sales.loanOverdue'
    if (status === 'completed') return 'sales.loanCompleted'
    if (status === 'cancelled') return 'sales.loanCancelled'
    return 'sales.loanPending'
}

function getLoanStatusFallbackLabel(status: EffectiveLoanStatus): string {
    if (status === 'active') return 'Loan Active'
    if (status === 'overdue') return 'Loan Overdue'
    if (status === 'completed') return 'Loan Completed'
    if (status === 'cancelled') return 'Loan Cancelled'
    return 'Loan Pending'
}

function getSaleReturnState(sale: Sale) {
    const items = sale.items || []
    const returnedItemsCount = items.filter((item) => item.is_returned).length
    const partialReturnedItemsCount = items.filter((item) => (item.returned_quantity || 0) > 0 && !item.is_returned).length
    const totalReturnedQuantity = items.reduce((sum, item) => {
        if (item.is_returned) return sum + (item.quantity || 0)
        return sum + Math.max(0, Number(item.returned_quantity || 0))
    }, 0)
    const isFullyReturned = !!sale.is_returned
        || sale.return_status === 'full'
        || (items.length > 0 && items.every((item) => item.is_returned || (item.returned_quantity || 0) >= item.quantity))
    const hasAnyReturn = isFullyReturned
        || !!sale.has_partial_return
        || sale.return_status === 'partial'
        || returnedItemsCount > 0
        || partialReturnedItemsCount > 0

    return { isFullyReturned, hasAnyReturn, totalReturnedQuantity }
}

function saleHasAnyReturnActivity(sale: Sale): boolean {
    return getSaleReturnState(sale).hasAnyReturn
}

export function Sales() {
    const { user } = useAuth()
    const { t, i18n } = useTranslation()
    const [, setLocation] = useLocation()
    const { features, workspaceName, activeWorkspace, isLocalMode, isHybridMode, hasCapability } = useWorkspace()
    const { style } = useTheme()
    const { toast } = useToast()
    const { dateRange, customDates } = useDateRange()
    const demoTutorial = useDemoTutorial()
    const tutorialSaleId = demoTutorial.state?.saleId

    const dateBounds = useMemo<{ startDate?: string; endDate?: string }>(() => {
        const { start, end } = getDateRangeBounds(dateRange, customDates)
        return {
            startDate: start?.toISOString(),
            endDate: end ? new Date(end.getTime() - 1).toISOString() : undefined
        }
    }, [dateRange, customDates])

    const rawSales = useSales(user?.workspaceId, dateBounds.startDate, dateBounds.endDate)
    const rawOrders = useSalesOrders(user?.workspaceId, dateBounds.startDate, dateBounds.endDate)
    const salesOrderReturnItems = useSalesOrderReturnItemsForWorkspace(user?.workspaceId)
    const deliveryShipments = useDeliveryShipments(user?.workspaceId)
    const deliveryMerchantProfiles = useDeliveryMerchantProfiles(user?.workspaceId)
    const deliveryBusinessPartners = useBusinessPartners(user?.workspaceId)
    const rentalVehicles = useRentalVehicles(user?.workspaceId)
    const rentalContracts = useRentalContracts(user?.workspaceId)
    const rawExchangeTransactions = useExchangeTransactions(user?.workspaceId)
    const products = useProducts(user?.workspaceId)
    const productImageUrls = useMemo(() => products.reduce<Record<string, string>>((imageUrls, product) => {
        const imageUrl = product.imageUrl?.trim()
        if (imageUrl) imageUrls[product.id] = imageUrl
        return imageUrls
    }, {}), [products])
    const storages = useStorages(user?.workspaceId)
    const inventory = useInventory(user?.workspaceId)
    const realEstateCommissionTransactions = usePaymentTransactions(user?.workspaceId, {
        direction: 'incoming',
        sourceModule: 'real_estate',
        sourceType: 'real_estate_commission',
        includeReversals: false
    }, { hydrateSourceTables: false })
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
    const workspaceUsers = useWorkspaceUsers(user?.workspaceId)
    const cashierNameById = useMemo(
        () => new Map(workspaceUsers.map((member) => [member.id, member.name || member.email || 'Staff'] as const)),
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
    const loans = useLoans(user?.workspaceId)
    const allSales = useMemo(() => {
        const sales = (rawSales || []).map(toUISale)
        const orders = applySalesOrderReturnQuantities(rawOrders || [], salesOrderReturnItems)
            .filter(order => !order.isDeleted && order.status === 'completed')
            .map(toUISaleFromOrder)
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
                transaction.createdBy ? cashierNameById.get(transaction.createdBy) : undefined
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
        return [...sales, ...orders, ...exchangeSales, ...realEstateCommissionSales, ...travelBookingProfitSales, ...clinicalSales, ...activitySales, ...deliverySales, ...rentalSales]
    }, [rawSales, rawOrders, salesOrderReturnItems, rawExchangeTransactions, realEstateCommissionTransactions, travelBookingPayments, clinicalAppointments, clinicalAppointmentTransactions, activityTransactions, activityTransactionLines, cashierNameById, dateBounds.endDate, dateBounds.startDate, deliveryMerchantBusinessPartnerIdByProfileId, deliveryMerchantNameByProfileId, deliveryShipments, rentalContracts, rentalVehicleById, t])

    const isLoading = rawSales === undefined || rawOrders === undefined || rawExchangeTransactions === undefined || realEstateCommissionTransactions === undefined || clinicalAppointments === undefined
    const [isDateLoading, setIsDateLoading] = useState(false)
    const prevDateBoundsRef = useRef(dateBounds)

    const [selectedSale, setSelectedSale] = useState<Sale | null>(null)
    const [printingSale, setPrintingSale] = useState<Sale | null>(null)
    const [returnModalOpen, setReturnModalOpen] = useState(false)
    const [saleToReturn, setSaleToReturn] = useState<Sale | null>(null)
    const [returnPaymentAccount, setReturnPaymentAccount] = useState<PaymentAccount | null>(null)
    const [saleForReturnAction, setSaleForReturnAction] = useState<Sale | null>(null)
    const [saleForProductExchange, setSaleForProductExchange] = useState<Sale | null>(null)
    const [lockedProductExchangeSaleItemId, setLockedProductExchangeSaleItemId] = useState<string | null>(null)
    const [isSubmittingProductExchange, setIsSubmittingProductExchange] = useState(false)
    const [filters, setFilters] = useState<SalesFilterState>(() => {
        const cachedCashier = localStorage.getItem('sales_selected_cashier') || 'all'
        return { ...DEFAULT_SALES_FILTERS, cashier: cachedCashier }
    })
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
    const [draftFilters, setDraftFilters] = useState<SalesFilterState>(filters)
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(() => {
        return Number(localStorage.getItem('sales_page_size')) || 20
    })

    const productExchangeSaleItems = useMemo<ProductExchangeSaleItem[]>(() => {
        if (saleForProductExchange?.origin !== 'pos') {
            return []
        }

        const isFlaggedSale = saleForProductExchange.system_review_status === 'flagged'
        return (saleForProductExchange.items || []).flatMap((item) => {
            const returnableQuantity = Math.max(
                0,
                Number(item.quantity || 0) - Math.max(0, Number(item.returned_quantity || 0)),
            )
            const canReturn = isFlaggedSale
                || !item.product
                || (item.product.can_be_returned !== false && item.product.is_deleted !== true)

            if (!item.id || !item.product_id || returnableQuantity <= 0 || !canReturn) {
                return []
            }

            return [{
                id: item.id,
                productId: item.product_id,
                name: item.product?.name || item.product_name || t('common.unknownProduct', { defaultValue: 'Unknown product' }),
                sku: item.product?.sku || item.product_sku || null,
                unit: item.product?.unit || null,
                returnableQuantity,
                unitPrice: Number(item.converted_unit_price ?? item.unit_price ?? 0),
                priceBookId: item.price_book_id ?? null,
            }]
        })
    }, [saleForProductExchange, t])

    const productExchangeReplacementProducts = useMemo<ProductExchangeReplacementProduct[]>(() => {
        const settlementCurrency = saleForProductExchange?.settlement_currency?.toLowerCase()
        if (!settlementCurrency) {
            return []
        }

        const productsById = new Map(products.map((product) => [product.id, product]))
        return inventory.flatMap((inventoryItem) => {
            const product = productsById.get(inventoryItem.productId)
            const availableQuantity = Number(inventoryItem.quantity || 0)
            if (
                !product
                || product.isDeleted
                || availableQuantity <= 0
                || product.currency.toLowerCase() !== settlementCurrency
            ) {
                return []
            }

            return [{
                id: product.id,
                storageId: inventoryItem.storageId,
                name: product.name,
                sku: product.sku || null,
                unit: product.unit || null,
                unitPrice: Number(product.price || 0),
                currency: product.currency,
                replacementUnitAmount: Number(product.price || 0),
                availableQuantity,
            }]
        })
    }, [inventory, products, saleForProductExchange?.settlement_currency])

    const priceBookCatalog = usePriceBookCatalogState(user?.workspaceId, { enabled: !!user?.workspaceId })
    const priceBookReplacementAmountByKey = useMemo(() => {
        const map = new Map<string, { price: number; currency: string }>()
        for (const priceBookItem of priceBookCatalog.priceBookItems) {
            if (priceBookItem.isDeleted) {
                continue
            }
            map.set(`${priceBookItem.priceBookId}:${priceBookItem.productId}`, {
                price: priceBookItem.price,
                currency: priceBookItem.currency
            })
        }
        return map
    }, [priceBookCatalog.priceBookItems])
    const resolvePriceBookReplacementAmount = useCallback((priceBookId: string, productId: string) => {
        const entry = priceBookReplacementAmountByKey.get(`${priceBookId}:${productId}`)
        if (!entry) {
            return null
        }
        const settlementCurrency = saleForProductExchange?.settlement_currency?.toLowerCase()
        if (!settlementCurrency || entry.currency.toLowerCase() !== settlementCurrency) {
            return null
        }
        return entry.price
    }, [priceBookReplacementAmountByKey, saleForProductExchange?.settlement_currency])

    useEffect(() => {
        localStorage.setItem('sales_page_size', String(pageSize))
    }, [pageSize])

    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('sales_view_mode') as 'table' | 'grid') || 'table'
    })

    const [saleForWhatsApp, setSaleForWhatsApp] = useState<Sale | null>(null)
    const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)

    const handleShareOnWhatsApp = (phone: string, dialogLanguage: string) => {
        if (!saleForWhatsApp) return
        const translator = i18n.getFixedT(dialogLanguage)
        const text = formatSaleDetailsForWhatsApp(saleForWhatsApp, translator)
        void whatsappManager.openChat(phone, text).catch((error) => {
            console.error('[Sales] Failed to open WhatsApp chat:', error)
        })
        setLocation('/whatsapp')
        setSaleForWhatsApp(null)
    }

    useEffect(() => {
        localStorage.setItem('sales_view_mode', viewMode)
    }, [viewMode])

    useEffect(() => {
        const pendingSaleId = readPendingSaleDetailsId()
        if (!pendingSaleId) {
            return
        }

        const saleToOpen = allSales.find((sale) => sale.id === pendingSaleId)
        if (!saleToOpen) {
            return
        }

        setSelectedSale(saleToOpen)
        clearPendingSaleDetailsId()
    }, [allSales])

    const { effectiveFilters, currencyOptions, paymentMethodOptions, originOptions } = useMemo(() => {
        const currOpts = Array.from(new Set(allSales.map((sale) => sale.settlement_currency || (sale as any).settlementCurrency).filter(Boolean)))
        const pMethodOpts = Array.from(new Set(allSales.map((sale) => String(sale.payment_method || (sale as any).paymentMethod || (sale as any).paymentType || 'unknown')).filter(value => !!value && value !== 'unknown')))
        const originOpts = Array.from(new Set(allSales.map((sale) => sale.origin).filter(Boolean)))
        return {
            effectiveFilters: filters,
            currencyOptions: currOpts,
            paymentMethodOptions: pMethodOpts,
            originOptions: originOpts
        }
    }, [filters, allSales])

    // Client-side filtering: date range + filters
    const filteredSales = useMemo(() => {
        let result = allSales
        const { start, end } = getDateRangeBounds(dateRange, customDates)
        if (start || end) {
            result = result.filter((sale) => {
                const date = new Date(sale.created_at)
                if (start && date < start) return false
                if (end && date >= end) return false
                return true
            })
        }

        const normalizedSearch = effectiveFilters.search.trim().toLowerCase()
        const minAmount = effectiveFilters.minAmount ? Number(effectiveFilters.minAmount) : null
        const maxAmount = effectiveFilters.maxAmount ? Number(effectiveFilters.maxAmount) : null

        result = result.filter(s => {
            if (effectiveFilters.cashier !== 'all' && s.cashier_id !== effectiveFilters.cashier) {
                return false
            }
            if (effectiveFilters.currency !== 'all' && s.settlement_currency !== effectiveFilters.currency && (s as any).settlementCurrency !== effectiveFilters.currency) {
                return false
            }
            if (effectiveFilters.origin !== 'all' && s.origin !== effectiveFilters.origin) {
                return false
            }
            const pMethod = String(s.payment_method || (s as any).paymentMethod || (s as any).paymentType || 'unknown').toLowerCase()
            const eMethod = effectiveFilters.paymentMethod.toLowerCase()
            if (effectiveFilters.paymentMethod !== 'all' && pMethod !== eMethod) {
                return false
            }

            if (effectiveFilters.returnStatus !== 'all') {
                const hasReturn = saleHasAnyReturnActivity(s)
                if (effectiveFilters.returnStatus === 'returned' && !hasReturn) return false
                if (effectiveFilters.returnStatus === 'non-returned' && hasReturn) return false
            }

            const total = s.total_amount || 0
            if (minAmount !== null && Number.isFinite(minAmount) && total < minAmount) {
                return false
            }
            if (maxAmount !== null && Number.isFinite(maxAmount) && total > maxAmount) {
                return false
            }

            const normalizedSku = effectiveFilters.productSku.trim().toLowerCase()
            if (normalizedSku) {
                const hasMatchingSku = (s.items || []).some((item: SaleItem) => {
                    const itemSku = item.product_sku || item.product?.sku || ''
                    return itemSku.toLowerCase().includes(normalizedSku)
                })
                if (!hasMatchingSku) return false
            }

            if (effectiveFilters.storage !== 'all' && !(s.items || []).some((item: SaleItem) => item.storage_id === effectiveFilters.storage)) {
                return false
            }

            if (!normalizedSearch) {
                return true
            }

            const searchString = [
                s.id,
                (s as any).invoice_number,
                s.cashier_name,
                s.customer_name,
                s.notes
            ].filter(Boolean).join(' ').toLowerCase()

            return searchString.includes(normalizedSearch)
        })

        // Sort
        result.sort((a, b) => {
            if (effectiveFilters.sort === 'amount_desc') return b.total_amount - a.total_amount
            if (effectiveFilters.sort === 'amount_asc') return a.total_amount - b.total_amount
            if (effectiveFilters.sort === 'cashier_asc') return (a.cashier_name || '').localeCompare(b.cashier_name || '')
            if (effectiveFilters.sort === 'cashier_desc') return (b.cashier_name || '').localeCompare(a.cashier_name || '')
            if (effectiveFilters.sort === 'origin_asc') return (a.origin || '').localeCompare(b.origin || '')
            if (effectiveFilters.sort === 'origin_desc') return (b.origin || '').localeCompare(a.origin || '')
            if (effectiveFilters.sort === 'date_asc') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        })

        return result
    }, [allSales, dateRange, customDates, effectiveFilters])

    useEffect(() => {
        const prev = prevDateBoundsRef.current
        prevDateBoundsRef.current = dateBounds
        if (dateRange !== 'allTime' && (prev.startDate !== dateBounds.startDate || prev.endDate !== dateBounds.endDate)) {
            setIsDateLoading(true)
        }
    }, [dateBounds, dateRange])

    useEffect(() => {
        if (isDateLoading && !isLoading && filteredSales.length > 0) {
            setIsDateLoading(false)
        }
    }, [isDateLoading, isLoading, filteredSales])

    useEffect(() => {
        setCurrentPage(1)
    }, [dateRange, customDates, filters])

    useEffect(() => {
        if (!isFilterDialogOpen) {
            return
        }
        setDraftFilters(filters)
    }, [filters, isFilterDialogOpen])

    const activeFilterCount = countActiveSalesFilters(filters)

    const handleApplyFilters = () => {
        setFilters(draftFilters)
        setIsFilterDialogOpen(false)
        setCurrentPage(1)
    }

    const totalCount = filteredSales.length

    // Client-side pagination
    const sales = useMemo(() => {
        const from = (currentPage - 1) * pageSize
        return filteredSales.slice(from, from + pageSize)
    }, [filteredSales, currentPage, pageSize])

    // Derive available cashiers from local data
    const availableCashiers = useMemo(() => {
        const map = new Map<string, string>()
        allSales.forEach(s => {
            if (s.cashier_id && s.cashier_name && s.cashier_name !== 'Staff') {
                map.set(s.cashier_id, s.cashier_name)
            }
        })
        return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
    }, [allSales])

    const loanBySaleId = useMemo(() => {
        const map = new Map<string, Loan>()
        for (const loan of loans) {
            if (!loan.saleId || loan.isDeleted) continue
            const existing = map.get(loan.saleId)
            if (!existing || new Date(loan.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
                map.set(loan.saleId, loan)
            }
        }
        return map
    }, [loans])

    const getLoanIndicator = (sale: Sale) => {
        if (sale.payment_method !== 'loan') return null
        const loan = loanBySaleId.get(sale.id)
        const status = resolveEffectiveLoanStatus(loan)
        const label = t(getLoanStatusLabelKey(status)) || getLoanStatusFallbackLabel(status)
        const statusLabel = t('sales.loanStatus') || 'Loan Status'
        const balanceLabel = t('sales.loanBalance') || 'Balance'
        const nextDueLabel = t('sales.loanNextDue') || 'Next Due'
        const pendingMessage = t('sales.loanPendingMessage') || 'Loan record pending sync/link'
        const balanceValue = loan
            ? formatCurrency(loan.balanceAmount, loan.settlementCurrency, features.iqd_display_preference)
            : '-'
        const nextDueValue = loan?.nextDueDate ? formatDate(loan.nextDueDate) : '-'
        const tooltipText = loan
            ? `${statusLabel}: ${label} | ${balanceLabel}: ${balanceValue} | ${nextDueLabel}: ${nextDueValue}`
            : pendingMessage

        return { loan, status, label, tooltipText }
    }

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
            if (filteredSales && filteredSales.length > 0) {
                const dates = filteredSales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            if (customDates.start || customDates.end) {
                const parts = []
                if (customDates.start) parts.push(`${t('performance.filters.from')} ${formatDate(customDates.start)}`)
                if (customDates.end) parts.push(`${t('performance.filters.to')} ${formatDate(customDates.end)}`)
                return parts.join(' ')
            }
        }
        if (dateRange === 'allTime') {
            if (filteredSales && filteredSales.length > 0) {
                const dates = filteredSales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            return t('performance.filters.allTime') || 'All Time'
        }
        return ''
    }

    const [rulesQueue, setRulesQueue] = useState<Array<{ productName: string; rules: string }>>([])
    const [currentRuleIndex, setCurrentRuleIndex] = useState(-1)
    const [showDeclineModal, setShowDeclineModal] = useState(false)
    const [nonReturnableProducts, setNonReturnableProducts] = useState<{ name: string; isDeleted: boolean }[]>([])
    const [filteredReturnItems, setFilteredReturnItems] = useState<SaleItem[]>([])
    const [printFormat, setPrintFormat] = useState<'receipt' | 'a4'>(() => {
        return (localStorage.getItem('sales_print_format') as 'receipt' | 'a4') || 'receipt'
    })
    const [a4Variant, setA4Variant] = useState<'standard' | 'refund'>('standard')
    const [salesHistoryPrintVersion, setSalesHistoryPrintVersion] = useState<OrderPrintVersion>('adjusted')
    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const currentTemplatePrintLanguage = resolveCustomTemplatePrintLanguage(printLang)
    const loanForPrint = useLoanBySaleId(printingSale?.id, user?.workspaceId)
    const loanPrintInstallments = useLoanInstallments(loanForPrint?.id, user?.workspaceId)
    const loanPrintPayments = useLoanPayments(loanForPrint?.id, user?.workspaceId)
    const shouldUseLoanPrint = printingSale?.payment_method === 'loan'
    const buildLoanQrValue = useCallback((effectiveId: string, format: PrintFormat) => {
        if (!features.print_qr || !user?.workspaceId || isLocalMode) return undefined
        const folder = format === 'receipt' ? 'receipts' : 'A4'
        return `https://asaas-r2-proxy.alanepic360.workers.dev/${user.workspaceId}/printed-invoices/${folder}/${effectiveId}.pdf`
    }, [features.print_qr, isLocalMode, user?.workspaceId])

    const renderLoanPrintTemplate = useCallback((effectiveId?: string) => {
        if (!loanForPrint) return null
        return (
            <LoanDetailsPrintTemplate
                workspaceName={workspaceName}
                printLang={printLang}
                loan={loanForPrint}
                installments={loanPrintInstallments}
                payments={loanPrintPayments}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
                qrValue={effectiveId ? buildLoanQrValue(effectiveId, 'a4') : undefined}
            />
        )
    }, [
        buildLoanQrValue,
        features.iqd_display_preference,
        features.logo_url,
        loanForPrint,
        loanPrintInstallments,
        loanPrintPayments,
        printLang,
        workspaceName
    ])

    const renderLoanReceiptTemplate = useCallback((effectiveId?: string) => {
        if (!loanForPrint) return null
        return (
            <LoanReceiptPrintTemplate
                workspaceName={workspaceName}
                printLang={printLang}
                loan={loanForPrint}
                installments={loanPrintInstallments}
                payments={loanPrintPayments}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
                qrValue={effectiveId ? buildLoanQrValue(effectiveId, 'receipt') : undefined}
            />
        )
    }, [
        buildLoanQrValue,
        features.iqd_display_preference,
        features.logo_url,
        loanForPrint,
        loanPrintInstallments,
        loanPrintPayments,
        printLang,
        workspaceName
    ])

    const buildLoanPrintPdf = useCallback(async ({ format, effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        const loanTemplate = format === 'receipt'
            ? renderLoanReceiptTemplate(effectiveId)
            : renderLoanPrintTemplate(effectiveId)
        if (!loanTemplate) {
            throw new Error('Loan data not ready')
        }
        return generateTemplatePdf({
            element: loanTemplate,
            format,
            printLang,
        })
    }, [printLang, renderLoanPrintTemplate, renderLoanReceiptTemplate])


    useEffect(() => {
        localStorage.setItem('sales_selected_cashier', filters.cashier)
    }, [filters.cashier])

    useEffect(() => {
        localStorage.setItem('sales_print_format', printFormat)
    }, [printFormat])
    const [saleToPrintSelection, setSaleToPrintSelection] = useState<Sale | null>(null)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const [customReceiptTemplates, setCustomReceiptTemplates] = useState<StoredCustomTemplateRow[]>([])
    const [selectedCustomReceiptTemplate, setSelectedCustomReceiptTemplate] = useState<StoredCustomTemplateRow | null>(null)
    const [customA4Templates, setCustomA4Templates] = useState<StoredCustomTemplateRow[]>([])
    const [selectedCustomA4Template, setSelectedCustomA4Template] = useState<StoredCustomTemplateRow | null>(null)
    const [selectedNativeA4TemplateKey, setSelectedNativeA4TemplateKey] = useState<
        typeof SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY | typeof SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY | null
    >(null)
    const [isNoteModalOpen, setIsNoteModalOpen] = useState(false)
    const [selectedSaleForNote, setSelectedSaleForNote] = useState<Sale | null>(null)
    const [isExportModalOpen, setIsExportModalOpen] = useState(false)
    const [profileCardOpen, setProfileCardOpen] = useState(false)
    const [profileCardUserId, setProfileCardUserId] = useState<string | null>(null)



    useEffect(() => {
        if (!showPrintPreview || !user?.workspaceId || (!isLocalMode && !isSupabaseConfigured)) {
            setCustomReceiptTemplates([])
            setCustomA4Templates([])
            return
        }

        let cancelled = false
        void (async () => {
            try {
                const [receiptTemplates, a4TemplateGroups] = await Promise.all([
                    fetchCachedCustomTemplates(user.workspaceId, {
                        moduleTypeKey: SALES_HISTORY_RECEIPT_TEMPLATE_KEY,
                        activeOnly: true
                    }),
                    Promise.all(SALES_HISTORY_A4_TEMPLATE_KEYS.map((moduleTypeKey) =>
                        fetchCachedCustomTemplates(user.workspaceId, {
                            moduleTypeKey,
                            activeOnly: true
                        })
                    ))
                ])
                if (!cancelled) {
                    setCustomReceiptTemplates(receiptTemplates as StoredCustomTemplateRow[])
                    setCustomA4Templates(a4TemplateGroups.flat() as StoredCustomTemplateRow[])
                }
            } catch (templateError) {
                console.error('[Sales] Failed to load custom templates:', templateError)
                if (!cancelled) {
                    setCustomReceiptTemplates([])
                    setCustomA4Templates([])
                }
            }
        })()

        return () => {
            cancelled = true
        }
    }, [isHybridMode, isLocalMode, showPrintPreview, user?.workspaceId])

    const onPrintClick = (sale: Sale) => {
        setSelectedCustomReceiptTemplate(null)
        setSelectedCustomA4Template(null)
        setSelectedNativeA4TemplateKey(null)
        setSalesHistoryPrintVersion('adjusted')
        setSaleToPrintSelection(sale)
        setPrintingSale(sale)
        setShowPrintPreview(true)
    }

    const handlePrintSelection = (
        format: PrintFormat,
        template?: StoredCustomTemplateRow,
        nativeTemplateKey?: string,
        printVersion: OrderPrintVersion = 'adjusted'
    ) => {
        if (template && !isCustomTemplatePrintLanguageCompatible(template, currentTemplatePrintLanguage)) {
            return
        }
        // Sales invoices support only the two persisted invoice formats.
        if (format === 'barcode_35x15') return
        setPrintFormat(format)
        setSelectedCustomReceiptTemplate(format === 'receipt' ? template || null : null)
        setSelectedCustomA4Template(format === 'a4' ? template || null : null)
        const selectedNativeA4Key = nativeTemplateKey === SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY
            ? SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY
            : nativeTemplateKey === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
                ? SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
                : null
        const isAtlasStandardNative = selectedNativeA4Key !== null
        const selectedTemplateIsReturn = template?.module_type_key === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
        setSelectedNativeA4TemplateKey(format === 'a4' ? selectedNativeA4Key : null)
        const resolvedPrintVersion = selectedNativeA4Key === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY || selectedTemplateIsReturn
            ? 'returned'
            : printVersion === 'returned' ? 'adjusted' : printVersion
        setSalesHistoryPrintVersion(resolvedPrintVersion)
        if (format === 'a4' && (nativeTemplateKey === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
            || selectedTemplateIsReturn
            || (saleToPrintSelection && saleHasAnyReturnActivity(saleToPrintSelection) && !isAtlasStandardNative))) {
            setA4Variant('refund')
        } else {
            setA4Variant('standard')
        }
    }
    const salesPrintSelectionOptions = useMemo(() => {
        const hasReturnActivity = Boolean(saleToPrintSelection && saleHasAnyReturnActivity(saleToPrintSelection))
        return [{
            format: 'receipt' as const,
            label: t('sales.print.receipt', { defaultValue: 'Thermal Receipt' }),
            description: t('sales.print.receiptdesc', { defaultValue: 'Thermal receipt document' })
        }, {
            format: 'a4' as const,
            label: hasReturnActivity
                ? t('sales.print.a4Refund', { defaultValue: 'A4 Refund Invoice' })
                : t('sales.print.a4', { defaultValue: 'A4 Invoice' }),
            description: hasReturnActivity
                ? t('sales.print.a4RefundDesc', { defaultValue: 'Refund-focused full-page A4' })
                : t('sales.print.a4desc', { defaultValue: 'Detailed full-page document' }),
            returnsReflected: hasReturnActivity
        }, {
            format: 'a4' as const,
            nativeTemplateKey: SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY,
            label: t('sales.print.atlasStandard', { defaultValue: 'Sales History Atlas Standard' }),
            description: t('sales.print.atlasStandardDescription', { defaultValue: 'Atlas Standard detailed A4 sales document.' }),
            returnsReflected: hasReturnActivity
        }, ...(hasReturnActivity ? [{
            format: 'a4' as const,
            nativeTemplateKey: SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
            returned: true,
            label: t('sales.print.atlasStandardReturn', { defaultValue: 'Sales History Atlas Standard Return' }),
            description: t('sales.print.atlasStandardReturnDescription', { defaultValue: 'Atlas Standard A4 document for returned items and refund amounts.' })
        }] : [])]
    }, [saleToPrintSelection, t])
    const salesCustomPrintOptions = useMemo(
        () => [
            ...customReceiptTemplates.map((template) => ({
                format: 'receipt' as const,
                template,
                label: getStoredCustomTemplateLabel(template),
                description: t('customTemplates.customReceipt', { defaultValue: 'Custom Receipt' }),
                primary: template.primary,
                disabled: !isCustomTemplatePrintLanguageCompatible(template, currentTemplatePrintLanguage),
                warning: getCustomTemplatePrintLanguageWarning(template, currentTemplatePrintLanguage, t)
            })),
            ...customA4Templates
                .filter((template) => template.module_type_key !== SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
                    || Boolean(saleToPrintSelection && saleHasAnyReturnActivity(saleToPrintSelection)))
                .map((template) => ({
                format: 'a4' as const,
                template,
                label: getStoredCustomTemplateLabel(template),
                description: t('customTemplates.customA4', { defaultValue: 'Custom A4' }),
                primary: template.primary,
                returned: template.module_type_key === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
                returnsReflected: Boolean(saleToPrintSelection && saleHasAnyReturnActivity(saleToPrintSelection))
                    && template.module_type_key !== SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY,
                disabled: !isCustomTemplatePrintLanguageCompatible(template, currentTemplatePrintLanguage),
                warning: getCustomTemplatePrintLanguageWarning(template, currentTemplatePrintLanguage, t)
            }))
        ],
        [currentTemplatePrintLanguage, customReceiptTemplates, customA4Templates, saleToPrintSelection, t]
    )

    const handleConfirmPrint = () => {
        // PrintPreviewModal handles PDF rendering/printing internally
        setShowPrintPreview(false)
        setPrintingSale(null)
        setSaleToPrintSelection(null)
        setA4Variant('standard')
        setSalesHistoryPrintVersion('adjusted')
        setSelectedCustomReceiptTemplate(null)
        setSelectedCustomA4Template(null)
        setSelectedNativeA4TemplateKey(null)
    }

    const customReceiptTarget = useMemo(
        () => getCustomTemplateTarget(SALES_HISTORY_RECEIPT_TEMPLATE_KEY),
        []
    )
    const selectedCustomReceiptLayout = useMemo(
        () => selectedCustomReceiptTemplate
            && isCustomTemplatePrintLanguageCompatible(selectedCustomReceiptTemplate, currentTemplatePrintLanguage)
            ? readCustomTemplateLayout(selectedCustomReceiptTemplate)
            : null,
        [currentTemplatePrintLanguage, selectedCustomReceiptTemplate]
    )
    const hasCompatibleSelectedCustomReceipt = Boolean(
        selectedCustomReceiptTemplate && selectedCustomReceiptLayout
    )
    const customReceiptData = useMemo(
        () => printingSale ? mapSaleToUniversal(printingSale, { a4Variant: 'standard' }) : undefined,
        [printingSale]
    )
    const customReceiptPreview = useMemo(
        () => customReceiptTarget && customReceiptData
            ? createCustomTemplatePreview(customReceiptTarget, {
                workspaceId: user?.workspaceId,
                workspaceName,
                features,
                receiptData: customReceiptData,
                productImageUrls
            })
            : undefined,
        [customReceiptData, customReceiptTarget, features, productImageUrls, user?.workspaceId, workspaceName]
    )
    const buildCustomReceiptPdf = useCallback(async ({ effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        if (!customReceiptTarget || !selectedCustomReceiptLayout || !customReceiptData) {
            throw new Error('Custom receipt template is not available.')
        }

        return buildCustomTemplateLayoutPdf({
            target: customReceiptTarget,
            layout: selectedCustomReceiptLayout,
            values: {},
            options: {
                workspaceId: user?.workspaceId,
                workspaceName,
                features,
                receiptData: customReceiptData,
                productImageUrls
            },
            effectiveId
        })
    }, [customReceiptData, customReceiptTarget, features, productImageUrls, selectedCustomReceiptLayout, user?.workspaceId, workspaceName])
    const buildEditableCustomReceiptPdf = useCallback(async (
        layout: CustomTemplateLayout,
        _printLangOverride?: string,
        effectiveId?: string
    ) => {
        if (!customReceiptTarget || !customReceiptData) {
            throw new Error('Custom receipt template is not available.')
        }

        return buildCustomTemplateLayoutPdf({
            target: customReceiptTarget,
            layout,
            values: {},
            options: {
                workspaceId: user?.workspaceId,
                workspaceName,
                features,
                receiptData: customReceiptData,
                productImageUrls
            },
            effectiveId,
            fieldMode: 'layoutOverrides'
        })
    }, [customReceiptData, customReceiptTarget, features, productImageUrls, user?.workspaceId, workspaceName])

    const customA4Target = useMemo(
        () => selectedCustomA4Template
            ? getCustomTemplateTarget(selectedCustomA4Template.module_type_key)
            : undefined,
        [selectedCustomA4Template]
    )
    const selectedCustomA4Layout = useMemo(
        () => selectedCustomA4Template
            && isCustomTemplatePrintLanguageCompatible(selectedCustomA4Template, currentTemplatePrintLanguage)
            ? readCustomTemplateLayout(selectedCustomA4Template)
            : null,
        [currentTemplatePrintLanguage, selectedCustomA4Template]
    )
    const hasCompatibleSelectedCustomA4 = Boolean(
        selectedCustomA4Template && selectedCustomA4Layout
    )
    const customA4Preview = useMemo(
        () => customA4Target && customReceiptData
            ? createCustomTemplatePreview(customA4Target, {
                workspaceId: user?.workspaceId,
                workspaceName,
                features,
                receiptData: customReceiptData,
                sale: printingSale || undefined,
                salesHistoryPrintVersion: selectedCustomA4Template?.module_type_key === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
                    ? 'returned'
                    : salesHistoryPrintVersion,
                productImageUrls
            })
            : undefined,
        [customReceiptData, customA4Target, features, printingSale, productImageUrls, salesHistoryPrintVersion, selectedCustomA4Template?.module_type_key, user?.workspaceId, workspaceName]
    )
    const buildCustomA4Pdf = useCallback(async ({ effectiveId }: { format: PrintFormat; effectiveId: string }) => {
        if (!customA4Target || !selectedCustomA4Layout || !customReceiptData) {
            throw new Error('Custom A4 template is not available.')
        }

        return buildCustomTemplateLayoutPdf({
            target: customA4Target,
            layout: selectedCustomA4Layout,
            values: {},
            options: {
                workspaceId: user?.workspaceId,
                workspaceName,
                features,
                receiptData: customReceiptData,
                sale: printingSale || undefined,
                salesHistoryPrintVersion: selectedCustomA4Template?.module_type_key === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
                    ? 'returned'
                    : salesHistoryPrintVersion,
                productImageUrls
            },
            effectiveId
        })
    }, [customReceiptData, customA4Target, features, printingSale, productImageUrls, salesHistoryPrintVersion, selectedCustomA4Layout, selectedCustomA4Template?.module_type_key, user?.workspaceId, workspaceName])
    const buildEditableCustomA4Pdf = useCallback(async (
        layout: CustomTemplateLayout,
        _printLangOverride?: string,
        effectiveId?: string
    ) => {
        if (!customA4Target || !customReceiptData) {
            throw new Error('Custom A4 template is not available.')
        }

        return buildCustomTemplateLayoutPdf({
            target: customA4Target,
            layout,
            values: {},
            options: {
                workspaceId: user?.workspaceId,
                workspaceName,
                features,
                receiptData: customReceiptData,
                sale: printingSale || undefined,
                salesHistoryPrintVersion: selectedCustomA4Template?.module_type_key === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
                    ? 'returned'
                    : salesHistoryPrintVersion,
                productImageUrls
            },
            effectiveId,
            fieldMode: 'layoutOverrides'
        })
    }, [customReceiptData, customA4Target, features, printingSale, productImageUrls, salesHistoryPrintVersion, selectedCustomA4Template?.module_type_key, user?.workspaceId, workspaceName])

    const nativeAtlasStandardA4Target = useMemo(
        () => selectedNativeA4TemplateKey ? getCustomTemplateTarget(selectedNativeA4TemplateKey) : undefined,
        [selectedNativeA4TemplateKey]
    )
    const nativeAtlasStandardA4Preview = useMemo(
        () => nativeAtlasStandardA4Target && printingSale
            ? createCustomTemplatePreview(nativeAtlasStandardA4Target, {
                workspaceId: user?.workspaceId,
                workspaceName,
                features,
                sale: printingSale,
                salesHistoryPrintVersion,
                productImageUrls,
                printedBy: user?.name || undefined
            })
            : undefined,
        [features, nativeAtlasStandardA4Target, printingSale, productImageUrls, salesHistoryPrintVersion, user?.name, user?.workspaceId, workspaceName]
    )
    const buildNativeAtlasStandardA4Pdf = useCallback(async ({ effectiveId, printLangOverride }: {
        format: PrintFormat
        effectiveId: string
        printLangOverride?: string
    }) => {
        if (!nativeAtlasStandardA4Preview) {
            throw new Error('Sales History Atlas Standard template is not available.')
        }
        const element = nativeAtlasStandardA4Preview.createElement({}, effectiveId, printLangOverride)
        return nativeAtlasStandardA4Preview.buildPdf(element, printLangOverride)
    }, [nativeAtlasStandardA4Preview])

    const activeCustomTemplate = printFormat === 'a4' ? selectedCustomA4Template : selectedCustomReceiptTemplate
    const hasActiveCustomTemplate = printFormat === 'a4' ? hasCompatibleSelectedCustomA4 : hasCompatibleSelectedCustomReceipt
    const activeCustomTarget = printFormat === 'a4' ? customA4Target : customReceiptTarget
    const activeCustomLayout = printFormat === 'a4' ? selectedCustomA4Layout : selectedCustomReceiptLayout
    const activeCustomPreview = printFormat === 'a4' ? customA4Preview : customReceiptPreview
    const activeBuildCustomPdf = printFormat === 'a4' ? buildCustomA4Pdf : buildCustomReceiptPdf
    const activeBuildEditableCustomPdf = printFormat === 'a4' ? buildEditableCustomA4Pdf : buildEditableCustomReceiptPdf
    const hasActiveNativeAtlasStandardTemplate = printFormat === 'a4' && Boolean(nativeAtlasStandardA4Preview)
    const activeTemplatePreview = hasActiveCustomTemplate
        ? activeCustomPreview
        : hasActiveNativeAtlasStandardTemplate
            ? nativeAtlasStandardA4Preview
            : undefined
    const activePdfBuilder = hasActiveCustomTemplate
        ? activeBuildCustomPdf
        : hasActiveNativeAtlasStandardTemplate
            ? buildNativeAtlasStandardA4Pdf
            : undefined

    const [isWholeSaleReturn, setIsWholeSaleReturn] = useState(false)

    const finalizeReturn = (sale: Sale, items: SaleItem[], isWholeSale: boolean, isPartial: boolean = false) => {
        const filteredSale = { ...sale, items, _isWholeSaleReturn: isWholeSale, _isPartialReturn: isPartial } as any
        setReturnPaymentAccount(null)

        const rules = items
            .filter(item => item.product && item.product.return_rules)
            .map(item => ({
                productName: item.product?.name || item.product_name || 'Product',
                rules: item.product?.return_rules || ''
            }))

        if (rules.length > 0) {
            setSaleToReturn(filteredSale)
            setRulesQueue(rules)
            setCurrentRuleIndex(0)
        } else {
            setSaleToReturn(filteredSale)
            setReturnModalOpen(true)
        }
        setShowDeclineModal(false)
    }

    const initiateReturn = (sale: Sale, isWholeSale: boolean) => {
        const itemsToCheck = sale.items || []
        const isFlaggedSale = sale.system_review_status === 'flagged'

        // Flagged sales bypass non-returnable product restrictions
        if (!isFlaggedSale) {
            const nonReturnableItems = itemsToCheck.filter(item =>
                item.product && (item.product.can_be_returned === false || item.product.is_deleted === true)
            )
            const returnableItems = itemsToCheck.filter(item =>
                !item.product || (item.product.can_be_returned !== false && item.product.is_deleted !== true)
            )

            const nonReturnableNames = nonReturnableItems.map(item => ({
                name: item.product?.name || item.product_name || 'Unknown Product',
                isDeleted: item.product?.is_deleted === true
            }))

            if (nonReturnableNames.length > 0) {
                setNonReturnableProducts(nonReturnableNames)
                setSaleToReturn(sale)
                setIsWholeSaleReturn(isWholeSale)

                if (returnableItems.length > 0) {
                    setFilteredReturnItems(returnableItems)
                    setShowDeclineModal(true)
                } else {
                    setFilteredReturnItems([])
                    setShowDeclineModal(true)
                }
                return
            }
        }

        finalizeReturn(sale, itemsToCheck, isWholeSale, false)
    }

    const handleNextRule = () => {
        if (currentRuleIndex < rulesQueue.length - 1) {
            setCurrentRuleIndex(currentRuleIndex + 1)
        } else {
            // All rules reviewed, proceed to confirmation
            setCurrentRuleIndex(-1)
            setRulesQueue([])
            setReturnModalOpen(true)
        }
    }

    const handleCancelRules = () => {
        setCurrentRuleIndex(-1)
        setRulesQueue([])
        setSaleToReturn(null)
    }

    const handleBackRule = () => {
        if (currentRuleIndex > 0) {
            setCurrentRuleIndex(currentRuleIndex - 1)
        }
    }

    const handleReturnSale = (sale: Sale) => {
        initiateReturn(sale, true)
    }

    const openSaleReturnAction = (sale: Sale) => {
        // Exchanges are an atomic POS-only operation. Other Sales History
        // records retain the existing return behaviour without presenting an
        // action that their source cannot fulfil.
        if (sale.origin !== 'pos') {
            handleReturnSale(sale)
            return
        }
        setSaleForReturnAction(sale)
    }

    const handleProductExchangeSubmit = async (draft: ProductExchangeDraft) => {
        if (!user?.workspaceId || !saleForProductExchange) {
            throw new Error(t('sales.exchange.submitFailed', { defaultValue: 'The exchange could not be completed. Please try again.' }))
        }

        setIsSubmittingProductExchange(true)
        try {
            await processSaleProductExchange({
                workspaceId: user.workspaceId,
                saleId: saleForProductExchange.id,
                returnSaleItemId: draft.originalSaleItemId,
                returnQuantity: draft.returnQuantity,
                replacementProductId: draft.replacementProductId,
                replacementStorageId: draft.replacementStorageId,
                replacementQuantity: draft.replacementQuantity,
                replacementUnitAmount: draft.replacementUnitAmount,
                settlementMethod: draft.settlementMethod,
                accountId: draft.accountId ?? null,
                accountNameSnapshot: draft.accountNameSnapshot ?? null,
                returnReason: 'Product exchange',
                createdBy: user.id,
            })
            toast({
                title: t('sales.exchange.complete', { defaultValue: 'Complete Exchange' }),
                description: t('sales.exchange.completedDescription', { defaultValue: 'The product exchange has been recorded.' }),
            })
        } catch (error) {
            const description = error instanceof Error
                ? error.message
                : t('sales.exchange.submitFailed', { defaultValue: 'The exchange could not be completed. Please try again.' })
            toast({
                variant: 'destructive',
                title: t('common.error', { defaultValue: 'Error' }),
                description,
            })
            throw error
        } finally {
            setIsSubmittingProductExchange(false)
        }
    }

    const handleProductExchangeFromDetails = (item: SaleItem) => {
        if (!selectedSale || selectedSale.origin !== 'pos') {
            return
        }

        setLockedProductExchangeSaleItemId(item.id)
        setSaleForProductExchange(selectedSale)
    }

    const handleReturnItem = (item: SaleItem) => {
        // For individual item returns, we need to create a mock sale object
        // with just this item for the return modal
        const mockSale: Sale & { _isWholeSaleReturn?: boolean } = {
            ...selectedSale!,
            items: [item],
            _isWholeSaleReturn: false
        }
        initiateReturn(mockSale, false)
    }

    const toLocalBatchAllocations = useCallback((item: SaleItem) => {
        return (item.batch_allocations || []).map((allocation: any) => ({
            batchId: allocation.batch_id ?? allocation.batchId,
            batchNumber: allocation.batch_number ?? allocation.batchNumber,
            quantity: allocation.quantity,
            price: allocation.price ?? null,
            costPrice: allocation.cost_price ?? allocation.costPrice ?? null,
            currency: allocation.currency ?? null,
            expiryDate: allocation.expiry_date ?? allocation.expiryDate ?? null,
            manufacturingDate: allocation.manufacturing_date ?? allocation.manufacturingDate ?? null
        }))
    }, [])

    const toUiBatchAllocations = useCallback((allocations: StockBatchAllocation[]) => {
        return allocations.map((allocation) => ({
            batch_id: allocation.batchId,
            batch_number: allocation.batchNumber,
            quantity: allocation.quantity,
            price: allocation.price ?? null,
            cost_price: allocation.costPrice ?? null,
            currency: allocation.currency ?? null,
            expiry_date: allocation.expiryDate ?? null,
            manufacturing_date: allocation.manufacturingDate ?? null
        }))
    }, [])

    const restoreInventoryForReturn = useCallback(async (input: {
        workspaceId: string
        items: SaleItem[]
        quantities: number[]
        timestamp: string
        syncSource: 'local' | 'remote'
    }) => {
        const plans = await Promise.all(input.items.map(async (item, index) => {
            const quantityToRestore = Math.max(0, input.quantities[index] || 0)
            const storageId = quantityToRestore > 0
                ? await resolveReturnStorageId({
                    workspaceId: input.workspaceId,
                    productId: item.product_id,
                    saleStorageId: item.storage_id ?? null
                })
                : (item.storage_id ?? null)
            const existingBatchAllocations = toLocalBatchAllocations(item)
            const { restoredAllocations, remainingAllocations } = splitStockBatchAllocationsForReturn(
                existingBatchAllocations,
                quantityToRestore
            )

            return {
                item,
                quantity: quantityToRestore,
                storageId,
                restoredAllocations,
                remainingBatchAllocations: remainingAllocations,
                appliedRestoreAllocations: [] as StockBatchAllocation[]
            }
        }))

        const missingPlan = plans.find((plan) => plan.quantity > 0 && !plan.storageId)
        if (missingPlan) {
            throw new Error(`No active storage available for returned item ${missingPlan.item.product_name || missingPlan.item.product_id}`)
        }

        const appliedPlans: typeof plans = []
        try {
            for (const plan of plans) {
                if (plan.quantity <= 0 || !plan.storageId) {
                    continue
                }

                await adjustInventoryQuantity({
                    workspaceId: input.workspaceId,
                    productId: plan.item.product_id,
                    storageId: plan.storageId,
                    quantityDelta: plan.quantity,
                    timestamp: input.timestamp,
                    syncSource: input.syncSource === 'remote' ? 'remote' : undefined,
                    skipRemoteSync: input.syncSource === 'remote'
                })

                if (plan.restoredAllocations.length > 0) {
                    plan.appliedRestoreAllocations = await restoreStockBatchAllocations(
                        input.workspaceId,
                        plan.item.product_id,
                        plan.storageId,
                        plan.restoredAllocations,
                        {
                            timestamp: input.timestamp,
                            syncSource: input.syncSource,
                            skipRemoteSync: input.syncSource === 'remote'
                        }
                    )
                }

                appliedPlans.push(plan)
            }
        } catch (error) {
            for (const plan of [...appliedPlans].reverse()) {
                try {
                    if (!plan.storageId) {
                        continue
                    }

                    if (plan.appliedRestoreAllocations.length > 0) {
                        await commitStockBatchAllocations(
                            input.workspaceId,
                            plan.item.product_id,
                            plan.storageId,
                            plan.appliedRestoreAllocations,
                            {
                                timestamp: input.timestamp,
                                syncSource: input.syncSource,
                                skipRemoteSync: input.syncSource === 'remote'
                            }
                        )
                    }

                    await adjustInventoryQuantity({
                        workspaceId: input.workspaceId,
                        productId: plan.item.product_id,
                        storageId: plan.storageId,
                        quantityDelta: -plan.quantity,
                        timestamp: input.timestamp,
                        syncSource: input.syncSource === 'remote' ? 'remote' : undefined,
                        skipRemoteSync: input.syncSource === 'remote'
                    })
                } catch (rollbackError) {
                    console.error('[Sales] Failed to rollback local return inventory:', rollbackError)
                }
            }

            throw error
        }

        return plans.map((plan) => ({
            storageId: plan.storageId,
            remainingBatchAllocations: toUiBatchAllocations(plan.remainingBatchAllocations),
            restoredBatchAllocations: plan.appliedRestoreAllocations
        }))
    }, [toLocalBatchAllocations, toUiBatchAllocations])

    const persistLocalReturnLedger = useCallback(async (input: {
        returnId: string
        sale: Sale
        reason: string
        timestamp: string
        refundAmount: number
        linePayloads: Array<{ id: string; sale_item_id: string; quantity: number }>
        restoredPlans: Array<{
            storageId: string | null
            restoredBatchAllocations: StockBatchAllocation[]
        }>
        pendingSync: boolean
        paymentAccount?: PaymentAccount | null
        hasPaymentAccountSelection?: boolean
    }) => {
        const syncStatus = input.pendingSync ? 'pending' : 'synced'
        const saleReturn: LocalSaleReturn = {
            id: input.returnId,
            workspaceId: input.sale.workspace_id,
            saleId: input.sale.id,
            reason: input.reason || 'Return',
            status: 'posted',
            refundMethod: null,
            refundAmount: input.refundAmount,
            returnedBy: user?.id ?? null,
            returnedAt: input.timestamp,
            source: 'app',
            createdAt: input.timestamp,
            updatedAt: input.timestamp,
            syncStatus,
            lastSyncedAt: input.pendingSync ? null : input.timestamp,
            version: 1,
            isDeleted: false
        }
        const saleReturnItems: LocalSaleReturnItem[] = input.linePayloads.map((line, index) => {
            const saleItem = input.sale.items?.find((item) => item.id === line.sale_item_id)
            const unitRefundAmount = saleItem?.converted_unit_price || saleItem?.unit_price || 0

            return {
                id: line.id,
                workspaceId: input.sale.workspace_id,
                returnId: input.returnId,
                saleId: input.sale.id,
                saleItemId: line.sale_item_id,
                quantity: line.quantity,
                unitRefundAmount,
                refundAmount: unitRefundAmount * line.quantity,
                restoredStorageId: input.restoredPlans[index]?.storageId ?? null,
                restoredBatchAllocations: input.restoredPlans[index]?.restoredBatchAllocations ?? null,
                createdAt: input.timestamp,
                updatedAt: input.timestamp,
                syncStatus,
                lastSyncedAt: input.pendingSync ? null : input.timestamp,
                version: 1,
                isDeleted: false
            }
        })

        await db.transaction('rw', [db.sale_returns, db.sale_return_items], async () => {
            await db.sale_returns.put(saleReturn)
            await db.sale_return_items.bulkPut(saleReturnItems)
        })

        if (input.sale.origin !== 'pos' || input.sale.payment_method === 'loan' || input.refundAmount <= 0) {
            return
        }

        const salePayments = await db.payment_transactions
            .where('[workspaceId+sourceType+sourceRecordId]')
            .equals([input.sale.workspace_id, 'pos_sale', input.sale.id])
            .toArray()
        const originalPayment = salePayments
            .filter((payment) => !payment.isDeleted && !payment.reversalOfTransactionId)
            .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))[0]
        const saleCurrency = input.sale.settlement_currency?.toLowerCase()
        const paymentCurrency: CurrencyCode = saleCurrency === 'usd' || saleCurrency === 'eur' || saleCurrency === 'iqd' || saleCurrency === 'try'
            ? saleCurrency
            : 'usd'

        await appendPaymentTransaction(input.sale.workspace_id, {
            sourceModule: 'sales',
            sourceType: 'pos_sale',
            sourceRecordId: input.sale.id,
            sourceSubrecordId: input.returnId,
            direction: 'incoming',
            amount: -Math.abs(input.refundAmount),
            currency: paymentCurrency,
            paymentMethod: (input.sale.payment_method || 'cash') as WorkspacePaymentMethod,
            paidAt: input.timestamp,
            counterpartyName: input.sale._counterpartyName || null,
            referenceLabel: input.sale._orderNumber || input.sale.id,
            note: `Sale return ${input.returnId}: ${input.reason || 'Return'}`,
            createdBy: user?.id || null,
            reversalOfTransactionId: originalPayment?.id ?? null,
            ...(input.hasPaymentAccountSelection
                ? {
                    accountId: input.paymentAccount?.id ?? null,
                    accountNameSnapshot: input.paymentAccount?.name ?? null
                }
                : {}),
            metadata: { saleReturnId: input.returnId, returnReason: input.reason || 'Return' }
        })
    }, [user?.id])

    const handleReturnConfirm = async (reason: string, quantity?: number) => {
        if (!saleToReturn) return
        const returnId = crypto.randomUUID()

        const recordReturnLoanPayment = async (amt: number, options: {
            isFullSaleReturn: boolean
            pendingRemoteSync: boolean
        }) => {
            if (saleToReturn.payment_method === 'loan' && amt > 0) {
                try {
                    if (options.isFullSaleReturn) {
                        await markPosLoanCancelledForFullSaleReturn({
                            workspaceId: saleToReturn.workspace_id,
                            saleId: saleToReturn.id,
                            returnId,
                            reason,
                            createdBy: user?.id,
                            pendingRemoteSync: options.pendingRemoteSync
                        })
                        return
                    }

                    const loan = await db.loans.where('saleId').equals(saleToReturn.id).first()
                    if (loan) {
                        await recordLoanPayment(saleToReturn.workspace_id, {
                            loanId: loan.id,
                            amount: amt,
                            paymentMethod: 'loan_adjustment',
                            note: `Return Credit (Reason: ${reason || 'Return'})`,
                            createdBy: user?.id
                        })
                    }
                } catch (e) {
                    console.error('[Sales] Failed to apply loan return payment:', e)
                }
            }
        }

        const isSaleFullyReturnedBy = (items: Sale['items'] | undefined, quantities: number[] = []) => {
            const quantitiesByItemId = new Map((items || []).map((item, index) => [item.id, quantities[index] || 0]))
            return (saleToReturn.items || []).every((item) => (
                (item.returned_quantity || 0) + (quantitiesByItemId.get(item.id) || 0) >= item.quantity
            ))
        }

        try {
            let error
            const isPartialReturn = (saleToReturn as any)._isPartialReturn
            const isIndividualItemReturn = saleToReturn?.items?.length === 1 && !(saleToReturn as any)._isWholeSaleReturn && !isPartialReturn
            const isCurrentlyOnline = typeof navigator === 'undefined' ? true : navigator.onLine
            if (!isLocalMode && !isCurrentlyOnline) {
                throw new Error(t('inventory.errors.onlineRequired'))
            }
            const shouldQueueOfflineReturn = false

            const queueOfflineReturnMutation = async (payload: Record<string, unknown>) => {
                await db.offline_mutations.add({
                    id: crypto.randomUUID(),
                    workspaceId: activeWorkspace?.id || saleToReturn.workspace_id,
                    entityType: 'sales',
                    entityId: saleToReturn.id,
                    operation: 'update',
                    payload,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                })
            }

            if (isLocalMode || shouldQueueOfflineReturn) {
                if (isIndividualItemReturn || isPartialReturn) {
                    const itemsToReturn = saleToReturn.items || []
                    if (itemsToReturn.length === 0) return

                    const itemIds = itemsToReturn.map(i => i.id)
                    const quantities = itemsToReturn.map(i =>
                        quantity && itemsToReturn.length === 1 ? quantity : (i.quantity - (i.returned_quantity || 0))
                    )
                    const returnLinePayloads = itemsToReturn.map((item, index) => ({
                        id: crypto.randomUUID(),
                        sale_item_id: item.id,
                        quantity: quantities[index]
                    }))
                    const returnTimestamp = new Date().toISOString()
                    const restoredPlans = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: isLocalMode ? 'local' : 'remote'
                    })
                    const returnValue = itemsToReturn.reduce((sum, item, index) => {
                        const unitPrice = item.converted_unit_price || item.unit_price || 0
                        return sum + (unitPrice * quantities[index])
                    }, 0)
                    await persistLocalReturnLedger({
                        returnId,
                        sale: saleToReturn,
                        reason,
                        timestamp: returnTimestamp,
                        refundAmount: returnValue,
                        linePayloads: returnLinePayloads,
                        restoredPlans,
                        pendingSync: shouldQueueOfflineReturn,
                        paymentAccount: returnPaymentAccount,
                        hasPaymentAccountSelection: returnPaymentAccount !== null
                    })

                    const updateSale = (s: Sale): Sale => {
                        if (s.id !== saleToReturn.id) return s
                        const updatedItems = s.items?.map(i => {
                            const returnedIdx = itemIds.indexOf(i.id)
                            if (returnedIdx === -1) return i

                            const q = quantities[returnedIdx]
                            const newReturnedQty = (i.returned_quantity || 0) + q
                            return {
                                ...i,
                                storage_id: restoredPlans[returnedIdx]?.storageId || i.storage_id,
                                batch_allocations: restoredPlans[returnedIdx]?.remainingBatchAllocations || i.batch_allocations,
                                returned_quantity: newReturnedQty,
                                is_returned: newReturnedQty >= i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }
                        })

                        return {
                            ...s,
                            totalAmount: (s.totalAmount ?? s.total_amount ?? 0) - returnValue,
                            returned_amount: (s.returned_amount || 0) + returnValue,
                            return_status: updatedItems?.every(i => i.is_returned) ? 'full' : 'partial',
                            is_returned: updatedItems?.every(i => i.is_returned) || false,
                            items: updatedItems
                        }
                    }

                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        const updatedSale = updateSale({ ...existingLocal, items: (existingLocal as any)._enrichedItems } as any)
                            ; (existingLocal as any)._enrichedItems = updatedSale.items
                            ; (existingLocal as any).totalAmount = updatedSale.totalAmount
                            ; (existingLocal as any).originalTotalAmount ??= (existingLocal as any).totalAmount + ((existingLocal as any).returnedAmount || 0) + returnValue
                            ; (existingLocal as any).returnedAmount = ((existingLocal as any).returnedAmount || 0) + returnValue
                            ; (existingLocal as any).returnStatus = updatedSale.is_returned ? 'full' : 'partial'
                            ; (existingLocal as any).isReturned = updatedSale.is_returned
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = returnTimestamp
                            ; (existingLocal as any).returnedBy = user?.id
                            ; (existingLocal as any).updatedAt = returnTimestamp
                        if (shouldQueueOfflineReturn) {
                            ; (existingLocal as any).syncStatus = 'pending'
                                ; (existingLocal as any).lastSyncedAt = null
                        }
                        await db.sales.put(existingLocal)
                    }
                    await Promise.all(itemsToReturn.map((item, index) => {
                        const newReturnedQty = (item.returned_quantity || 0) + quantities[index]
                        return db.sale_items.update(item.id, {
                            returnedQuantity: newReturnedQty,
                            storageId: restoredPlans[index]?.storageId || item.storage_id,
                            batchAllocations: restoredPlans[index]?.remainingBatchAllocations?.map((allocation) => ({
                                batchId: allocation.batch_id,
                                batchNumber: allocation.batch_number,
                                quantity: allocation.quantity,
                                expiryDate: allocation.expiry_date ?? null,
                                manufacturingDate: allocation.manufacturing_date ?? null
                            })),
                            returnReason: reason,
                            isReturned: newReturnedQty >= item.quantity,
                            returnedAt: returnTimestamp,
                            returnedBy: user?.id,
                            updatedAt: returnTimestamp,
                        } as any)
                    }))
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                    if (shouldQueueOfflineReturn) {
                        await queueOfflineReturnMutation({
                            __rpc_action: 'process_sale_return',
                            p_return_id: returnId,
                            p_sale_id: saleToReturn.id,
                            p_items: returnLinePayloads,
                            p_return_reason: reason,
                            p_refund_method: null
                        })
                        toast({
                            title: t('sales.return.confirmTitle') || 'Return Sale',
                            description: t('pos.offlineDesc') || 'Sale saved locally and will sync when online.',
                        })
                    }
                    await recordReturnLoanPayment(returnValue, {
                        isFullSaleReturn: isSaleFullyReturnedBy(itemsToReturn, quantities),
                        pendingRemoteSync: shouldQueueOfflineReturn
                    })
                } else {
                    const itemsToReturn = (saleToReturn.items || []).filter(
                        (item) => item.quantity - (item.returned_quantity || 0) > 0
                    )
                    if (itemsToReturn.length === 0) return
                    const quantities = itemsToReturn.map((item) => item.quantity - (item.returned_quantity || 0))
                    const returnLinePayloads = itemsToReturn.map((item, index) => ({
                        id: crypto.randomUUID(),
                        sale_item_id: item.id,
                        quantity: quantities[index]
                    }))
                    const returnTimestamp = new Date().toISOString()
                    const restoredPlans = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: isLocalMode ? 'local' : 'remote'
                    })
                    const returnValue = itemsToReturn.reduce((sum, item, index) => {
                        const unitPrice = item.converted_unit_price || item.unit_price || 0
                        return sum + (unitPrice * quantities[index])
                    }, 0)
                    await persistLocalReturnLedger({
                        returnId,
                        sale: saleToReturn,
                        reason,
                        timestamp: returnTimestamp,
                        refundAmount: returnValue,
                        linePayloads: returnLinePayloads,
                        restoredPlans,
                        pendingSync: shouldQueueOfflineReturn,
                        paymentAccount: returnPaymentAccount,
                        hasPaymentAccountSelection: returnPaymentAccount !== null
                    })

                    const updateSale = (s: Sale): Sale => {
                        if (s.id !== saleToReturn.id) return s
                        return {
                            ...s,
                            is_returned: true,
                            totalAmount: 0,
                            returned_amount: (s.returned_amount || 0) + returnValue,
                            return_status: 'full',
                            return_reason: reason,
                            returned_at: returnTimestamp,
                            items: s.items?.map((i) => {
                                const returnedIndex = itemsToReturn.findIndex((item) => item.id === i.id)
                                if (returnedIndex === -1) return i
                                return {
                                    ...i,
                                    storage_id: restoredPlans[returnedIndex]?.storageId || i.storage_id,
                                    batch_allocations: restoredPlans[returnedIndex]?.remainingBatchAllocations || i.batch_allocations,
                                    is_returned: true,
                                    returned_quantity: i.quantity,
                                    return_reason: reason,
                                    returned_at: returnTimestamp
                                }
                            })
                        }
                    }

                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        ; (existingLocal as any).isReturned = true
                            ; (existingLocal as any).totalAmount = 0
                            ; (existingLocal as any).originalTotalAmount ??= returnValue + ((existingLocal as any).returnedAmount || 0)
                            ; (existingLocal as any).returnedAmount = ((existingLocal as any).returnedAmount || 0) + returnValue
                            ; (existingLocal as any).returnStatus = 'full'
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = returnTimestamp
                            ; (existingLocal as any).returnedBy = user?.id
                            ; (existingLocal as any).updatedAt = returnTimestamp
                        const updatedItems = ((existingLocal as any)._enrichedItems || []).map((i: any) => {
                            const returnedIndex = itemsToReturn.findIndex((item) => item.id === i.id)
                            if (returnedIndex === -1) return i
                            return {
                                ...i,
                                storage_id: restoredPlans[returnedIndex]?.storageId || i.storage_id,
                                batch_allocations: restoredPlans[returnedIndex]?.remainingBatchAllocations || i.batch_allocations,
                                is_returned: true,
                                returned_quantity: i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }
                        })
                            ; (existingLocal as any)._enrichedItems = updatedItems
                        if (shouldQueueOfflineReturn) {
                            ; (existingLocal as any).syncStatus = 'pending'
                                ; (existingLocal as any).lastSyncedAt = null
                        }
                        await db.sales.put(existingLocal)
                    }
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                    await Promise.all(itemsToReturn.map((item, index) =>
                        db.sale_items.update(item.id, {
                            returnedQuantity: item.quantity,
                            storageId: restoredPlans[index]?.storageId || item.storage_id,
                            batchAllocations: restoredPlans[index]?.remainingBatchAllocations?.map((allocation) => ({
                                batchId: allocation.batch_id,
                                batchNumber: allocation.batch_number,
                                quantity: allocation.quantity,
                                expiryDate: allocation.expiry_date ?? null,
                                manufacturingDate: allocation.manufacturing_date ?? null
                            })),
                            returnReason: reason,
                            isReturned: true,
                            returnedAt: returnTimestamp,
                            returnedBy: user?.id,
                            updatedAt: returnTimestamp,
                        } as any)
                    ))
                    if (shouldQueueOfflineReturn) {
                        await queueOfflineReturnMutation({
                            __rpc_action: 'process_sale_return',
                            p_return_id: returnId,
                            p_sale_id: saleToReturn.id,
                            p_items: returnLinePayloads,
                            p_return_reason: reason,
                            p_refund_method: null
                        })
                        toast({
                            title: t('sales.return.confirmTitle') || 'Return Sale',
                            description: t('pos.offlineDesc') || 'Sale saved locally and will sync when online.',
                        })
                    }
                    await recordReturnLoanPayment(returnValue, {
                        isFullSaleReturn: true,
                        pendingRemoteSync: shouldQueueOfflineReturn
                    })
                }

                if (tutorialSaleId === saleToReturn.id) {
                    demoTutorial.completeSaleReturned()
                }
                setReturnModalOpen(false)
                setSaleToReturn(null)
                return
            }

            if (isIndividualItemReturn || isPartialReturn) {
                // Partial or Individual Item Return
                const itemsToReturn = saleToReturn.items || []
                if (itemsToReturn.length === 0) return

                const itemIds = itemsToReturn.map(i => i.id)
                // Use provided quantity for single item return, otherwise use full item quantity
                const quantities = itemsToReturn.map(i =>
                    quantity && itemsToReturn.length === 1 ? quantity : (i.quantity - (i.returned_quantity || 0))
                )
                const returnLinePayloads = itemsToReturn.map((item, index) => ({
                    id: crypto.randomUUID(),
                    sale_item_id: item.id,
                    quantity: quantities[index]
                }))

                const { data, error: itemError } = await runSupabaseAction('sales.returnItems', () =>
                    supabase.rpc('process_sale_return', {
                        p_return_id: returnId,
                        p_sale_id: saleToReturn.id,
                        p_items: returnLinePayloads,
                        p_return_reason: reason,
                        p_refund_method: null
                    })
                )
                error = itemError

                if (!error && data?.success) {
                    const returnValue = data.return_value || 0
                    const returnTimestamp = new Date().toISOString()
                    const restoredPlans = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: 'remote'
                    })
                    await persistLocalReturnLedger({
                        returnId,
                        sale: saleToReturn,
                        reason,
                        timestamp: returnTimestamp,
                        refundAmount: returnValue,
                        linePayloads: returnLinePayloads,
                        restoredPlans,
                        pendingSync: false,
                        paymentAccount: returnPaymentAccount,
                        hasPaymentAccountSelection: returnPaymentAccount !== null
                    })

                    const updateSale = (s: Sale): Sale => {
                        if (s.id !== saleToReturn.id) return s
                        const updatedItems = s.items?.map(i => {
                            const returnedIdx = itemIds.indexOf(i.id)
                            if (returnedIdx === -1) return i

                            const q = quantities[returnedIdx]
                            const newReturnedQty = (i.returned_quantity || 0) + q
                            return {
                                ...i,
                                storage_id: restoredPlans[returnedIdx]?.storageId || i.storage_id,
                                batch_allocations: restoredPlans[returnedIdx]?.remainingBatchAllocations || i.batch_allocations,
                                returned_quantity: newReturnedQty,
                                is_returned: newReturnedQty >= i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }
                        })

                        return {
                            ...s,
                            totalAmount: (s.totalAmount ?? s.total_amount ?? 0) - returnValue,
                            returned_amount: (s.returned_amount || 0) + returnValue,
                            return_status: updatedItems?.every(i => i.is_returned) ? 'full' : 'partial',
                            is_returned: updatedItems?.every(i => i.is_returned) || false,
                            items: updatedItems
                        }
                    }

                    // Update local-db for instant UI reactivity
                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        const updatedSale = updateSale({ ...existingLocal, items: (existingLocal as any)._enrichedItems } as any)
                            ; (existingLocal as any)._enrichedItems = updatedSale.items
                            ; (existingLocal as any).totalAmount = updatedSale.totalAmount
                            ; (existingLocal as any).originalTotalAmount ??= (existingLocal as any).totalAmount + ((existingLocal as any).returnedAmount || 0) + returnValue
                            ; (existingLocal as any).returnedAmount = ((existingLocal as any).returnedAmount || 0) + returnValue
                            ; (existingLocal as any).returnStatus = updatedSale.is_returned ? 'full' : 'partial'
                            ; (existingLocal as any).isReturned = updatedSale.is_returned
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = returnTimestamp
                            ; (existingLocal as any).returnedBy = user?.id
                            ; (existingLocal as any).updatedAt = returnTimestamp
                        await db.sales.put(existingLocal)
                    }
                    await Promise.all(itemsToReturn.map((item, index) => {
                        const newReturnedQty = (item.returned_quantity || 0) + quantities[index]
                        return db.sale_items.update(item.id, {
                            returnedQuantity: newReturnedQty,
                            storageId: restoredPlans[index]?.storageId || item.storage_id,
                            batchAllocations: restoredPlans[index]?.remainingBatchAllocations?.map((allocation) => ({
                                batchId: allocation.batch_id,
                                batchNumber: allocation.batch_number,
                                quantity: allocation.quantity,
                                expiryDate: allocation.expiry_date ?? null,
                                manufacturingDate: allocation.manufacturing_date ?? null
                            })),
                            returnReason: reason,
                            isReturned: newReturnedQty >= item.quantity,
                            returnedAt: returnTimestamp,
                            returnedBy: user?.id,
                            updatedAt: returnTimestamp,
                        } as any)
                    }))
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                    await recordReturnLoanPayment(returnValue, {
                        isFullSaleReturn: isSaleFullyReturnedBy(itemsToReturn, quantities),
                        pendingRemoteSync: false
                    })
                }
            } else {
                // Whole Sale Return
                const itemsToReturn = (saleToReturn.items || []).filter(
                    (item) => item.quantity - (item.returned_quantity || 0) > 0
                )
                if (itemsToReturn.length === 0) return
                const quantities = itemsToReturn.map((item) => item.quantity - (item.returned_quantity || 0))
                const returnLinePayloads = itemsToReturn.map((item, index) => ({
                    id: crypto.randomUUID(),
                    sale_item_id: item.id,
                    quantity: quantities[index]
                }))
                const { data, error: saleError } = await runSupabaseAction('sales.returnWhole', () =>
                    supabase.rpc('process_sale_return', {
                        p_return_id: returnId,
                        p_sale_id: saleToReturn.id,
                        p_items: returnLinePayloads,
                        p_return_reason: reason,
                        p_refund_method: null
                    })
                )
                error = saleError

                if (!error && data?.success) {
                    const returnTimestamp = new Date().toISOString()
                    const restoredPlans = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: 'remote'
                    })
                    const returnValue = data.return_value || itemsToReturn.reduce((sum, item, index) => {
                        const unitPrice = item.converted_unit_price || item.unit_price || 0
                        return sum + (unitPrice * quantities[index])
                    }, 0)
                    await persistLocalReturnLedger({
                        returnId,
                        sale: saleToReturn,
                        reason,
                        timestamp: returnTimestamp,
                        refundAmount: returnValue,
                        linePayloads: returnLinePayloads,
                        restoredPlans,
                        pendingSync: false,
                        paymentAccount: returnPaymentAccount,
                        hasPaymentAccountSelection: returnPaymentAccount !== null
                    })

                    const updateSale = (s: Sale): Sale => {
                        if (s.id !== saleToReturn.id) return s
                        return {
                            ...s,
                            is_returned: true,
                            totalAmount: 0,
                            returned_amount: (s.returned_amount || 0) + returnValue,
                            return_status: 'full',
                            return_reason: reason,
                            returned_at: returnTimestamp,
                            items: s.items?.map((i) => {
                                const returnedIndex = itemsToReturn.findIndex((item) => item.id === i.id)
                                if (returnedIndex === -1) return i
                                return {
                                    ...i,
                                    storage_id: restoredPlans[returnedIndex]?.storageId || i.storage_id,
                                    batch_allocations: restoredPlans[returnedIndex]?.remainingBatchAllocations || i.batch_allocations,
                                    is_returned: true,
                                    returned_quantity: i.quantity,
                                    return_reason: reason,
                                    returned_at: returnTimestamp
                                }
                            })
                        }
                    }

                    // Update local-db for instant UI reactivity
                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        ; (existingLocal as any).isReturned = true
                            ; (existingLocal as any).totalAmount = 0
                            ; (existingLocal as any).originalTotalAmount ??= returnValue + ((existingLocal as any).returnedAmount || 0)
                            ; (existingLocal as any).returnedAmount = ((existingLocal as any).returnedAmount || 0) + returnValue
                            ; (existingLocal as any).returnStatus = 'full'
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = returnTimestamp
                            ; (existingLocal as any).returnedBy = user?.id
                            ; (existingLocal as any).updatedAt = returnTimestamp
                        const updatedItems = ((existingLocal as any)._enrichedItems || []).map((i: any) => {
                            const returnedIndex = itemsToReturn.findIndex((item) => item.id === i.id)
                            if (returnedIndex === -1) return i
                            return {
                                ...i,
                                storage_id: restoredPlans[returnedIndex]?.storageId || i.storage_id,
                                batch_allocations: restoredPlans[returnedIndex]?.remainingBatchAllocations || i.batch_allocations,
                                is_returned: true,
                                returned_quantity: i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }
                        })
                            ; (existingLocal as any)._enrichedItems = updatedItems
                        await db.sales.put(existingLocal)
                    }
                    await Promise.all(itemsToReturn.map((item, index) =>
                        db.sale_items.update(item.id, {
                            returnedQuantity: item.quantity,
                            storageId: restoredPlans[index]?.storageId || item.storage_id,
                            batchAllocations: restoredPlans[index]?.remainingBatchAllocations?.map((allocation) => ({
                                batchId: allocation.batch_id,
                                batchNumber: allocation.batch_number,
                                quantity: allocation.quantity,
                                expiryDate: allocation.expiry_date ?? null,
                                manufacturingDate: allocation.manufacturing_date ?? null
                            })),
                            returnReason: reason,
                            isReturned: true,
                            returnedAt: returnTimestamp,
                            returnedBy: user?.id,
                            updatedAt: returnTimestamp,
                        } as any)
                    ))
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                    await recordReturnLoanPayment(returnValue, {
                        isFullSaleReturn: true,
                        pendingRemoteSync: false
                    })
                }
            }
        
            if (error) throw normalizeSupabaseActionError(error)

            if (tutorialSaleId === saleToReturn.id) {
                demoTutorial.completeSaleReturned()
            }

            // Close modal and refresh — local-db handles reactivity via useLiveQuery
            setReturnModalOpen(false)
            setSaleToReturn(null)
        } catch (err: any) {
            console.error('Error returning sale:', err)
            const normalized = normalizeSupabaseActionError(err)
            if (isRetriableWebRequestError(normalized)) {
                const message = getRetriableActionToast(normalized)
                toast({
                    title: message.title,
                    description: message.description,
                    variant: 'destructive'
                })
            } else {
                toast({
                    title: t('common.error') || 'Error',
                    description: `Failed to return sale: ${normalized.message || 'Unknown error'}`,
                    variant: 'destructive'
                })
            }
        }
    }

    const handleSaveNote = async (note: string) => {
        if (!selectedSaleForNote) return

        // Viewer role cannot save notes
        if (user?.role === 'viewer') {
            toast({
                title: t('common.error') || 'Error',
                description: 'Viewers cannot save notes.',
                variant: 'destructive'
            })
            return
        }

        const now = new Date().toISOString()
        const isCurrentlyOnline = navigator.onLine && !isLocalMode
        const existingLocal = await db.sales.get(selectedSaleForNote.id)

        try {
            // Update local-db for instant UI reactivity (useLiveQuery will pick it up)
            await db.sales.update(selectedSaleForNote.id, {
                notes: note,
                updatedAt: now,
                syncStatus: 'pending'
            })

            if (isLocalMode) {
                toast({
                    title: t('sales.notes.saved') || 'Note Saved',
                    description: t('sales.notes.savedLocalOnly') || 'Note saved locally for this workspace.',
                })
                return
            }

            if (isCurrentlyOnline) {
                // 2. ONLINE: Write to Supabase first
                const { error } = await runSupabaseAction('sales.saveNote', () =>
                    supabase
                        .from('sales')
                        .update({
                            notes: note,
                            updated_at: now
                        })
                        .eq('id', selectedSaleForNote.id)
                )

                if (error) {
                    const normalized = normalizeSupabaseActionError(error)

                    if (!navigator.onLine) {
                        console.error('Supabase update failed, falling back to offline sync:', normalized)
                        await db.offline_mutations.add({
                            id: crypto.randomUUID(),
                            workspaceId: activeWorkspace?.id || selectedSaleForNote.workspace_id,
                            entityType: 'sales',
                            entityId: selectedSaleForNote.id,
                            operation: 'update',
                            payload: { notes: note, updated_at: now },
                            status: 'pending',
                            createdAt: now
                        })

                        await db.sales.update(selectedSaleForNote.id, {
                            notes: note,
                            updatedAt: now,
                            syncStatus: 'pending'
                        })

                        toast({
                            title: t('sales.notes.saved') || 'Note Saved',
                            description: t('sales.notes.savedOffline') || 'Note saved locally and will sync when online.',
                        })
                    } else {
                        if (existingLocal) {
                            await db.sales.put(existingLocal)
                        }
                        throw normalized
                    }
                } else {
                    // Success: Update Dexie as synced
                    await db.sales.update(selectedSaleForNote.id, {
                        notes: note,
                        updatedAt: now,
                        syncStatus: 'synced',
                        lastSyncedAt: now
                    })

                    toast({
                        title: t('sales.notes.saved') || 'Note Saved',
                        description: t('sales.notes.savedOnline') || 'Note saved to cloud.',
                    })
                }
            } else {
                // 3. OFFLINE: Local mutation
                await db.sales.update(selectedSaleForNote.id, {
                    notes: note,
                    updatedAt: now,
                    syncStatus: 'pending'
                })

                await db.offline_mutations.add({
                    id: crypto.randomUUID(),
                    workspaceId: activeWorkspace?.id || selectedSaleForNote.workspace_id,
                    entityType: 'sales',
                    entityId: selectedSaleForNote.id,
                    operation: 'update',
                    payload: { notes: note, updated_at: now },
                    status: 'pending',
                    createdAt: now
                })

                toast({
                    title: t('sales.notes.saved') || 'Note Saved',
                    description: isLocalMode
                        ? (t('sales.notes.savedLocalOnly') || 'Note saved locally for this workspace.')
                        : (t('sales.notes.savedOffline') || 'Note saved locally and will sync when online.'),
                })
            }
        } catch (error) {
            console.error('Error saving note:', error)
            const normalized = normalizeSupabaseActionError(error)
            toast({
                title: isRetriableWebRequestError(normalized)
                    ? getRetriableActionToast(normalized).title
                    : (t('common.error') || 'Error'),
                description: isRetriableWebRequestError(normalized)
                    ? getRetriableActionToast(normalized).description
                    : (t('sales.notes.error') || 'Failed to save note.'),
                variant: 'destructive',
            })
        }
    }


    if (isExportModalOpen) {
        return (
            <TooltipProvider>
                <ExportPreviewModal
                    isOpen={isExportModalOpen}
                    onClose={() => setIsExportModalOpen(false)}
                    filters={{
                        dateRange,
                        customDates,
                        selectedCashier: filters.cashier
                    }}
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
                            <h1 className="text-2xl font-bold flex items-center gap-2">
                                <Receipt className="w-6 h-6 text-primary" />
                                {t('sales.title') || 'Sales History'}
                                {(isLoading || isDateLoading) && (
                                    <Loader2 className="w-4 h-4 animate-spin text-primary/50 ml-1" />
                                )}
                            </h1>
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
                            {t('sales.subtitle') || 'View past transactions'} <ModulePageFreshness className="ms-2" tableNames={['sales']} />
                        </p>
                    </div>

                    <div className="hidden md:flex items-center bg-background/30 p-1 rounded-xl border border-border/50 backdrop-blur-md">
                        <Button
                            variant="ghost"
                            size="sm"
                            allowViewer={true}
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
                            allowViewer={true}
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

                    <div className="flex flex-wrap items-center gap-3" data-tour-id="tutorial-sales-history-filters">
                        <DateRangeFilters />

                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setIsFilterDialogOpen(true)}
                            className={cn("h-11 rounded-2xl border-border/60 px-4",
                                style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-y-[2px]" : ""
                            )}
                        >
                            <SlidersHorizontal className="me-2 h-4 w-4" />
                            {t('sales.filters.title', { defaultValue: 'Filters' })}
                            {activeFilterCount > 0 ? (
                                <span className="ms-2 inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                                    {activeFilterCount}
                                </span>
                            ) : null}
                        </Button>
                        {activeFilterCount > 0 ? (
                            <Button type="button" variant="ghost" onClick={() => setFilters(DEFAULT_SALES_FILTERS)} className="h-11 rounded-2xl px-4 text-muted-foreground">
                                <RotateCcw className="me-2 h-4 w-4" />
                                {t('sales.filters.clear', { defaultValue: 'Clear Filters' })}
                            </Button>
                        ) : null}
                    </div>
                </div>

                <Card className={cn(
                    "overflow-hidden backdrop-blur-sm",
                    style === 'neo-orange' ? "border-2 border-black dark:border-white bg-card" : "border-border/50 bg-card/50"
                )}>
                    <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between space-y-0 gap-4 pb-4">
                        <div className="flex flex-col gap-1">
                            <CardTitle>{t('sales.listTitle') || 'Recent Sales'}</CardTitle>
                            {totalCount > 0 && (
                                <p className="text-[10px] text-muted-foreground font-black uppercase tracking-[0.2em] opacity-70">
                                    {t('sales.pagination.total', { count: totalCount }) || `${totalCount} Sales Found`}
                                </p>
                            )}
                        </div>
                        <div className="flex flex-col sm:flex-row items-center gap-4">
                            <AppPagination
                                currentPage={currentPage}
                                totalCount={totalCount}
                                pageSize={pageSize}
                                onPageChange={setCurrentPage}
                                onPageSizeChange={(newSize) => {
                                    setPageSize(newSize)
                                    setCurrentPage(1)
                                }}
                                className="w-auto"
                            />
                            {hasCapability('excelExportSales') && (
                                <Button
                                    onClick={() => setIsExportModalOpen(true)}
                                    allowViewer={true}
                                    disabled={sales.length === 0}
                                    className={cn(
                                        "h-10 px-6 font-black transition-all flex gap-3 items-center group relative overflow-hidden",
                                        style === 'neo-orange'
                                            ? "rounded-[var(--radius)] bg-emerald-500 text-black border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-none translate-y-[-2px] active:translate-y-0"
                                            : "rounded-full bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] hover:scale-[1.02] active:scale-95",
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
                        </div>
                    </CardHeader>
                    <CardContent>
                        {(isLoading || isDateLoading) ? (
                            <div className="flex justify-center py-8">
                                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : sales.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground">
                                {t('common.noData')}
                            </div>
                        ) : (isMobile() || viewMode === 'grid') ? (
                            <div className={cn(
                                "grid gap-4",
                                viewMode === 'grid' && !isMobile() ? "grid-cols-1 lg:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
                            )}>
                                {sales.map((sale) => {
                                    const { isFullyReturned, hasAnyReturn, totalReturnedQuantity } = getSaleReturnState(sale)
                                    const loanIndicator = getLoanIndicator(sale)
                                    const hasProductExchange = (sale.product_exchanges || []).some((exchange: { status?: string }) => exchange.status === 'posted')
                                    const isTutorialSale = tutorialSaleId === sale.id

                                    return (
                                        <ContextMenu
                                            key={sale.id}
                                        >
                                            <ContextMenuTrigger asChild>
                                                <div
                                                    data-tour-id={isTutorialSale ? 'tutorial-sales-created-sale' : undefined}
                                                    className={cn(
                                                        "p-4 border shadow-sm space-y-4 transition-all active:scale-[0.98]",
                                                        style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "rounded-[2rem] md:rounded-2xl border-border",
                                                        isFullyReturned ? 'bg-destructive/5 border-destructive/20' : hasAnyReturn ? 'bg-orange-500/5' : 'bg-card'
                                                    )}
                                                >
                                                    <div
                                                        className="flex justify-between items-start"
                                                        data-tour-id={isTutorialSale ? 'tutorial-sales-sale-fields' : undefined}
                                                    >
                                                        <div className="space-y-2">
                                                            <div className="flex flex-col gap-1">
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
                                                                        {formatCompactDateTime(sale.created_at)}
                                                                    </span>
                                                                    {sale.sequenceId || (sale.origin === 'activities' && (sale as Sale & { _transactionNo?: string | null })._transactionNo) ? (
                                                                        <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-primary/10 text-primary rounded border border-primary/20">
                                                                            {getSaleReferenceLabel(sale)}
                                                                        </span>
                                                                    ) : (
                                                                        <span className="text-[10px] text-muted-foreground/50 font-mono">
                                                                            {getSaleReferenceLabel(sale)}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    {isFullyReturned && (
                                                                        <span className={cn(
                                                                            "px-2 py-0.5 text-[9px] font-bold bg-destructive/10 text-destructive border border-destructive/20 uppercase",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )}
                                                                            data-tour-id={isTutorialSale ? 'tutorial-returned-status' : undefined}
                                                                        >
                                                                            {t('sales.return.returnedStatus') || 'RETURNED'}
                                                                        </span>
                                                                    )}
                                                                    {sale.system_review_status === 'flagged' && (
                                                                        <span className={cn(
                                                                            "px-2 py-0.5 text-[9px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400 border border-orange-200 dark:border-orange-500/30 uppercase flex items-center gap-1",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )}>
                                                                            ⚠️ {t('sales.flagged') || 'FLAGGED'}
                                                                        </span>
                                                                    )}
                                                                    {hasAnyReturn && !isFullyReturned && (
                                                                        <span className={cn(
                                                                            "px-2 py-0.5 text-[9px] font-bold bg-orange-500/10 text-orange-600 border border-orange-500/20 uppercase",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )}>
                                                                            {totalReturnedQuantity > 0
                                                                                ? <>-{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}</>
                                                                                : (t('sales.return.partialReturn') || 'PARTIALLY RETURNED')}
                                                                        </span>
                                                                    )}
                                                                    {hasProductExchange && (
                                                                        <span className={cn(
                                                                            "px-2 py-0.5 text-[9px] font-bold bg-primary/10 text-primary border border-primary/20 uppercase",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )}>
                                                                            {t('sales.exchange.badge', { defaultValue: 'EXCHANGED' })}
                                                                        </span>
                                                                    )}
                                                                    <span className={cn(
                                                                        "px-2 py-0.5 text-[9px] font-bold bg-secondary text-secondary-foreground uppercase",
                                                                        style === 'neo-orange' ? "rounded-[var(--radius)] border border-black dark:border-white" : "rounded-full"
                                                                    )}>
                                                                        {sale.origin === 'car_rental'
                                                                            ? t('revenue.filters.origins.carRental')
                                                                            : sale.origin === 'travel_transportation'
                                                                                ? t('travelTransportation.title')
                                                                                : formatOriginLabel(sale.origin, (sale as any)._sourceChannel ?? null)}
                                                                    </span>
                                                                    {loanIndicator && (
                                                                        <Tooltip>
                                                                            <TooltipTrigger asChild>
                                                                                {loanIndicator.loan ? (
                                                                                    <button
                                                                                        type="button"
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation()
                                                                                            setLocation(getLoanDetailsPath(loanIndicator.loan!, loanIndicator.loan!.id))
                                                                                        }}
                                                                                        className={cn(
                                                                                            "px-2 py-0.5 text-[9px] font-bold uppercase transition-colors hover:brightness-95",
                                                                                            getLoanStatusChipClass(loanIndicator.status, style === 'neo-orange')
                                                                                        )}
                                                                                    >
                                                                                        {loanIndicator.label}
                                                                                    </button>
                                                                                ) : (
                                                                                    <span
                                                                                        className={cn(
                                                                                            "px-2 py-0.5 text-[9px] font-bold uppercase",
                                                                                            getLoanStatusChipClass(loanIndicator.status, style === 'neo-orange')
                                                                                        )}
                                                                                    >
                                                                                        {loanIndicator.label}
                                                                                    </span>
                                                                                )}
                                                                            </TooltipTrigger>
                                                                            <TooltipContent className="text-xs">
                                                                                {loanIndicator.tooltipText}
                                                                            </TooltipContent>
                                                                        </Tooltip>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="text-sm font-bold text-foreground/80">
                                                                {t('sales.cashier')}: {sale.cashier_id ? (
                                                                    <button
                                                                        type="button"
                                                                        className="text-primary font-black hover:underline cursor-pointer"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation()
                                                                            setProfileCardUserId(sale.cashier_id)
                                                                            setProfileCardOpen(true)
                                                                        }}
                                                                    >
                                                                        {sale.cashier_name}
                                                                    </button>
                                                                ) : (
                                                                    <span className="text-primary font-black">{sale.cashier_name}</span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="text-right">
                                                            <div className="text-xl font-black text-primary leading-none">
                                                                {formatCurrency(getSalesHistoryRowTotal(sale), sale.settlement_currency || 'usd', features.iqd_display_preference)}
                                                            </div>
                                                            <div className="text-[10px] font-bold text-primary/40 uppercase tracking-widest mt-1">
                                                                {sale.settlement_currency || 'usd'}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div
                                                        className="flex items-center justify-between pt-3 border-t border-border/50 gap-2"
                                                        data-tour-id={isTutorialSale ? 'tutorial-sales-sale-actions' : undefined}
                                                    >
                                                        <div className="flex gap-2">
                                                            <Button
                                                                variant="secondary"
                                                                size="sm"
                                                                allowViewer={true}
                                                                className={cn(
                                                                    "h-10 px-4 font-bold flex gap-2",
                                                                    style === 'neo-orange' ? "rounded-[var(--radius)] neo-border shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]" : "rounded-xl"
                                                                )}
                                                                onClick={() => {
                                                                    const externalPath = getExternalSaleDetailsPath(sale)
                                                                    if (externalPath) {
                                                                        setLocation(externalPath)
                                                                    } else {
                                                                        setSelectedSale(sale)
                                                                    }
                                                                }}
                                                                >
                                                                    <Eye className="w-4 h-4" />
                                                                    {t('common.view')}
                                                                </Button>
                                                                {!getExternalSaleDetailsPath(sale) && (
                                                                <Button
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className={cn(
                                                                        "h-10 w-10",
                                                                        style === 'neo-orange' ? "rounded-[var(--radius)] neo-border shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]" : "rounded-xl"
                                                                    )}
                                                                    onClick={() => onPrintClick(sale)}
                                                                >
                                                                    <Printer className="w-4 h-4" />
                                                                </Button>
                                                            )}
                                                            {!getExternalSaleDetailsPath(sale) && (sale.notes || user?.role !== 'viewer') && (
                                                                <Button
                                                                    variant="outline"
                                                                    size="icon"
                                                                    className={cn(
                                                                        "h-10 w-10",
                                                                        style === 'neo-orange' ? "rounded-[var(--radius)] neo-border shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]" : "rounded-xl",
                                                                        sale.notes && "text-primary bg-primary/5 border-primary/20"
                                                                    )}
                                                                    onClick={() => {
                                                                        setSelectedSaleForNote(sale)
                                                                        setIsNoteModalOpen(true)
                                                                    }}
                                                                >
                                                                    <StickyNote className={cn("w-4 h-4", sale.notes && "fill-primary/20")} />
                                                                </Button>
                                                            )}
                                                        </div>
                                                        <div className="flex gap-1">
                                                            {!isFullyReturned && !getExternalSaleDetailsPath(sale) && (user?.role === 'admin' || user?.role === 'staff') && (
                                                                <Button
                                                                    data-tour-id={isTutorialSale ? 'tutorial-return-sale-action' : undefined}
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className={cn(
                                                                        "h-10 w-10 text-orange-600 hover:bg-orange-50",
                                                                        style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-orange-600 shadow-[2px_2px_0px_0px_rgba(234,88,12,0.5)]" : "rounded-xl"
                                                                    )}
                                                                    onClick={() => openSaleReturnAction(sale)}
                                                                >
                                                                    <RotateCcw className="w-4 h-4" />
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </ContextMenuTrigger>
                                            <ContextMenuContent>
                                                <ContextMenuLabel className="font-mono text-xs text-primary text-center">
                                                    {sale.sequenceId || (sale.origin === 'activities' && (sale as Sale & { _transactionNo?: string | null })._transactionNo) ? (
                                                        <span>{getSaleReferenceLabel(sale)}</span>
                                                    ) : (
                                                        <span>{getSaleReferenceLabel(sale)}</span>
                                                    )}
                                                </ContextMenuLabel>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem
                                                    className="gap-2"
                                                    onSelect={() => {
                                                        const externalPath = getExternalSaleDetailsPath(sale)
                                                        if (externalPath) {
                                                            setLocation(externalPath)
                                                        } else {
                                                            setSelectedSale(sale)
                                                        }
                                                    }}
                                                >
                                                    <Eye className="w-4 h-4" />
                                                    {t('common.view') || 'View Details'}
                                                </ContextMenuItem>
                                                {!getExternalSaleDetailsPath(sale) && (
                                                    <ContextMenuItem
                                                        className="gap-2"
                                                        onSelect={() => onPrintClick(sale)}
                                                    >
                                                        <Printer className="w-4 h-4" />
                                                        {t('common.print') || 'Print'}
                                                    </ContextMenuItem>
                                                )}
                                                {!isFullyReturned && !getExternalSaleDetailsPath(sale) && (user?.role === 'admin' || user?.role === 'staff') && (
                                                    <ContextMenuItem
                                                        className="gap-2"
                                                        onSelect={() => openSaleReturnAction(sale)}
                                                    >
                                                        <RotateCcw className="w-4 h-4 text-orange-600" />
                                                        {t('sales.return.confirmTitle')}
                                                    </ContextMenuItem>
                                                )}
                                                {!getExternalSaleDetailsPath(sale) && (
                                                    <ContextMenuItem
                                                        className="gap-2"
                                                        onSelect={() => {
                                                            setSelectedSaleForNote(sale)
                                                            setIsNoteModalOpen(true)
                                                        }}
                                                    >
                                                        <StickyNote className="w-4 h-4" />
                                                        {sale.notes ? (t('sales.notes.viewNote') || 'View Notes..') : (t('sales.notes.addNote') || 'Add Note')}
                                                    </ContextMenuItem>
                                                )}
                                                {features.allow_whatsapp && (
                                                    <ContextMenuItem
                                                        className="gap-2"
                                                        onSelect={() => {
                                                            setSaleForWhatsApp(sale)
                                                            setShowWhatsAppModal(true)
                                                        }}
                                                    >
                                                        <MessageCircle className="w-4 h-4 text-emerald-600" />
                                                        {t('sales.share.whatsapp')}
                                                    </ContextMenuItem>
                                                )}
                                            </ContextMenuContent>
                                        </ContextMenu>
                                    )
                                })}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-[80px]">{t('sales.id') || '#'}</TableHead>
                                        <TableHead
                                            className="text-start cursor-pointer select-none group/sort"
                                            onClick={() => {
                                                setFilters(prev => ({
                                                    ...prev,
                                                    sort: prev.sort === 'date_asc' ? 'date_desc' : 'date_asc'
                                                }))
                                            }}
                                        >
                                            <span className="inline-flex items-center gap-1.5">
                                                {t('sales.date') || 'Date'}
                                                {filters.sort === 'date_asc' ? (
                                                    <ArrowUp className="w-3.5 h-3.5 text-primary" />
                                                ) : filters.sort === 'date_desc' ? (
                                                    <ArrowDown className="w-3.5 h-3.5 text-primary" />
                                                ) : (
                                                    <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover/sort:opacity-100 transition-opacity" />
                                                )}
                                            </span>
                                        </TableHead>
                                        <TableHead
                                            className="text-start cursor-pointer select-none group/sort"
                                            onClick={() => {
                                                setFilters(prev => ({
                                                    ...prev,
                                                    sort: prev.sort === 'cashier_asc' ? 'cashier_desc' : 'cashier_asc'
                                                }))
                                            }}
                                        >
                                            <span className="inline-flex items-center gap-1.5">
                                                {t('sales.cashier') || 'Cashier'}
                                                {filters.sort === 'cashier_asc' ? (
                                                    <ArrowUp className="w-3.5 h-3.5 text-primary" />
                                                ) : filters.sort === 'cashier_desc' ? (
                                                    <ArrowDown className="w-3.5 h-3.5 text-primary" />
                                                ) : (
                                                    <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover/sort:opacity-100 transition-opacity" />
                                                )}
                                            </span>
                                        </TableHead>
                                        <TableHead
                                            className="text-start cursor-pointer select-none group/sort"
                                            onClick={() => {
                                                setFilters(prev => ({
                                                    ...prev,
                                                    sort: prev.sort === 'origin_asc' ? 'origin_desc' : 'origin_asc'
                                                }))
                                            }}
                                        >
                                            <span className="inline-flex items-center gap-1.5">
                                                {t('sales.origin') || 'Origin'}
                                                {filters.sort === 'origin_asc' ? (
                                                    <ArrowUp className="w-3.5 h-3.5 text-primary" />
                                                ) : filters.sort === 'origin_desc' ? (
                                                    <ArrowDown className="w-3.5 h-3.5 text-primary" />
                                                ) : (
                                                    <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover/sort:opacity-100 transition-opacity" />
                                                )}
                                            </span>
                                        </TableHead>
                                        <TableHead className="text-start">{t('sales.notes.title') || 'Notes'}</TableHead>
                                        <TableHead
                                            className="text-end cursor-pointer select-none group/sort"
                                            onClick={() => {
                                                setFilters(prev => ({
                                                    ...prev,
                                                    sort: prev.sort === 'amount_asc' ? 'amount_desc' : 'amount_asc'
                                                }))
                                            }}
                                        >
                                            <span className="inline-flex items-center gap-1.5 justify-end">
                                                {t('sales.total') || 'Total'}
                                                {filters.sort === 'amount_asc' ? (
                                                    <ArrowUp className="w-3.5 h-3.5 text-primary" />
                                                ) : filters.sort === 'amount_desc' ? (
                                                    <ArrowDown className="w-3.5 h-3.5 text-primary" />
                                                ) : (
                                                    <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover/sort:opacity-100 transition-opacity" />
                                                )}
                                            </span>
                                        </TableHead>
                                        <TableHead className="text-end">{t('common.actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {sales.map((sale) => {
                                        const { isFullyReturned, hasAnyReturn, totalReturnedQuantity } = getSaleReturnState(sale)
                                        const loanIndicator = getLoanIndicator(sale)
                                        const hasProductExchange = (sale.product_exchanges || []).some((exchange: { status?: string }) => exchange.status === 'posted')
                                        const isTutorialSale = tutorialSaleId === sale.id

                                        return (
                                            <ContextMenu
                                                key={sale.id}
                                            >
                                                <ContextMenuTrigger asChild>
                                                    <TableRow
                                                        data-tour-id={isTutorialSale ? 'tutorial-sales-created-sale' : undefined}
                                                        className={isFullyReturned ? 'bg-destructive/10 border-destructive/20' : hasAnyReturn ? 'bg-orange-500/10 border-orange-500/20 dark:bg-orange-500/5 dark:border-orange-500/10' : ''}
                                                    >
                                                        <TableCell className="font-mono text-sm font-bold text-primary">
                                                            {sale.sequenceId || (sale.origin === 'activities' && (sale as Sale & { _transactionNo?: string | null })._transactionNo) ? (
                                                                <span>{getSaleReferenceLabel(sale)}</span>
                                                            ) : (
                                                                <span className="text-muted-foreground/40 text-xs">{getSaleReferenceLabel(sale)}</span>
                                                            )}
                                                        </TableCell>
                                                        <TableCell className="text-start font-mono text-sm" data-tour-id={isTutorialSale ? 'tutorial-sales-sale-fields' : undefined}>
                                                            <div className="flex flex-col gap-1">
                                                                <span className="text-muted-foreground">
                                                                    {formatDateTime(sale.created_at)}
                                                                </span>
                                                                <div className="flex items-center gap-2">
                                                                    {isFullyReturned && (
                                                                        <span className={cn(
                                                                            "px-2 py-0.5 text-[10px] font-bold bg-destructive/20 text-destructive dark:bg-destructive/30 dark:text-destructive-foreground border border-destructive/30",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )}
                                                                            data-tour-id={isTutorialSale ? 'tutorial-returned-status' : undefined}
                                                                        >
                                                                            {(t('sales.return.returnedStatus') || 'RETURNED').toUpperCase()}
                                                                        </span>
                                                                    )}
                                                                    {sale.system_review_status === 'flagged' && (
                                                                        <span className={cn(
                                                                            "px-2 py-0.5 text-[10px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400 border border-orange-200 dark:border-orange-500/30 flex items-center gap-1",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )} title={sale.system_review_reason || ''}>
                                                                            ⚠️ {(t('sales.flagged') || 'FLAGGED').toUpperCase()}
                                                                        </span>
                                                                    )}
                                                                    {hasAnyReturn && !isFullyReturned && (
                                                                        <div className={cn(
                                                                            "inline-flex items-center px-2.5 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-400 border border-orange-200 dark:border-orange-500/30",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )}>
                                                                            {totalReturnedQuantity > 0
                                                                                ? <>-{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}</>
                                                                                : (t('sales.return.partialReturn') || 'PARTIALLY RETURNED')}
                                                                        </div>
                                                                    )}
                                                                    {hasProductExchange && (
                                                                        <span className={cn(
                                                                            "px-2 py-0.5 text-[10px] font-bold bg-primary/10 text-primary border border-primary/20 uppercase",
                                                                            style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                        )}>
                                                                            {t('sales.exchange.badge', { defaultValue: 'EXCHANGED' })}
                                                                        </span>
                                                                    )}
                                                                    {loanIndicator && (
                                                                        <Tooltip>
                                                                            <TooltipTrigger asChild>
                                                                                {loanIndicator.loan ? (
                                                                                    <button
                                                                                        type="button"
                                                                                        onClick={(e) => {
                                                                                            e.stopPropagation()
                                                                                            setLocation(getLoanDetailsPath(loanIndicator.loan!, loanIndicator.loan!.id))
                                                                                        }}
                                                                                        className={cn(
                                                                                            "px-2 py-0.5 text-[10px] font-bold uppercase transition-colors hover:brightness-95",
                                                                                            getLoanStatusChipClass(loanIndicator.status, style === 'neo-orange')
                                                                                        )}
                                                                                    >
                                                                                        {loanIndicator.label}
                                                                                    </button>
                                                                                ) : (
                                                                                    <span
                                                                                        className={cn(
                                                                                            "px-2 py-0.5 text-[10px] font-bold uppercase",
                                                                                            getLoanStatusChipClass(loanIndicator.status, style === 'neo-orange')
                                                                                        )}
                                                                                    >
                                                                                        {loanIndicator.label}
                                                                                    </span>
                                                                                )}
                                                                            </TooltipTrigger>
                                                                            <TooltipContent className="text-xs">
                                                                                {loanIndicator.tooltipText}
                                                                            </TooltipContent>
                                                                        </Tooltip>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="text-start">
                                                            {sale.cashier_id ? (
                                                                <button
                                                                    type="button"
                                                                    className="text-primary font-medium hover:underline cursor-pointer"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        setProfileCardUserId(sale.cashier_id)
                                                                        setProfileCardOpen(true)
                                                                    }}
                                                                >
                                                                    {sale.cashier_name}
                                                                </button>
                                                            ) : (
                                                                sale.cashier_name
                                                            )}
                                                        </TableCell>
                                                        <TableCell className="text-start">
                                                            <span className={cn(
                                                                "px-2 py-1 text-xs font-medium bg-secondary text-secondary-foreground uppercase",
                                                                style === 'neo-orange' ? "rounded-[var(--radius)] border border-black dark:border-white" : "rounded-full"
                                                            )}>
                                                                {sale.origin === 'car_rental'
                                                                    ? t('revenue.filters.origins.carRental')
                                                                    : sale.origin === 'travel_transportation'
                                                                        ? t('travelTransportation.title')
                                                                        : formatOriginLabel(sale.origin, (sale as any)._sourceChannel ?? null)}
                                                            </span>
                                                        </TableCell>
                                                        <TableCell className="text-start">
                                                            {!getExternalSaleDetailsPath(sale) && (
                                                                <Button
                                                                    variant="ghost"
                                                                    size="sm"
                                                                    onClick={() => {
                                                                        setSelectedSaleForNote(sale)
                                                                        setIsNoteModalOpen(true)
                                                                    }}
                                                                    className={cn(
                                                                        "text-xs font-medium h-8 px-3 rounded-lg flex items-center gap-2 transition-all",
                                                                        sale.notes
                                                                            ? "bg-primary/5 text-primary hover:bg-primary/10 border border-primary/20"
                                                                            : "text-muted-foreground hover:bg-muted"
                                                                    )}
                                                                >
                                                                    <StickyNote className={cn("w-3.5 h-3.5", sale.notes ? "fill-primary/20" : "")} />
                                                                    {sale.notes ? (t('sales.notes.viewNote') || 'View Notes..') : (user?.role !== 'viewer' && (t('sales.notes.addNote') || 'Add Note'))}
                                                                </Button>
                                                            )}
                                                        </TableCell>

                                                        <TableCell className="text-end font-bold">
                                                            {formatCurrency(getSalesHistoryRowTotal(sale), sale.settlement_currency || 'usd', features.iqd_display_preference)}
                                                        </TableCell>
                                                        <TableCell className="text-end" data-tour-id={isTutorialSale ? 'tutorial-sales-sale-actions' : undefined}>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                allowViewer={true}
                                                                onClick={() => {
                                                                    const externalPath = getExternalSaleDetailsPath(sale)
                                                                    if (externalPath) {
                                                                        setLocation(externalPath)
                                                                    } else {
                                                                        setSelectedSale(sale)
                                                                    }
                                                                }}
                                                                title={t('sales.details') || "View Details"}
                                                            >
                                                                <Eye className="w-4 h-4" />
                                                            </Button>
                                                            {!getExternalSaleDetailsPath(sale) && (
                                                                <>
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        onClick={() => { if (sale.origin === "sales_order") { console.log("order print blocked"); } else { onPrintClick(sale); } }}
                                                                        title={t('common.print') || "Print Receipt"}
                                                                    >
                                                                        <Printer className="w-4 h-4" />
                                                                    </Button>
                                                                    {!sale.is_returned && (user?.role === 'admin' || user?.role === 'staff') && (
                                                                        <Button
                                                                            data-tour-id={isTutorialSale ? 'tutorial-return-sale-action' : undefined}
                                                                            variant="ghost"
                                                                            size="icon"
                                                                            onClick={() => openSaleReturnAction(sale)}
                                                                            title={t('sales.return') || "Return Sale"}
                                                                            className="text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                                                                        >
                                                                            <RotateCcw className="w-4 h-4" />
                                                                        </Button>
                                                                    )}
                                                                </>
                                                            )}
                                                            {/* Return badge moved to date cell */}
                                                        </TableCell>
                                                    </TableRow>
                                                </ContextMenuTrigger>
                                                <ContextMenuContent>
                                                    <ContextMenuLabel className="font-mono text-xs text-primary text-center">
                                                        {sale.sequenceId || (sale.origin === 'activities' && (sale as Sale & { _transactionNo?: string | null })._transactionNo) ? (
                                                            <span>{getSaleReferenceLabel(sale)}</span>
                                                        ) : (
                                                            <span>{getSaleReferenceLabel(sale)}</span>
                                                        )}
                                                    </ContextMenuLabel>
                                                    <ContextMenuSeparator />
                                                    <ContextMenuItem
                                                        className="gap-2"
                                                        onSelect={() => {
                                                            const externalPath = getExternalSaleDetailsPath(sale)
                                                            if (externalPath) {
                                                                setLocation(externalPath)
                                                            } else {
                                                                setSelectedSale(sale)
                                                            }
                                                        }}
                                                    >
                                                        <Eye className="w-4 h-4" />
                                                        {t('common.view') || 'View Details'}
                                                    </ContextMenuItem>
                                                    {!getExternalSaleDetailsPath(sale) && (
                                                        <ContextMenuItem
                                                            className="gap-2"
                                                            onSelect={() => onPrintClick(sale)}
                                                        >
                                                            <Printer className="w-4 h-4" />
                                                            {t('common.print') || 'Print'}
                                                        </ContextMenuItem>
                                                    )}
                                                    {!isFullyReturned && !getExternalSaleDetailsPath(sale) && (user?.role === 'admin' || user?.role === 'staff') && (
                                                        <ContextMenuItem
                                                            className="gap-2"
                                                            onSelect={() => openSaleReturnAction(sale)}
                                                        >
                                                            <RotateCcw className="w-4 h-4 text-orange-600" />
                                                            {t('sales.return.confirmTitle')}
                                                        </ContextMenuItem>
                                                    )}
                                                    {!getExternalSaleDetailsPath(sale) && (
                                                        <ContextMenuItem
                                                            className="gap-2"
                                                            onSelect={() => {
                                                                setSelectedSaleForNote(sale)
                                                                setIsNoteModalOpen(true)
                                                            }}
                                                        >
                                                            <StickyNote className="w-4 h-4" />
                                                            {sale.notes ? (t('sales.notes.viewNote') || 'View Notes..') : (t('sales.notes.addNote') || 'Add Note')}
                                                        </ContextMenuItem>
                                                    )}
                                                    {features.allow_whatsapp && (
                                                        <ContextMenuItem
                                                            className="gap-2"
                                                            onSelect={() => {
                                                                setSaleForWhatsApp(sale)
                                                                setShowWhatsAppModal(true)
                                                            }}
                                                        >
                                                            <MessageCircle className="w-4 h-4 text-emerald-600" />
                                                            {t('sales.share.whatsapp') || 'Share to WhatsApp'}
                                                        </ContextMenuItem>
                                                    )}
                                                </ContextMenuContent>
                                            </ContextMenu>
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
                    onReturnItem={handleReturnItem}
                    onExchangeItem={handleProductExchangeFromDetails}
                    onReturnSale={handleReturnSale}
                    onDownloadInvoice={onPrintClick}
                />

                <SaleReturnActionDialog
                    isOpen={!!saleForReturnAction}
                    onClose={() => setSaleForReturnAction(null)}
                    onReturnSale={() => {
                        if (saleForReturnAction) {
                            handleReturnSale(saleForReturnAction)
                        }
                    }}
                    onProductExchange={() => {
                        if (saleForReturnAction) {
                            setLockedProductExchangeSaleItemId(null)
                            setSaleForProductExchange(saleForReturnAction)
                        }
                    }}
                />

                <ProductExchangeModal
                    isOpen={!!saleForProductExchange}
                    onClose={() => {
                        setSaleForProductExchange(null)
                        setLockedProductExchangeSaleItemId(null)
                    }}
                    saleItems={productExchangeSaleItems}
                    storages={storages}
                    productCatalog={products}
                    replacementProducts={productExchangeReplacementProducts}
                    settlementCurrency={saleForProductExchange?.settlement_currency || 'usd'}
                    workspaceId={user?.workspaceId || ''}
                    lockedSaleItemId={lockedProductExchangeSaleItemId}
                    resolvePriceBookReplacementAmount={resolvePriceBookReplacementAmount}
                    isSubmitting={isSubmittingProductExchange}
                    onSubmit={handleProductExchangeSubmit}
                />

                {/* Return Decline Modal */}
                <ReturnDeclineModal
                    isOpen={showDeclineModal}
                    onClose={() => {
                        setShowDeclineModal(false)
                        setFilteredReturnItems([])
                        setSaleToReturn(null)
                    }}
                    products={nonReturnableProducts}
                    returnableProducts={filteredReturnItems.map(item => item.product?.name || item.product_name || 'Product')}
                    onContinue={filteredReturnItems.length > 0 ? () => {
                        if (saleToReturn) {
                            finalizeReturn(saleToReturn, filteredReturnItems, isWholeSaleReturn, true)
                        }
                    } : undefined}
                />

                {/* Return Rules Sequence */}
                {rulesQueue.length > 0 && currentRuleIndex >= 0 && (
                    <ReturnRulesDisplayModal
                        isOpen={true}
                        onClose={handleCancelRules}
                        productName={rulesQueue[currentRuleIndex].productName}
                        rules={rulesQueue[currentRuleIndex].rules}
                        isLast={currentRuleIndex === rulesQueue.length - 1}
                        onContinue={handleNextRule}
                        onBack={handleBackRule}
                        showBack={currentRuleIndex > 0}
                    />
                )}

                {/* Return Confirmation Modal */}
                <ReturnConfirmationModal
                    isOpen={returnModalOpen}
                    onClose={() => {
                        setReturnModalOpen(false)
                        setReturnPaymentAccount(null)
                    }}
                    onConfirm={handleReturnConfirm}
                    title={saleToReturn ? t('sales.return.confirmTitle') || 'Return Sale' : ''}
                    message={saleToReturn ? (t('sales.return.confirmMessage') || 'Are you sure you want to return this sale?') : ''}
                    isItemReturn={saleToReturn?.items?.length === 1 && saleToReturn?.items?.[0]?.quantity > 1 && selectedSale?.items?.filter(i => i.product_id === saleToReturn?.items?.[0]?.product_id).length === 1}
                    maxQuantity={saleToReturn?.items?.[0]?.quantity || 1}
                    itemName={saleToReturn?.items?.[0]?.product_name || ''}
                    workspaceId={user?.workspaceId}
                    paymentAccount={returnPaymentAccount}
                    onPaymentAccountChange={setReturnPaymentAccount}
                    showPaymentAccount={saleToReturn?.origin === 'pos' && saleToReturn.payment_method !== 'loan'}
                    cashDrawerOnly={saleToReturn?.payment_method === 'cash'}
                />

                {/* Sales Note Modal */}
                <SalesNoteModal
                    isOpen={isNoteModalOpen}
                    onClose={() => {
                        setIsNoteModalOpen(false)
                        setSelectedSaleForNote(null)
                    }}
                    sale={selectedSaleForNote}
                    onSave={handleSaveNote}
                />

                {/* Print Preview Modal */}
                <PrintPreviewModal
                    isOpen={showPrintPreview}
                    onClose={() => {
                        setShowPrintPreview(false)
                        setPrintingSale(null)
                        setSaleToPrintSelection(null)
                        setA4Variant('standard')
                        setSalesHistoryPrintVersion('adjusted')
                        setSelectedCustomReceiptTemplate(null)
                        setSelectedCustomA4Template(null)
                        setSelectedNativeA4TemplateKey(null)
                    }}
                    onConfirm={handleConfirmPrint}
                    title={activeCustomTemplate
                        ? getStoredCustomTemplateLabel(activeCustomTemplate)
                        : selectedNativeA4TemplateKey === SALES_HISTORY_ATLAS_STANDARD_RETURN_TEMPLATE_KEY
                            ? t('sales.print.atlasStandardReturn', { defaultValue: 'Sales History Atlas Standard Return' })
                            : selectedNativeA4TemplateKey === SALES_HISTORY_ATLAS_STANDARD_TEMPLATE_KEY
                                ? t('sales.print.atlasStandard', { defaultValue: 'Sales History Atlas Standard' })
                        : shouldUseLoanPrint
                        ? (printFormat === 'receipt'
                            ? (t('sales.print.receipt') || 'Receipt')
                            : (t('loans.printDetails') || 'Loan Details'))
                        : (printFormat === 'a4'
                            ? (a4Variant === 'refund'
                                ? (t('sales.print.a4Refund') || 'A4 Refund Invoice')
                                : (t('sales.print.a4') || 'A4 Invoice'))
                            : (t('sales.print.receipt') || 'Receipt'))}
                    features={features}
                    workspaceName={workspaceName}
                    module="sales"
                    originId={printingSale?.id}
                    pdfData={!shouldUseLoanPrint && !hasActiveCustomTemplate && !hasActiveNativeAtlasStandardTemplate && printingSale ? mapSaleToUniversal(printingSale, { a4Variant }) : undefined}
                    invoiceData={printingSale ? {
                        sequenceId: printingSale.sequenceId,
                        totalAmount: printingSale.total_amount,
                        settlementCurrency: (printingSale.settlement_currency || 'usd') as any,
                        origin: printingSale.origin || 'pos',
                        cashierName: printingSale.cashier_name,
                        createdByName: user?.name || 'Unknown',
                        printFormat: printFormat
                    } : undefined}
                    pdfBuilder={shouldUseLoanPrint
                        ? buildLoanPrintPdf
                        : activePdfBuilder
                            ? activePdfBuilder
                            : undefined}
                    printTemplate={shouldUseLoanPrint
                        ? ({ effectiveId }) => (printFormat === 'receipt'
                            ? renderLoanReceiptTemplate(effectiveId)
                            : renderLoanPrintTemplate(effectiveId))
                        : undefined}
                    templatePreview={activeTemplatePreview}
                    customTemplate={hasActiveCustomTemplate && activeCustomTemplate && activeCustomTarget ? {
                        moduleTypeKey: activeCustomTarget.moduleTypeKey,
                        nativeTemplateKey: activeCustomTarget.nativeTemplateKey,
                        templateId: activeCustomTemplate.id,
                        label: getStoredCustomTemplateLabel(activeCustomTemplate)
                    } : undefined}
                    initialTemplateLayout={hasActiveCustomTemplate ? activeCustomLayout : undefined}
                    enableTemplatePreviewSave={hasActiveCustomTemplate}
                    generateTemplateLayoutBlob={hasActiveCustomTemplate ? activeBuildEditableCustomPdf : undefined}
                    printSelectionOptions={salesPrintSelectionOptions}
                    printSelectionTemplates={salesCustomPrintOptions}
                    onPrintSelection={handlePrintSelection}
                />

                <Dialog open={isFilterDialogOpen} onOpenChange={setIsFilterDialogOpen}>
                    <DialogContent className={cn("top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] w-[calc(100vw-0.75rem)] max-w-4xl overflow-hidden p-0 sm:w-[calc(100vw-2rem)]", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]" : "rounded-[2rem] border-border/60")}>
                        <div className="flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] flex-col">
                            <DialogHeader className={cn("border-b border-border/60 px-6 py-5 text-start", style === 'neo-orange' ? "bg-neo-blue/10" : "bg-gradient-to-r from-primary/8 via-background to-emerald-500/5")}>
                                <DialogTitle className="flex items-center gap-3 text-xl font-black tracking-tight">
                                    <div className={cn("p-2.5", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white bg-white text-black" : "rounded-2xl bg-primary/10 text-primary")}>
                                        <SlidersHorizontal className="h-5 w-5" />
                                    </div>
                                    {t('sales.filters.dialogTitle', { defaultValue: 'Sales Filters' })}
                                </DialogTitle>
                                <DialogDescription className="max-w-3xl">
                                    {t('sales.filters.dialogDescription', { defaultValue: 'Refine the sales history with a richer filter set.' })}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
                                <section className="grid gap-4 lg:grid-cols-2">
                                    <div className={cn("space-y-4 p-5", style === 'neo-orange' ? "border-2 border-black dark:border-white rounded-none bg-white dark:bg-black" : "rounded-[1.5rem] border border-border/60 bg-background/80")}>
                                        <div className="space-y-1">
                                            <h3 className="text-base font-black tracking-tight">{t('sales.filters.searchTitle', { defaultValue: 'Search & Sort' })}</h3>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('sales.filters.keywordSearch', { defaultValue: 'Keyword Search' })}</Label>
                                            <div className="relative">
                                                <Search className="pointer-events-none absolute start-3 top-3.5 h-4 w-4 text-muted-foreground" />
                                                <Input
                                                    value={draftFilters.search}
                                                    onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
                                                    placeholder={t('sales.filters.searchPlaceholder', { defaultValue: 'Search ID, invoice, name...' })}
                                                    className="ps-9"
                                                />
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('sales.filters.productSku', { defaultValue: 'Product SKU' })}</Label>
                                            <Input
                                                value={draftFilters.productSku}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, productSku: event.target.value }))}
                                                placeholder={t('sales.filters.productSkuPlaceholder', { defaultValue: 'Search by product SKU...' })}
                                            />
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('sales.filters.sortBy', { defaultValue: 'Sort By' })}</Label>
                                            <Select value={draftFilters.sort} onValueChange={(value: SalesSortOption) => setDraftFilters((current) => ({ ...current, sort: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="date_desc">{t('sales.filters.sortDateDesc', { defaultValue: 'Date: Newest First' })}</SelectItem>
                                                    <SelectItem value="date_asc">{t('sales.filters.sortDateAsc', { defaultValue: 'Date: Oldest First' })}</SelectItem>
                                                    <SelectItem value="amount_desc">{t('sales.filters.sortAmountDesc', { defaultValue: 'Amount: Highest First' })}</SelectItem>
                                                    <SelectItem value="amount_asc">{t('sales.filters.sortAmountAsc', { defaultValue: 'Amount: Lowest First' })}</SelectItem>
                                                    <SelectItem value="cashier_asc">{t('sales.filters.sortCashierAsc', { defaultValue: 'Cashier: A → Z' })}</SelectItem>
                                                    <SelectItem value="cashier_desc">{t('sales.filters.sortCashierDesc', { defaultValue: 'Cashier: Z → A' })}</SelectItem>
                                                    <SelectItem value="origin_asc">{t('sales.filters.sortOriginAsc', { defaultValue: 'Origin: A → Z' })}</SelectItem>
                                                    <SelectItem value="origin_desc">{t('sales.filters.sortOriginDesc', { defaultValue: 'Origin: Z → A' })}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('sales.filters.cashier', { defaultValue: 'Cashier' })}</Label>
                                            <Select value={draftFilters.cashier} onValueChange={(value) => setDraftFilters((current) => ({ ...current, cashier: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">{t('sales.filters.allCashiers', { defaultValue: 'All Cashiers' })}</SelectItem>
                                                    {availableCashiers.map((cashier) => (
                                                        <SelectItem key={cashier.id} value={cashier.id}>
                                                            {cashier.name || 'Unknown'}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className={cn("space-y-4 p-5", style === 'neo-orange' ? "border-2 border-black dark:border-white rounded-none bg-white dark:bg-black" : "rounded-[1.5rem] border border-border/60 bg-background/80")}>
                                        <div className="space-y-1">
                                            <h3 className="text-base font-black tracking-tight">{t('sales.filters.detailsTitle', { defaultValue: 'Currency, Method & Amount' })}</h3>
                                        </div>

                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <div className="space-y-2">
                                                <Label>{t('sales.filters.currency', { defaultValue: 'Currency' })}</Label>
                                                <Select value={draftFilters.currency} onValueChange={(value) => setDraftFilters((current) => ({ ...current, currency: value }))}>
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="all">{t('sales.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                        {currencyOptions.map((curr) => (
                                                            <SelectItem key={curr} value={curr}>{curr.toUpperCase()}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-2">
                                                <Label>{t('sales.filters.origin', { defaultValue: 'Source / Origin' })}</Label>
                                                <Select value={draftFilters.origin} onValueChange={(value) => setDraftFilters((current) => ({ ...current, origin: value }))}>
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="all">{t('sales.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                        {originOptions.map((o) => (
                                                            <SelectItem key={o} value={o}>{String(o).toUpperCase().replace(/_/g, ' ')}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('sales.filters.storage', { defaultValue: 'Storage' })}</Label>
                                            <Select value={draftFilters.storage} onValueChange={(value) => setDraftFilters((current) => ({ ...current, storage: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">{t('sales.filters.allStorages', { defaultValue: 'All Storages' })}</SelectItem>
                                                    {storages.map((storage) => (
                                                        <SelectItem key={storage.id} value={storage.id}>{storage.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('sales.filters.paymentMethod', { defaultValue: 'Payment Method' })}</Label>
                                            <Select value={draftFilters.paymentMethod} onValueChange={(value) => setDraftFilters((current) => ({ ...current, paymentMethod: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">{t('sales.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                    {paymentMethodOptions.map((method) => (
                                                        <SelectItem key={method} value={method}>{method.toUpperCase().replace('_', ' ')}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>{t('sales.filters.returnStatus', { defaultValue: 'Return Status' })}</Label>
                                            <Select value={draftFilters.returnStatus} onValueChange={(value) => setDraftFilters((current) => ({ ...current, returnStatus: value }))}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">{t('sales.filters.all', { defaultValue: 'All' })}</SelectItem>
                                                    <SelectItem value="returned">{t('sales.filters.returned', { defaultValue: 'Returned' })}</SelectItem>
                                                    <SelectItem value="non-returned">{t('sales.filters.nonReturned', { defaultValue: 'Non-Returned' })}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <div className="space-y-2">
                                                <Label>{t('sales.filters.minAmount', { defaultValue: 'Min Amount' })}</Label>
                                                <Input
                                                    type="number"
                                                    min="0"
                                                    value={draftFilters.minAmount}
                                                    onChange={(event) => setDraftFilters((current) => ({ ...current, minAmount: event.target.value }))}
                                                    placeholder="0"
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label>{t('sales.filters.maxAmount', { defaultValue: 'Max Amount' })}</Label>
                                                <Input
                                                    type="number"
                                                    min="0"
                                                    value={draftFilters.maxAmount}
                                                    onChange={(event) => setDraftFilters((current) => ({ ...current, maxAmount: event.target.value }))}
                                                    placeholder={t('sales.filters.noCap', { defaultValue: 'No cap' })}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </section>
                            </div>

                            <DialogFooter className="border-t border-border/60 bg-background/95 px-6 py-4 sm:justify-between">
                                <Button type="button" variant="ghost" onClick={() => setDraftFilters(DEFAULT_SALES_FILTERS)} className={cn(style === 'neo-orange' ? "rounded-none" : "rounded-2xl")}>
                                    <RotateCcw className="me-2 h-4 w-4" />
                                    {t('sales.filters.reset', { defaultValue: 'Reset Draft' })}
                                </Button>
                                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                                    <Button type="button" variant="outline" onClick={() => setIsFilterDialogOpen(false)} className={cn(style === 'neo-orange' ? "rounded-none" : "rounded-2xl")}>
                                        {t('common.cancel', { defaultValue: 'Cancel' })}
                                    </Button>
                                    <Button type="button" onClick={handleApplyFilters} className={cn(style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-y-[2px]" : "rounded-2xl")}>
                                        {t('sales.filters.apply', { defaultValue: 'Apply Filters' })}
                                    </Button>
                                </div>
                            </DialogFooter>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <WhatsAppNumberInputModal
                isOpen={showWhatsAppModal}
                onClose={() => {
                    setShowWhatsAppModal(false)
                    setSaleForWhatsApp(null)
                }}
                onConfirm={handleShareOnWhatsApp}
            />

            <ProfileCardModal
                open={profileCardOpen}
                onOpenChange={setProfileCardOpen}
                userId={profileCardUserId}
            />
        </TooltipProvider>
    )
}





