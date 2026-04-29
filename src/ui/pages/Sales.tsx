import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { Sale } from '@/types'
import { mapSaleToUniversal } from '@/lib/mappings'
import { clearPendingSaleDetailsId, readPendingSaleDetailsId } from '@/lib/saleNavigation'
import { formatCurrency, formatDateTime, formatCompactDateTime, formatDate, formatOriginLabel, cn } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { getLoanDetailsPath } from '@/lib/loanPresentation'
import { getRetriableActionToast, isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'

import { adjustInventoryQuantity, db, resolveReturnStorageId, useLoanBySaleId, useLoanInstallments, useLoanPayments, useLoans, useSales, useSalesOrders, useTravelAgencySales, toUISale, toUISaleFromOrder, toUISaleFromTravelAgency, type Loan } from '@/local-db'
import { useWorkspace } from '@/workspace'
import { isMobile } from '@/lib/platform'
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
    ReturnConfirmationModal,
    ReturnDeclineModal,
    ReturnRulesDisplayModal,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    PrintSelectionModal,
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
    Label
} from '@/ui/components'
import { LoanDetailsPrintTemplate, LoanReceiptPrintTemplate } from '@/ui/components/loans/LoanPrintTemplates'
import { SaleItem } from '@/types'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
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
    Search
} from 'lucide-react'

export type SalesSortOption = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'

export interface SalesFilterState {
    search: string
    currency: string
    paymentMethod: string
    cashier: string
    origin: string
    minAmount: string
    maxAmount: string
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
        filters.sort !== 'date_desc'
    ].filter(Boolean).length
}

type EffectiveLoanStatus = 'pending' | 'active' | 'overdue' | 'completed'

function resolveEffectiveLoanStatus(loan: Loan | undefined): EffectiveLoanStatus {
    if (!loan) return 'pending'
    if (loan.balanceAmount <= 0) return 'completed'
    const today = new Date().toISOString().slice(0, 10)
    if (loan.nextDueDate && loan.nextDueDate < today) return 'overdue'
    return 'active'
}

function getLoanStatusChipClass(status: EffectiveLoanStatus, neoStyle: boolean): string {
    const base = neoStyle ? "rounded-[var(--radius)]" : "rounded-full"
    if (status === 'overdue') return `${base} bg-destructive/10 text-destructive border border-destructive/20`
    if (status === 'completed') return `${base} bg-blue-500/10 text-blue-600 dark:text-blue-300 border border-blue-500/20`
    if (status === 'active') return `${base} bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/20`
    return `${base} bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/20`
}

function getLoanStatusLabelKey(status: EffectiveLoanStatus): string {
    if (status === 'active') return 'sales.loanActive'
    if (status === 'overdue') return 'sales.loanOverdue'
    if (status === 'completed') return 'sales.loanCompleted'
    return 'sales.loanPending'
}

function getLoanStatusFallbackLabel(status: EffectiveLoanStatus): string {
    if (status === 'active') return 'Loan Active'
    if (status === 'overdue') return 'Loan Overdue'
    if (status === 'completed') return 'Loan Completed'
    return 'Loan Pending'
}

function saleHasAnyReturnActivity(sale: Sale): boolean {
    if (sale.is_returned) return true
    return (sale.items || []).some(item => item.is_returned || (item.returned_quantity || 0) > 0)
}

export function Sales() {
    const { user } = useAuth()
    const { t, i18n } = useTranslation()
    const [, setLocation] = useLocation()
    const { features, workspaceName, activeWorkspace, isLocalMode } = useWorkspace()
    const { style } = useTheme()
    const { toast } = useToast()
    const rawSales = useSales(user?.workspaceId)
    const rawOrders = useSalesOrders(user?.workspaceId)
    const rawTravelSales = useTravelAgencySales(user?.workspaceId)

    const loans = useLoans(user?.workspaceId)
    const allSales = useMemo(() => {
        const sales = (rawSales || []).map(toUISale)
        const orders = (rawOrders || [])
            .filter(order => !order.isDeleted && order.status === 'completed')
            .map(toUISaleFromOrder)
        const travelSales = (rawTravelSales || [])
            .filter(sale => !sale.isDeleted && sale.isPaid)
            .map(toUISaleFromTravelAgency)
        return [...sales, ...orders, ...travelSales]
    }, [rawSales, rawOrders, rawTravelSales])

    const isLoading = rawSales === undefined || rawOrders === undefined || rawTravelSales === undefined

    const [selectedSale, setSelectedSale] = useState<Sale | null>(null)
    const [printingSale, setPrintingSale] = useState<Sale | null>(null)
    const [returnModalOpen, setReturnModalOpen] = useState(false)
    const [saleToReturn, setSaleToReturn] = useState<Sale | null>(null)
    const { dateRange, customDates } = useDateRange()
    const [filters, setFilters] = useState<SalesFilterState>(() => {
        const cachedCashier = localStorage.getItem('sales_selected_cashier') || 'all'
        return { ...DEFAULT_SALES_FILTERS, cashier: cachedCashier }
    })
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
    const [draftFilters, setDraftFilters] = useState<SalesFilterState>(filters)
    const [currentPage, setCurrentPage] = useState(1)
    const pageSize = 20

    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('sales_view_mode') as 'table' | 'grid') || 'table'
    })

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
        const now = new Date()

        if (dateRange === 'today') {
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
            result = result.filter(s => new Date(s.created_at) >= startOfDay)
        } else if (dateRange === 'month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
            result = result.filter(s => new Date(s.created_at) >= startOfMonth)
        } else if (dateRange === 'custom' && (customDates.start || customDates.end)) {
            const start = customDates.start ? new Date(customDates.start) : null
            if (start) start.setHours(0, 0, 0, 0)
            const end = customDates.end ? new Date(customDates.end) : null
            if (end) end.setHours(23, 59, 59, 999)
            result = result.filter(s => {
                const d = new Date(s.created_at)
                if (start && d < start) return false
                if (end && d > end) return false
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

            const total = s.total_amount || 0
            if (minAmount !== null && Number.isFinite(minAmount) && total < minAmount) {
                return false
            }
            if (maxAmount !== null && Number.isFinite(maxAmount) && total > maxAmount) {
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
            if (effectiveFilters.sort === 'date_asc') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        })

        return result
    }, [allSales, dateRange, customDates, effectiveFilters])

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

    const getEffectiveTotal = (sale: Sale) => {
        // If the sale itself is marked returned
        if (sale.is_returned) return 0

        // For travel agency sales, we use the total_amount directly as it's pre-calculated from group_revenue or sum of tourists
        if (sale.origin === 'travel_agency') {
            return sale.total_amount
        }

        // If items are present, calculate sum of remaining (non-returned) value
        if (sale.items && sale.items.length > 0) {
            // Check if all items are fully returned (fail-safe)
            const allItemsReturned = sale.items.every(item =>
                item.is_returned || (item.returned_quantity || 0) >= item.quantity
            )
            if (allItemsReturned) return 0

            return sale.items.reduce((sum, item) => {
                const quantity = item.quantity || 0
                const returnedQty = item.returned_quantity || 0
                const remainingQty = Math.max(0, quantity - returnedQty)

                if (remainingQty <= 0) return sum

                // Use converted_unit_price as it's already in the settlement currency
                const unitPrice = item.converted_unit_price || item.unit_price || 0

                return sum + (unitPrice * remainingQty)
            }, 0)
        }

        return sale.total_amount
    }

    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }
        if (dateRange === 'month') {
            const now = new Date()
            return formatLocalizedMonthYear(now, i18n.language)
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
    const [nonReturnableProducts, setNonReturnableProducts] = useState<string[]>([])
    const [filteredReturnItems, setFilteredReturnItems] = useState<SaleItem[]>([])
    const [printFormat, setPrintFormat] = useState<'receipt' | 'a4'>(() => {
        return (localStorage.getItem('sales_print_format') as 'receipt' | 'a4') || 'receipt'
    })
    const [a4Variant, setA4Variant] = useState<'standard' | 'refund'>('standard')
    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
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
            printQuality: features.print_quality
        })
    }, [features.print_quality, printLang, renderLoanPrintTemplate, renderLoanReceiptTemplate])


    useEffect(() => {
        localStorage.setItem('sales_selected_cashier', filters.cashier)
    }, [filters.cashier])

    useEffect(() => {
        localStorage.setItem('sales_print_format', printFormat)
    }, [printFormat])
    const [showPrintModal, setShowPrintModal] = useState(false)
    const [saleToPrintSelection, setSaleToPrintSelection] = useState<Sale | null>(null)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const [isNoteModalOpen, setIsNoteModalOpen] = useState(false)
    const [selectedSaleForNote, setSelectedSaleForNote] = useState<Sale | null>(null)
    const [isExportModalOpen, setIsExportModalOpen] = useState(false)



    const onPrintClick = (sale: Sale) => {
        setSaleToPrintSelection(sale)
        setShowPrintModal(true)
    }

    const handlePrintSelection = (format: 'receipt' | 'a4') => {
        setPrintFormat(format)
        if (format === 'a4' && saleToPrintSelection && saleHasAnyReturnActivity(saleToPrintSelection)) {
            setA4Variant('refund')
        } else {
            setA4Variant('standard')
        }
        setShowPrintModal(false)
        if (saleToPrintSelection) {
            setPrintingSale(saleToPrintSelection)
            setShowPrintPreview(true) // Open preview instead of printing directly
        }
    }

    const handleConfirmPrint = () => {
        // PrintPreviewModal handles PDF rendering/printing internally
        setShowPrintPreview(false)
        setPrintingSale(null)
        setSaleToPrintSelection(null)
        setA4Variant('standard')
    }

    const [isWholeSaleReturn, setIsWholeSaleReturn] = useState(false)

    const finalizeReturn = (sale: Sale, items: SaleItem[], isWholeSale: boolean, isPartial: boolean = false) => {
        const filteredSale = { ...sale, items, _isWholeSaleReturn: isWholeSale, _isPartialReturn: isPartial } as any

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
        const nonReturnableItems = itemsToCheck.filter(item => item.product && item.product.can_be_returned === false)
        const returnableItems = itemsToCheck.filter(item => !item.product || item.product.can_be_returned !== false)

        const nonReturnableNames = nonReturnableItems.map(item => item.product?.name || item.product_name || 'Unknown Product')

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

            return {
                item,
                quantity: quantityToRestore,
                storageId
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

                appliedPlans.push(plan)
            }
        } catch (error) {
            for (const plan of [...appliedPlans].reverse()) {
                try {
                    if (!plan.storageId) {
                        continue
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

        return plans.map((plan) => plan.storageId)
    }, [])

    const handleReturnConfirm = async (reason: string, quantity?: number) => {
        if (!saleToReturn) return

        try {
            let error
            const isPartialReturn = (saleToReturn as any)._isPartialReturn
            const isIndividualItemReturn = saleToReturn?.items?.length === 1 && !(saleToReturn as any)._isWholeSaleReturn && !isPartialReturn
            const isCurrentlyOnline = typeof navigator === 'undefined' ? true : navigator.onLine
            const shouldQueueOfflineReturn = !isLocalMode && !isCurrentlyOnline

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
                    const returnTimestamp = new Date().toISOString()
                    const restoredStorageIds = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: 'local'
                    })
                    const returnValue = itemsToReturn.reduce((sum, item, index) => {
                        const unitPrice = item.converted_unit_price || item.unit_price || 0
                        return sum + (unitPrice * quantities[index])
                    }, 0)

                    const updateSale = (s: Sale) => {
                        if (s.id !== saleToReturn.id) return s
                        const updatedItems = s.items?.map(i => {
                            const returnedIdx = itemIds.indexOf(i.id)
                            if (returnedIdx === -1) return i

                            const q = quantities[returnedIdx]
                            const newReturnedQty = (i.returned_quantity || 0) + q
                            return {
                                ...i,
                                storage_id: restoredStorageIds[returnedIdx] || i.storage_id,
                                returned_quantity: newReturnedQty,
                                is_returned: newReturnedQty >= i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }
                        })

                        return {
                            ...s,
                            total_amount: s.total_amount - returnValue,
                            is_returned: updatedItems?.every(i => i.is_returned) || false,
                            items: updatedItems
                        }
                    }

                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        const updatedSale = updateSale({ ...existingLocal, items: (existingLocal as any)._enrichedItems } as any)
                            ; (existingLocal as any)._enrichedItems = updatedSale.items
                            ; (existingLocal as any).totalAmount = updatedSale.total_amount
                            ; (existingLocal as any).isReturned = updatedSale.is_returned
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
                            storageId: restoredStorageIds[index] || item.storage_id
                        } as any)
                    }))
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                    if (shouldQueueOfflineReturn) {
                        await queueOfflineReturnMutation({
                            __rpc_action: 'return_sale_items',
                            p_sale_item_ids: itemIds,
                            p_return_quantities: quantities,
                            p_return_reason: reason
                        })
                        toast({
                            title: t('sales.return.confirmTitle') || 'Return Sale',
                            description: t('pos.offlineDesc') || 'Sale saved locally and will sync when online.',
                        })
                    }
                } else {
                    const itemsToReturn = saleToReturn.items || []
                    const quantities = itemsToReturn.map((item) => item.quantity - (item.returned_quantity || 0))
                    const returnTimestamp = new Date().toISOString()
                    const restoredStorageIds = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: 'local'
                    })

                    const updateSale = (s: Sale) => {
                        if (s.id !== saleToReturn.id) return s
                        return {
                            ...s,
                            is_returned: true,
                            total_amount: 0,
                            return_reason: reason,
                            returned_at: returnTimestamp,
                            items: s.items?.map((i, index) => ({
                                ...i,
                                storage_id: restoredStorageIds[index] || i.storage_id,
                                is_returned: true,
                                returned_quantity: i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }))
                        }
                    }

                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        ; (existingLocal as any).isReturned = true
                            ; (existingLocal as any).totalAmount = 0
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = returnTimestamp
                            ; (existingLocal as any).updatedAt = returnTimestamp
                        const updatedItems = ((existingLocal as any)._enrichedItems || []).map((i: any, index: number) => ({
                            ...i,
                            storage_id: restoredStorageIds[index] || i.storage_id,
                            is_returned: true,
                            returned_quantity: i.quantity,
                            return_reason: reason,
                            returned_at: returnTimestamp
                        }))
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
                            storageId: restoredStorageIds[index] || item.storage_id
                        } as any)
                    ))
                    if (shouldQueueOfflineReturn) {
                        await queueOfflineReturnMutation({
                            __rpc_action: 'return_whole_sale',
                            p_sale_id: saleToReturn.id,
                            p_return_reason: reason
                        })
                        toast({
                            title: t('sales.return.confirmTitle') || 'Return Sale',
                            description: t('pos.offlineDesc') || 'Sale saved locally and will sync when online.',
                        })
                    }
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

                const { data, error: itemError } = await runSupabaseAction('sales.returnItems', () =>
                    supabase.rpc('return_sale_items', {
                        p_sale_item_ids: itemIds,
                        p_return_quantities: quantities,
                        p_return_reason: reason
                    })
                )
                error = itemError

                if (!error && data?.success) {
                    const returnValue = data.return_value || 0
                    const returnTimestamp = new Date().toISOString()
                    const restoredStorageIds = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: 'remote'
                    })

                    const updateSale = (s: Sale) => {
                        if (s.id !== saleToReturn.id) return s
                        const updatedItems = s.items?.map(i => {
                            const returnedIdx = itemIds.indexOf(i.id)
                            if (returnedIdx === -1) return i

                            const q = quantities[returnedIdx]
                            const newReturnedQty = (i.returned_quantity || 0) + q
                            return {
                                ...i,
                                storage_id: restoredStorageIds[returnedIdx] || i.storage_id,
                                returned_quantity: newReturnedQty,
                                is_returned: newReturnedQty >= i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }
                        })

                        return {
                            ...s,
                            total_amount: s.total_amount - returnValue,
                            is_returned: updatedItems?.every(i => i.is_returned) || false,
                            items: updatedItems
                        }
                    }

                    // Update local-db for instant UI reactivity
                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        const updatedSale = updateSale({ ...existingLocal, items: (existingLocal as any)._enrichedItems } as any)
                            ; (existingLocal as any)._enrichedItems = updatedSale.items
                            ; (existingLocal as any).totalAmount = updatedSale.total_amount
                            ; (existingLocal as any).isReturned = updatedSale.is_returned
                            ; (existingLocal as any).updatedAt = returnTimestamp
                        await db.sales.put(existingLocal)
                    }
                    await Promise.all(itemsToReturn.map((item, index) => {
                        const newReturnedQty = (item.returned_quantity || 0) + quantities[index]
                        return db.sale_items.update(item.id, {
                            returnedQuantity: newReturnedQty,
                            storageId: restoredStorageIds[index] || item.storage_id
                        } as any)
                    }))
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                }
            } else {
                // Whole Sale Return
                const itemsToReturn = saleToReturn.items || []
                const quantities = itemsToReturn.map((item) => item.quantity - (item.returned_quantity || 0))
                const { data, error: saleError } = await runSupabaseAction('sales.returnWhole', () =>
                    supabase.rpc('return_whole_sale', {
                        p_sale_id: saleToReturn.id,
                        p_return_reason: reason
                    })
                )
                error = saleError

                if (!error && data?.success) {
                    const returnTimestamp = new Date().toISOString()
                    const restoredStorageIds = await restoreInventoryForReturn({
                        workspaceId: saleToReturn.workspace_id,
                        items: itemsToReturn,
                        quantities,
                        timestamp: returnTimestamp,
                        syncSource: 'remote'
                    })

                    const updateSale = (s: Sale) => {
                        if (s.id !== saleToReturn.id) return s
                        return {
                            ...s,
                            is_returned: true,
                            total_amount: 0,
                            return_reason: reason,
                            returned_at: returnTimestamp,
                            items: s.items?.map((i, index) => ({
                                ...i,
                                storage_id: restoredStorageIds[index] || i.storage_id,
                                is_returned: true,
                                returned_quantity: i.quantity,
                                return_reason: reason,
                                returned_at: returnTimestamp
                            }))
                        }
                    }

                    // Update local-db for instant UI reactivity
                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        ; (existingLocal as any).isReturned = true
                            ; (existingLocal as any).totalAmount = 0
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = returnTimestamp
                            ; (existingLocal as any).updatedAt = returnTimestamp
                        const updatedItems = ((existingLocal as any)._enrichedItems || []).map((i: any, index: number) => ({
                            ...i,
                            storage_id: restoredStorageIds[index] || i.storage_id,
                            is_returned: true,
                            returned_quantity: i.quantity,
                            return_reason: reason,
                            returned_at: returnTimestamp
                        }))
                            ; (existingLocal as any)._enrichedItems = updatedItems
                        await db.sales.put(existingLocal)
                    }
                    await Promise.all(itemsToReturn.map((item, index) =>
                        db.sale_items.update(item.id, {
                            returnedQuantity: item.quantity,
                            storageId: restoredStorageIds[index] || item.storage_id
                        } as any)
                    ))
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                }
            }

            if (error) throw normalizeSupabaseActionError(error)

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


    return (
        <TooltipProvider>
            <div className="space-y-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-3">
                            <h1 className="text-2xl font-bold flex items-center gap-2">
                                <Receipt className="w-6 h-6 text-primary" />
                                {t('sales.title') || 'Sales History'}
                                {isLoading && (
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
                            {t('sales.subtitle') || 'View past transactions'}
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

                    <div className="flex flex-wrap items-center gap-3">
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
                                className="w-auto"
                            />
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
                        </div>
                    </CardHeader>
                    <CardContent>
                        {isLoading ? (
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
                                    const isFullyReturned = sale.is_returned || (sale.items && sale.items.length > 0 && sale.items.every((item: SaleItem) =>
                                        item.is_returned || (item.returned_quantity || 0) >= item.quantity
                                    ))
                                    const returnedItemsCount = sale.items?.filter((item: SaleItem) => item.is_returned).length || 0
                                    const partialReturnedItemsCount = sale.items?.filter((item: SaleItem) => (item.returned_quantity || 0) > 0 && !item.is_returned).length || 0
                                    const totalReturnedQuantity = sale.items?.reduce((sum: number, item: SaleItem) => {
                                        if (item.is_returned) return sum + (item.quantity || 0)
                                        if ((item.returned_quantity || 0) > 0) return sum + (item.returned_quantity || 0)
                                        return sum
                                    }, 0) || 0
                                    const hasAnyReturn = returnedItemsCount > 0 || partialReturnedItemsCount > 0
                                    const loanIndicator = getLoanIndicator(sale)

                                    return (
                                        <div
                                            key={sale.id}
                                            className={cn(
                                                "p-4 border shadow-sm space-y-4 transition-all active:scale-[0.98]",
                                                style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "rounded-[2rem] md:rounded-2xl border-border",
                                                isFullyReturned ? 'bg-destructive/5 border-destructive/20' : hasAnyReturn ? 'bg-orange-500/5' : 'bg-card'
                                            )}
                                        >
                                            <div className="flex justify-between items-start">
                                                <div className="space-y-2">
                                                    <div className="flex flex-col gap-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
                                                                {formatCompactDateTime(sale.created_at)}
                                                            </span>
                                                            {sale.sequenceId ? (
                                                                <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-primary/10 text-primary rounded border border-primary/20">
                                                                    {sale.origin === 'sales_order' ? ((sale as any).orderNumber || sale._orderNumber || `#${sale.id.slice(0, 8)}`) : `#${String(sale.sequenceId).padStart(5, '0')}`}
                                                                </span>
                                                            ) : (
                                                                <span className="text-[10px] text-muted-foreground/50 font-mono">
                                                                    #{sale.id.slice(0, 8)}
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {isFullyReturned && (
                                                                <span className={cn(
                                                                    "px-2 py-0.5 text-[9px] font-bold bg-destructive/10 text-destructive border border-destructive/20 uppercase",
                                                                    style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                )}>
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
                                                                    -{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}
                                                                </span>
                                                            )}
                                                            <span className={cn(
                                                                "px-2 py-0.5 text-[9px] font-bold bg-secondary text-secondary-foreground uppercase",
                                                                style === 'neo-orange' ? "rounded-[var(--radius)] border border-black dark:border-white" : "rounded-full"
                                                            )}>
                                                                {formatOriginLabel(sale.origin, (sale as any)._sourceChannel ?? null)}
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
                                                        {t('sales.cashier')}: <span className="text-primary font-black">{sale.cashier_name}</span>
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-xl font-black text-primary leading-none">
                                                        {formatCurrency(getEffectiveTotal(sale), sale.settlement_currency || 'usd', features.iqd_display_preference)}
                                                    </div>
                                                    <div className="text-[10px] font-bold text-primary/40 uppercase tracking-widest mt-1">
                                                        {sale.settlement_currency || 'usd'}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center justify-between pt-3 border-t border-border/50 gap-2">
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
                                                            if (sale.origin === 'sales_order') {
                                                                setLocation(`/orders/${sale.id}`)
                                                            } else if (sale.origin === 'travel_agency') {
                                                                setLocation(`/travel-agency/${sale.id}/view`)
                                                            } else {
                                                                setSelectedSale(sale)
                                                            }
                                                        }}
                                                    >
                                                        <Eye className="w-4 h-4" />
                                                        {t('common.view')}
                                                    </Button>
                                                    {sale.origin !== 'sales_order' && sale.origin !== 'travel_agency' && (
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
                                                    {sale.origin !== 'sales_order' && sale.origin !== 'travel_agency' && (sale.notes || user?.role !== 'viewer') && (
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
                                                    {!isFullyReturned && sale.origin !== 'sales_order' && sale.origin !== 'travel_agency' && (user?.role === 'admin' || user?.role === 'staff') && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className={cn(
                                                                "h-10 w-10 text-orange-600 hover:bg-orange-50",
                                                                style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-orange-600 shadow-[2px_2px_0px_0px_rgba(234,88,12,0.5)]" : "rounded-xl"
                                                            )}
                                                            onClick={() => handleReturnSale(sale)}
                                                        >
                                                            <RotateCcw className="w-4 h-4" />
                                                        </Button>
                                                    )}
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
                                        <TableHead className="w-[80px]">{t('sales.id') || '#'}</TableHead>
                                        <TableHead className="text-start">{t('sales.date') || 'Date'}</TableHead>
                                        <TableHead className="text-start">{t('sales.cashier') || 'Cashier'}</TableHead>
                                        <TableHead className="text-start">{t('sales.origin') || 'Origin'}</TableHead>
                                        <TableHead className="text-start">{t('sales.notes.title') || 'Notes'}</TableHead>
                                        <TableHead className="text-end">{t('sales.total') || 'Total'}</TableHead>
                                        <TableHead className="text-end">{t('common.actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {sales.map((sale) => {
                                        const isFullyReturned = sale.is_returned || (sale.items && sale.items.length > 0 && sale.items.every((item: SaleItem) =>
                                            item.is_returned || (item.returned_quantity || 0) >= item.quantity
                                        ))
                                        const returnedItemsCount = sale.items?.filter((item: SaleItem) => item.is_returned).length || 0
                                        const partialReturnedItemsCount = sale.items?.filter((item: SaleItem) => (item.returned_quantity || 0) > 0 && !item.is_returned).length || 0
                                        const totalReturnedQuantity = sale.items?.reduce((sum: number, item: SaleItem) => {
                                            if (item.is_returned) return sum + (item.quantity || 0)
                                            if ((item.returned_quantity || 0) > 0) return sum + (item.returned_quantity || 0)
                                            return sum
                                        }, 0) || 0
                                        const hasAnyReturn = returnedItemsCount > 0 || partialReturnedItemsCount > 0
                                        const loanIndicator = getLoanIndicator(sale)

                                        return (
                                            <TableRow
                                                key={sale.id}
                                                className={isFullyReturned ? 'bg-destructive/10 border-destructive/20' : hasAnyReturn ? 'bg-orange-500/10 border-orange-500/20 dark:bg-orange-500/5 dark:border-orange-500/10' : ''}
                                            >
                                                <TableCell className="font-mono text-sm font-bold text-primary">
                                                    {sale.sequenceId ? (
                                                        <span>{sale.origin === 'sales_order' ? ((sale as any).orderNumber || sale._orderNumber || `#${sale.id.slice(0, 8)}`) : `#${String(sale.sequenceId).padStart(5, '0')}`}</span>
                                                    ) : (
                                                        <span className="text-muted-foreground/40 text-xs">#{sale.id.slice(0, 4)}...</span>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-start font-mono text-sm">
                                                    <div className="flex flex-col gap-1">
                                                        <span className="text-muted-foreground">
                                                            {formatDateTime(sale.created_at)}
                                                        </span>
                                                        <div className="flex items-center gap-2">
                                                            {isFullyReturned && (
                                                                <span className={cn(
                                                                    "px-2 py-0.5 text-[10px] font-bold bg-destructive/20 text-destructive dark:bg-destructive/30 dark:text-destructive-foreground border border-destructive/30",
                                                                    style === 'neo-orange' ? "rounded-[var(--radius)]" : "rounded-full"
                                                                )}>
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
                                                                    -{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}
                                                                </div>
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
                                                    {sale.cashier_name}
                                                </TableCell>
                                                <TableCell className="text-start">
                                                    <span className={cn(
                                                        "px-2 py-1 text-xs font-medium bg-secondary text-secondary-foreground uppercase",
                                                        style === 'neo-orange' ? "rounded-[var(--radius)] border border-black dark:border-white" : "rounded-full"
                                                    )}>
                                                        {formatOriginLabel(sale.origin, (sale as any)._sourceChannel ?? null)}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-start">
                                                    {sale.origin !== 'sales_order' && sale.origin !== 'travel_agency' && (
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
                                                    {formatCurrency(getEffectiveTotal(sale), sale.settlement_currency || 'usd', features.iqd_display_preference)}
                                                </TableCell>
                                                <TableCell className="text-end">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        allowViewer={true}
                                                        onClick={() => {
                                                            if (sale.origin === 'sales_order') {
                                                                setLocation(`/orders/${sale.id}`)
                                                            } else if (sale.origin === 'travel_agency') {
                                                                setLocation(`/travel-agency/${sale.id}/view`)
                                                            } else {
                                                                setSelectedSale(sale)
                                                            }
                                                        }}
                                                        title={t('sales.details') || "View Details"}
                                                    >
                                                        <Eye className="w-4 h-4" />
                                                    </Button>
                                                    {sale.origin !== 'sales_order' && sale.origin !== 'travel_agency' && (
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
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    onClick={() => handleReturnSale(sale)}
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
                    onReturnSale={handleReturnSale}
                    onDownloadInvoice={onPrintClick}
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
                    onClose={() => setReturnModalOpen(false)}
                    onConfirm={handleReturnConfirm}
                    title={saleToReturn ? t('sales.return.confirmTitle') || 'Return Sale' : ''}
                    message={saleToReturn ? (t('sales.return.confirmMessage') || 'Are you sure you want to return this sale?') : ''}
                    isItemReturn={saleToReturn?.items?.length === 1 && saleToReturn?.items?.[0]?.quantity > 1 && selectedSale?.items?.filter(i => i.product_id === saleToReturn?.items?.[0]?.product_id).length === 1}
                    maxQuantity={saleToReturn?.items?.[0]?.quantity || 1}
                    itemName={saleToReturn?.items?.[0]?.product_name || ''}
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

                <ExportPreviewModal
                    isOpen={isExportModalOpen}
                    onClose={() => setIsExportModalOpen(false)}
                    filters={{
                        dateRange,
                        customDates,
                        selectedCashier: filters.cashier
                    }}
                />

                <PrintSelectionModal
                    isOpen={showPrintModal}
                    onClose={() => setShowPrintModal(false)}
                    onSelect={handlePrintSelection}
                    a4Variant={saleToPrintSelection && saleHasAnyReturnActivity(saleToPrintSelection) ? 'refund' : 'standard'}
                />

                {/* Print Preview Modal */}
                <PrintPreviewModal
                    isOpen={showPrintPreview}
                    onClose={() => {
                        setShowPrintPreview(false)
                        setPrintingSale(null)
                        setSaleToPrintSelection(null)
                        setA4Variant('standard')
                    }}
                    onConfirm={handleConfirmPrint}
                    title={shouldUseLoanPrint
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
                    pdfData={!shouldUseLoanPrint && printingSale ? mapSaleToUniversal(printingSale, { a4Variant }) : undefined}
                    invoiceData={printingSale ? {
                        sequenceId: printingSale.sequenceId,
                        totalAmount: printingSale.total_amount,
                        settlementCurrency: (printingSale.settlement_currency || 'usd') as any,
                        origin: printingSale.origin || 'pos',
                        cashierName: printingSale.cashier_name,
                        createdByName: user?.name || 'Unknown',
                        printFormat: printFormat
                    } : undefined}
                    pdfBuilder={shouldUseLoanPrint ? buildLoanPrintPdf : undefined}
                    printTemplate={shouldUseLoanPrint
                        ? ({ effectiveId }) => (printFormat === 'receipt'
                            ? renderLoanReceiptTemplate(effectiveId)
                            : renderLoanPrintTemplate(effectiveId))
                        : undefined}
                />

                <Dialog open={isFilterDialogOpen} onOpenChange={setIsFilterDialogOpen}>
                    <DialogContent className={cn("top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] w-[calc(100vw-0.75rem)] max-w-4xl overflow-hidden p-0 sm:w-[calc(100vw-2rem)]", style === 'neo-orange' ? "rounded-none border-2 border-black dark:border-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]" : "rounded-[2rem] border-border/60")}>
                        <div className="flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] flex-col">
                            <DialogHeader className={cn("border-b border-border/60 px-6 py-5 text-left", style === 'neo-orange' ? "bg-neo-blue/10" : "bg-gradient-to-r from-primary/8 via-background to-emerald-500/5")}>
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
        </TooltipProvider>
    )
}





