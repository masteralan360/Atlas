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

import { db, useLoanBySaleId, useLoanInstallments, useLoanPayments, useLoans, useSales, useSalesOrders, useTravelAgencySales, toUISale, toUISaleFromOrder, toUISaleFromTravelAgency, type Loan } from '@/local-db'
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
    DeleteConfirmationModal,
    PrintPreviewModal,
    SalesNoteModal,
    ExportPreviewModal,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    useToast,
    AppPagination
} from '@/ui/components'
import { LoanDetailsPrintTemplate, LoanReceiptPrintTemplate } from '@/ui/components/loans/LoanPrintTemplates'
import { SaleItem } from '@/types'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
import {
    Receipt,
    Eye,
    Loader2,
    Trash2,
    Printer,
    RotateCcw,
    Filter,
    StickyNote,
    FileSpreadsheet,
    LayoutGrid,
    List
} from 'lucide-react'

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
    const [selectedCashier, setSelectedCashier] = useState<string>(() => {
        return localStorage.getItem('sales_selected_cashier') || 'all'
    })
    const [deleteModalOpen, setDeleteModalOpen] = useState(false)
    const [saleToDelete, setSaleToDelete] = useState<Sale | null>(null)
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

    // Client-side filtering: date range + cashier
    const filteredSales = useMemo(() => {
        let result = allSales
        const now = new Date()

        if (dateRange === 'today') {
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
            result = result.filter(s => new Date(s.created_at) >= startOfDay)
        } else if (dateRange === 'month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
            result = result.filter(s => new Date(s.created_at) >= startOfMonth)
        } else if (dateRange === 'custom' && customDates.start && customDates.end) {
            const start = new Date(customDates.start)
            start.setHours(0, 0, 0, 0)
            const end = new Date(customDates.end)
            end.setHours(23, 59, 59, 999)
            result = result.filter(s => {
                const d = new Date(s.created_at)
                return d >= start && d <= end
            })
        }

        if (selectedCashier !== 'all') {
            result = result.filter(s => s.cashier_id === selectedCashier)
        }

        // Sort by created_at descending
        result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

        return result
    }, [allSales, dateRange, customDates, selectedCashier])

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
            if (sales && sales.length > 0) {
                const dates = sales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            if (customDates.start && customDates.end) {
                return `${t('performance.filters.from')} ${formatDate(customDates.start)} ${t('performance.filters.to')} ${formatDate(customDates.end)}`
            }
        }
        if (dateRange === 'allTime') {
            if (sales && sales.length > 0) {
                const dates = sales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.allTime')}, ${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
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
        localStorage.setItem('sales_selected_cashier', selectedCashier)
    }, [selectedCashier])

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

    const handleDeleteSale = (sale: Sale) => {
        setSaleToDelete(sale)
        setDeleteModalOpen(true)
    }

    const confirmDeleteSale = async () => {
        if (!saleToDelete) return
        try {
            if (!isLocalMode) {
                const { error } = await runSupabaseAction('sales.delete', () =>
                    supabase.rpc('delete_sale', { p_sale_id: saleToDelete.id })
                )
                if (error) throw normalizeSupabaseActionError(error)
            }

            // Update local-db immediately for instant UI feedback
            await db.sales.delete(saleToDelete.id)
            await db.sale_items.where('saleId').equals(saleToDelete.id).delete()

            if (selectedSale?.id === saleToDelete.id) setSelectedSale(null)
            setDeleteModalOpen(false)
            setSaleToDelete(null)
        } catch (err: any) {
            console.error('Error deleting sale:', err)
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
                    description: `Failed to delete sale: ${normalized.message || 'Unknown error'}`,
                    variant: 'destructive'
                })
            }
        }
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

    const handleReturnConfirm = async (reason: string, quantity?: number) => {
        if (!saleToReturn) return

        try {
            let error
            const isPartialReturn = (saleToReturn as any)._isPartialReturn
            const isIndividualItemReturn = saleToReturn?.items?.length === 1 && !(saleToReturn as any)._isWholeSaleReturn && !isPartialReturn

            if (isLocalMode) {
                if (isIndividualItemReturn || isPartialReturn) {
                    const itemsToReturn = saleToReturn.items || []
                    if (itemsToReturn.length === 0) return

                    const itemIds = itemsToReturn.map(i => i.id)
                    const quantities = itemsToReturn.map(i =>
                        quantity && itemsToReturn.length === 1 ? quantity : (i.quantity - (i.returned_quantity || 0))
                    )
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
                                returned_quantity: newReturnedQty,
                                is_returned: newReturnedQty >= i.quantity,
                                return_reason: reason,
                                returned_at: new Date().toISOString()
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
                        await db.sales.put(existingLocal)
                    }
                    await Promise.all(itemsToReturn.map((item, index) => {
                        const newReturnedQty = (item.returned_quantity || 0) + quantities[index]
                        return db.sale_items.update(item.id, {
                            returnedQuantity: newReturnedQty
                        } as any)
                    }))
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                } else {
                    const updateSale = (s: Sale) => {
                        if (s.id !== saleToReturn.id) return s
                        return {
                            ...s,
                            is_returned: true,
                            total_amount: 0,
                            return_reason: reason,
                            returned_at: new Date().toISOString(),
                            items: s.items?.map(i => ({
                                ...i,
                                is_returned: true,
                                returned_quantity: i.quantity,
                                return_reason: reason,
                                returned_at: new Date().toISOString()
                            }))
                        }
                    }

                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        ; (existingLocal as any).isReturned = true
                            ; (existingLocal as any).totalAmount = 0
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = new Date().toISOString()
                        const updatedItems = ((existingLocal as any)._enrichedItems || []).map((i: any) => ({
                            ...i,
                            is_returned: true,
                            returned_quantity: i.quantity,
                            return_reason: reason,
                            returned_at: new Date().toISOString()
                        }))
                            ; (existingLocal as any)._enrichedItems = updatedItems
                        await db.sales.put(existingLocal)
                    }
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                    await Promise.all((saleToReturn.items || []).map((item) =>
                        db.sale_items.update(item.id, {
                            returnedQuantity: item.quantity
                        } as any)
                    ))
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

                    const updateSale = (s: Sale) => {
                        if (s.id !== saleToReturn.id) return s
                        const updatedItems = s.items?.map(i => {
                            const returnedIdx = itemIds.indexOf(i.id)
                            if (returnedIdx === -1) return i

                            const q = quantities[returnedIdx]
                            const newReturnedQty = (i.returned_quantity || 0) + q
                            return {
                                ...i,
                                returned_quantity: newReturnedQty,
                                is_returned: newReturnedQty >= i.quantity,
                                return_reason: reason,
                                returned_at: new Date().toISOString()
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
                        await db.sales.put(existingLocal)
                    }
                    if (selectedSale?.id === saleToReturn.id) {
                        setSelectedSale(updateSale(selectedSale))
                    }
                }
            } else {
                // Whole Sale Return
                const { data, error: saleError } = await runSupabaseAction('sales.returnWhole', () =>
                    supabase.rpc('return_whole_sale', {
                        p_sale_id: saleToReturn.id,
                        p_return_reason: reason
                    })
                )
                error = saleError

                if (!error && data?.success) {
                    const updateSale = (s: Sale) => {
                        if (s.id !== saleToReturn.id) return s
                        return {
                            ...s,
                            is_returned: true,
                            total_amount: 0,
                            return_reason: reason,
                            returned_at: new Date().toISOString(),
                            items: s.items?.map(i => ({
                                ...i,
                                is_returned: true,
                                returned_quantity: i.quantity,
                                return_reason: reason,
                                returned_at: new Date().toISOString()
                            }))
                        }
                    }

                    // Update local-db for instant UI reactivity
                    const existingLocal = await db.sales.get(saleToReturn.id)
                    if (existingLocal) {
                        ; (existingLocal as any).isReturned = true
                            ; (existingLocal as any).totalAmount = 0
                            ; (existingLocal as any).returnReason = reason
                            ; (existingLocal as any).returnedAt = new Date().toISOString()
                        const updatedItems = ((existingLocal as any)._enrichedItems || []).map((i: any) => ({
                            ...i,
                            is_returned: true,
                            returned_quantity: i.quantity,
                            return_reason: reason,
                            returned_at: new Date().toISOString()
                        }))
                            ; (existingLocal as any)._enrichedItems = updatedItems
                        await db.sales.put(existingLocal)
                    }
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

    // Reset to page 1 when filters change
    useEffect(() => {
        setCurrentPage(1)
    }, [dateRange, customDates, selectedCashier])

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

                        {availableCashiers.length > 0 && (
                            <div className={cn(
                                "flex flex-col gap-1 bg-secondary/30 p-2 px-3 border min-w-[140px]",
                                style === 'neo-orange' ? "rounded-[var(--radius)] border-black dark:border-white" : "rounded-xl border-border/40 backdrop-blur-md shadow-sm"
                            )}>
                                <div className="flex items-center gap-2">
                                    <Filter className="w-3 h-3 text-muted-foreground/70" />
                                    <span className="text-[9px] uppercase font-black tracking-tighter text-muted-foreground/60 whitespace-nowrap">
                                        {t('sales.filters.cashier') || 'Filter By Cashier'}
                                    </span>
                                </div>
                                <Select value={selectedCashier} onValueChange={setSelectedCashier}>
                                    <SelectTrigger className="h-7 text-[11px] w-full bg-background/40 border-none focus-visible:ring-1 focus-visible:ring-primary/30 transition-all font-medium">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">
                                            {t('sales.filters.allCashiers') || 'All Cashiers'}
                                        </SelectItem>
                                        {availableCashiers.map((cashier) => (
                                            <SelectItem key={cashier.id} value={cashier.id}>
                                                {cashier.name || 'Unknown'}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}
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
                                                                {formatOriginLabel(sale.origin)}
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
                                                    {user?.role === 'admin' && sale.origin !== 'sales_order' && sale.origin !== 'travel_agency' && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className={cn(
                                                                "h-10 w-10 text-destructive hover:bg-destructive/5",
                                                                style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-destructive shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)]" : "rounded-xl"
                                                            )}
                                                            onClick={() => handleDeleteSale(sale)}
                                                        >
                                                            <Trash2 className="w-4 h-4" />
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
                                                        {formatOriginLabel(sale.origin)}
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
                                                            {user?.role === 'admin' && (
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                                                    onClick={() => handleDeleteSale(sale)}
                                                                >
                                                                    <Trash2 className="w-4 h-4" />
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
                        selectedCashier
                    }}
                />

                <PrintSelectionModal
                    isOpen={showPrintModal}
                    onClose={() => setShowPrintModal(false)}
                    onSelect={handlePrintSelection}
                    a4Variant={saleToPrintSelection && saleHasAnyReturnActivity(saleToPrintSelection) ? 'refund' : 'standard'}
                />

                <DeleteConfirmationModal
                    isOpen={deleteModalOpen}
                    onClose={() => {
                        setDeleteModalOpen(false)
                        setSaleToDelete(null)
                    }}
                    onConfirm={confirmDeleteSale}
                    itemName={saleToDelete ? (saleToDelete.sequenceId ? `#${String(saleToDelete.sequenceId).padStart(5, '0')}` : `#${saleToDelete.id.slice(0, 8)}`) : ''}
                    isLoading={isLoading}
                    title={t('sales.confirmDelete')}
                    description={t('sales.deleteWarning')}
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
            </div>
        </TooltipProvider>
    )
}





