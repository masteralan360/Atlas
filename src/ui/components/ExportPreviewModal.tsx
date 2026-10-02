import { createContext, lazy, Suspense, useCallback, useContext, useState, useMemo, useEffect, useRef } from 'react'
import { EntireColumnsSelection, EntireRowsSelection, type CellBase, type ColumnIndicatorProps, type Matrix, type Selection } from 'react-spreadsheet'
import { useTranslation } from 'react-i18next'
import { FileSpreadsheet, Download, ArrowLeft, Eraser, Loader2, Printer, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/workspace'
import { db } from '@/local-db'
import { Button } from '@/ui/components/button'
import { Checkbox } from '@/ui/components/checkbox'
import { ProductExportPrintTemplate } from '@/ui/components/ProductExportPrintTemplate'
import { exportToExcel, mapFinanceForExport, mapSalesForExport, mapRevenueForExport } from '@/lib/excelExport'
import {
    buildExportPreviewTable,
    clearExportPreviewColumnRows,
    deleteExportPreviewColumn,
    exportPreviewTableToRows,
    remapSelectedPrintColumnsAfterDeletion,
    selectExportPreviewTableColumns,
} from '@/lib/productExportPrintTable'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/ui/components/ui/context-menu'
import { generateTemplatePdf } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'
import { supabase } from '@/auth/supabase'
import { useHideCosts, useViewOwnRecordScope } from '@/permissions'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { PrintFlow } from '@/ui/components/PrintFlow'

const SpreadsheetPreview = lazy(() =>
    import('react-spreadsheet').then((module) => ({ default: module.default }))
)

type PreviewCell = CellBase<string | number | boolean | null | undefined>
type PreviewMatrix = Matrix<PreviewCell>

type ExportPreviewColumnMenuActions = {
    clearColumnRows: (columnIndex: number) => void
    deleteColumn: (columnIndex: number) => void
    isPrintColumnSelected: (columnIndex: number) => boolean
    setPrintColumnSelected: (columnIndex: number, checked: boolean) => void
    clearRowsLabel: string
    deleteColumnLabel: string
    selectColumnForPrintLabel: (column: string) => string
}

const ExportPreviewColumnMenuContext = createContext<ExportPreviewColumnMenuActions | null>(null)

function getSpreadsheetColumnLabel(column: number) {
    let label = ''
    let index = column

    while (index >= 0) {
        label = String.fromCharCode(65 + (index % 26)) + label
        index = Math.floor(index / 26) - 1
    }

    return label
}

function ProductExportPreviewColumnMenuContent({ column }: { column: number }) {
    const menuActions = useContext(ExportPreviewColumnMenuContext)

    if (!menuActions) {
        return null
    }

    return (
        <ContextMenuContent className="w-48">
            <ContextMenuItem
                className="gap-2"
                onSelect={() => menuActions.clearColumnRows(column)}
            >
                <Eraser className="h-4 w-4" />
                {menuActions.clearRowsLabel}
            </ContextMenuItem>
            <ContextMenuItem
                className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                onSelect={() => menuActions.deleteColumn(column)}
            >
                <Trash2 className="h-4 w-4" />
                {menuActions.deleteColumnLabel}
            </ContextMenuItem>
        </ContextMenuContent>
    )
}

function ExportPreviewColumnIndicator({
    column,
    label,
    selected,
    onSelect,
}: ColumnIndicatorProps) {
    const menuActions = useContext(ExportPreviewColumnMenuContext)
    const columnLabel = label !== undefined ? String(label) : getSpreadsheetColumnLabel(column)
    const handleClick = useCallback((event: React.MouseEvent<HTMLTableCellElement>) => {
        onSelect(column, event.shiftKey)
    }, [column, onSelect])
    const handleContextMenu = useCallback(() => {
        onSelect(column, false)
    }, [column, onSelect])

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <th
                    className={cn('Spreadsheet__header', {
                        'Spreadsheet__header--selected': selected,
                    })}
                    onClick={handleClick}
                    onContextMenu={handleContextMenu}
                    tabIndex={0}
                >
                    <span className="inline-flex items-center gap-1">
                        {menuActions ? (
                            <span onClick={(event) => event.stopPropagation()}>
                                <Checkbox
                                    checked={menuActions.isPrintColumnSelected(column)}
                                    onCheckedChange={(checked) => menuActions.setPrintColumnSelected(column, checked)}
                                    aria-label={menuActions.selectColumnForPrintLabel(columnLabel)}
                                    className="h-3.5 w-3.5"
                                />
                            </span>
                        ) : null}
                        <span>{label !== undefined ? label : getSpreadsheetColumnLabel(column)}</span>
                    </span>
                </th>
            </ContextMenuTrigger>
            <ProductExportPreviewColumnMenuContent column={column} />
        </ContextMenu>
    )
}

function ProductExportPreviewHeaderViewer({
    cell,
    evaluatedCell,
    column,
}: {
    cell: PreviewCell | undefined
    evaluatedCell: PreviewCell | undefined
    column: number
}) {
    const value = evaluatedCell?.value ?? cell?.value ?? ''

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <span className="Spreadsheet__data-viewer cursor-context-menu">
                    {String(value)}
                </span>
            </ContextMenuTrigger>
            <ProductExportPreviewColumnMenuContent column={column} />
        </ContextMenu>
    )
}

function getSelectedColumnRange(selection: Selection | null, columnCount: number) {
    if (!(selection instanceof EntireColumnsSelection) || columnCount === 0) {
        return null
    }

    const start = Math.max(0, Math.min(selection.start, selection.end))
    const end = Math.min(columnCount - 1, Math.max(selection.start, selection.end))

    return start <= end ? { start, end } : null
}

function getSelectedRowRange(selection: Selection | null, rowCount: number) {
    if (!(selection instanceof EntireRowsSelection) || rowCount <= 1) {
        return null
    }

    const start = Math.max(1, Math.min(selection.start, selection.end))
    const end = Math.min(rowCount - 1, Math.max(selection.start, selection.end))

    return start <= end ? { start, end } : null
}

interface ExportPreviewModalProps {
    isOpen: boolean
    onClose: () => void
    filters?: {
        dateRange: string
        customDates: { start: string | null; end: string | null }
        selectedCashier: string
    }
    type?: 'sales' | 'revenue' | 'finance' | 'products' | 'inventory-product-summary'
    records?: any[]
}

export function ExportPreviewModal({
    isOpen,
    onClose,
    filters,
    type = 'sales',
    records
}: ExportPreviewModalProps) {
    const { t, i18n } = useTranslation()
    const { activeWorkspace, isLocalMode, features, workspaceName } = useWorkspace()
    const hideCosts = useHideCosts()
    const salesViewOwnScope = useViewOwnRecordScope('sales.view_own')
    const [isExporting, setIsExporting] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [data, setData] = useState<any[]>([])
    const [previewData, setPreviewData] = useState<PreviewMatrix>([])
    const [selectedPreviewCells, setSelectedPreviewCells] = useState<Selection | null>(null)
    const [selectedProductPrintColumns, setSelectedProductPrintColumns] = useState<Set<number>>(() => new Set())
    const [isProductPrintSelectionOpen, setIsProductPrintSelectionOpen] = useState(false)
    const [productPrintTemplatePreview, setProductPrintTemplatePreview] = useState<TemplatePreview | null>(null)
    const hasCapturedProductSourceRef = useRef(false)
    const hasSeededPreviewRef = useRef(false)

    useEffect(() => {
        if (isOpen && (type === 'revenue' || type === 'finance' || type === 'products' || type === 'inventory-product-summary') && records) {
            if (type === 'products' && hasCapturedProductSourceRef.current) {
                return
            }

            if (type === 'products') {
                hasCapturedProductSourceRef.current = true
            }
            setData(records)
            setIsLoading(false)
        } else if (isOpen && filters) {
            fetchExportData()
        } else if (!isOpen) {
            hasCapturedProductSourceRef.current = false
            setData([])
        }
    }, [
        activeWorkspace?.id,
        filters,
        hideCosts,
        isLocalMode,
        isOpen,
        records,
        salesViewOwnScope.isRestricted,
        salesViewOwnScope.userId,
        type,
    ])

    const fetchExportData = async () => {
        setIsLoading(true)
        try {
            if (isLocalMode && activeWorkspace?.id) {
                const localSales = await db.sales.where('workspaceId').equals(activeWorkspace.id).toArray()
                const localUsers = await db.users.where('workspaceId').equals(activeWorkspace.id).toArray()
                const localSaleIds = localSales.map((sale) => sale.id)
                const localSaleItems = !hideCosts && localSaleIds.length > 0
                    ? await db.sale_items.where('saleId').anyOf(localSaleIds).toArray()
                    : []
                const saleItemsBySaleId = localSaleItems.reduce<Record<string, typeof localSaleItems>>((acc, item) => {
                    if (!acc[item.saleId]) {
                        acc[item.saleId] = []
                    }
                    acc[item.saleId].push(item)
                    return acc
                }, {})
                const profilesMap = localUsers.reduce<Record<string, string>>((acc, member) => {
                    acc[member.id] = member.name
                    return acc
                }, {})

                const { dateRange, customDates, selectedCashier } = filters || {
                    dateRange: 'today',
                    customDates: { start: null, end: null },
                    selectedCashier: 'all'
                }
                const { start, end } = getDateRangeBounds(dateRange as Parameters<typeof getDateRangeBounds>[0], {
                    start: customDates.start || '',
                    end: customDates.end || ''
                })

                const filteredSales = localSales.filter((sale) => {
                    if (sale.isArchived) return false
                    if (salesViewOwnScope.isRestricted && sale.cashierId !== salesViewOwnScope.userId) {
                        return false
                    }
                    const saleDate = new Date(sale.createdAt)
                    if (start && saleDate < start) return false
                    if (end && saleDate >= end) return false
                    if (selectedCashier && selectedCashier !== 'all' && sale.cashierId !== selectedCashier) {
                        return false
                    }
                    return true
                })

                const formattedSales = filteredSales
                    .filter((sale: any) => !sale.isReturned)
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map((sale: any) => {
                        const saleItems = saleItemsBySaleId[sale.id] || []
                        const saleRevenue = sale.totalAmount || 0
                        const saleCost = saleItems.reduce((acc: number, item: any) => {
                            const costPrice = item.convertedCostPrice || item.costPrice || 0
                            const quantity = item.quantity || 0
                            const returnedQuantity = item.returnedQuantity || 0
                            const netQuantity = Math.max(0, quantity - returnedQuantity)
                            return acc + (costPrice * netQuantity)
                        }, 0)
                        const exportSale = {
                            ...sale,
                            sequenceId: sale.sequenceId,
                            cashier_name: profilesMap[sale.cashierId] || 'Staff',
                            revenue: saleRevenue,
                            cost: saleCost,
                            profit: saleRevenue - saleCost,
                            margin: saleRevenue > 0 ? ((saleRevenue - saleCost) / saleRevenue) * 100 : 0,
                            date: sale.createdAt,
                            cashier: profilesMap[sale.cashierId] || 'Staff',
                            currency: sale.settlementCurrency || 'usd',
                            total_amount: sale.totalAmount,
                            settlement_currency: sale.settlementCurrency,
                            items: saleItems.map((item: any) => ({
                                ...item,
                                product_name: item.productName || 'Unknown Product',
                                product_sku: item.productSku || ''
                            }))
                        }
                        if (!hideCosts) return exportSale
                        const { cost, profit, margin, items, ...safeSale } = exportSale
                        return safeSale
                    })
                setData(formattedSales)
                return
            }

            let query = supabase
                .from('sales')
                .select(hideCosts
                    ? 'id, sequence_id, cashier_id, created_at, is_returned, total_amount, settlement_currency, payment_method, notes, origin'
                    : `
                        *,
                        items:sale_items(
                            *,
                            product:product_id(name, sku, can_be_returned, return_rules)
                        )
                    `)

            const { dateRange, customDates, selectedCashier } = filters || {
                dateRange: 'today',
                customDates: { start: null, end: null },
                selectedCashier: 'all'
            }
            const { start, end } = getDateRangeBounds(dateRange as Parameters<typeof getDateRangeBounds>[0], {
                start: customDates.start || '',
                end: customDates.end || ''
            })

            if (activeWorkspace?.id) {
                query = query.eq('workspace_id', activeWorkspace.id)
            }
            query = query.eq('is_archived', false)

            if (start) query = query.gte('created_at', start.toISOString())
            if (end) query = query.lt('created_at', end.toISOString())

            if (selectedCashier && selectedCashier !== 'all') {
                query = query.eq('cashier_id', selectedCashier)
            }

            const { data: salesData, error } = await query.order('created_at', { ascending: false })
            if (error) throw error

            const cashierIds = Array.from(new Set((salesData || []).map((s: any) => s.cashier_id).filter(Boolean)))
            let profilesMap: Record<string, string> = {}
            if (cashierIds.length > 0) {
                const { data: profiles } = await supabase
                    .from('profiles')
                    .select('id, name')
                    .in('id', cashierIds)
                if (profiles) {
                    profilesMap = profiles.reduce((acc: any, curr: any) => ({
                        ...acc,
                        [curr.id]: curr.name
                    }), {})
                }
            }

            const formattedSales = (salesData || [])
                .filter((sale: any) => !sale.is_returned)
                .map((sale: any) => {
                    const saleRevenue = sale.total_amount || 0
                    const saleCost = (sale.items || []).reduce((acc: number, item: any) => {
                        const costPrice = item.converted_cost_price || item.cost_price || 0
                        const quantity = item.quantity || 0
                        const returnedQuantity = item.returned_quantity || 0
                        const netQuantity = Math.max(0, quantity - returnedQuantity)
                        return acc + (costPrice * netQuantity)
                    }, 0)
                    const exportSale = {
                        ...sale,
                        sequenceId: sale.sequence_id,
                        cashier_name: profilesMap[sale.cashier_id] || 'Staff',
                        revenue: saleRevenue,
                        cost: saleCost,
                        profit: saleRevenue - saleCost,
                        margin: saleRevenue > 0 ? ((saleRevenue - saleCost) / saleRevenue) * 100 : 0,
                        date: sale.created_at,
                        cashier: profilesMap[sale.cashier_id] || 'Staff',
                        currency: sale.settlement_currency || 'usd',
                        items: sale.items?.map((item: any) => ({
                            ...item,
                            product_name: item.product?.name || 'Unknown Product',
                            product_sku: item.product?.sku || ''
                        }))
                    }
                    if (!hideCosts) return exportSale
                    const { cost, profit, margin, items, ...safeSale } = exportSale
                    return safeSale
                })
            setData(formattedSales)
        } catch (error) {
            console.error('Error fetching export data:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const exportData = useMemo(() => {
        if (!data) return []
        if (type === 'finance') return mapFinanceForExport(data)
        if (type === 'products' || type === 'inventory-product-summary') return mapFinanceForExport(data)
        if (type === 'revenue') return mapRevenueForExport(data, t, !hideCosts)
        return mapSalesForExport(data, t)
    }, [data, hideCosts, t, type])

    const spreadsheetData = useMemo<PreviewMatrix>(() => {
        if (exportData.length === 0) return []
        const headers = Object.keys(exportData[0]).map(header => ({
            value: header,
            readOnly: true,
            ...(type === 'products' ? { DataViewer: ProductExportPreviewHeaderViewer } : {})
        }))
        const rows = exportData.map(row =>
            Object.values(row).map(val => ({ value: String(val ?? '') }))
        )
        return [headers, ...rows]
    }, [exportData, type])

    useEffect(() => {
        if (!isOpen) {
            hasSeededPreviewRef.current = false
            setPreviewData([])
            setSelectedPreviewCells(null)
            setSelectedProductPrintColumns(new Set())
            return
        }

        if (hasSeededPreviewRef.current || spreadsheetData.length === 0) {
            return
        }

        hasSeededPreviewRef.current = true
        setPreviewData(spreadsheetData)
        setSelectedPreviewCells(null)
    }, [isOpen, spreadsheetData])

    const previewTable = useMemo(() => buildExportPreviewTable(previewData), [previewData])
    const previewExportData = useMemo(() => exportPreviewTableToRows(previewTable), [previewTable])
    const selectedProductPrintTable = useMemo(() => selectExportPreviewTableColumns(
        previewTable,
        selectedProductPrintColumns
    ), [previewTable, selectedProductPrintColumns])
    const printLang = features.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
    const productPrintButtonLabel = t('products.export.printButton') === 'products.export.printButton'
        ? t('common.print')
        : t('products.export.printButton')
    const productPrintTitle = t('products.export.printTitle') === 'products.export.printTitle'
        ? t('sales.export.previewTitle')
        : t('products.export.printTitle')

    const clearPreviewColumnRows = useCallback((columnIndex: number) => {
        setPreviewData((current) => clearExportPreviewColumnRows(current, columnIndex))
        setSelectedPreviewCells(null)
    }, [])

    const removePreviewColumn = useCallback((columnIndex: number) => {
        setPreviewData((current) => deleteExportPreviewColumn(current, columnIndex))
        setSelectedProductPrintColumns((current) => remapSelectedPrintColumnsAfterDeletion(current, columnIndex))
        setSelectedPreviewCells(null)
    }, [])

    const setPrintColumnSelected = useCallback((columnIndex: number, checked: boolean) => {
        setSelectedProductPrintColumns((current) => {
            const next = new Set(current)
            if (checked) {
                next.add(columnIndex)
            } else {
                next.delete(columnIndex)
            }
            return next
        })
    }, [])

    const previewColumnMenuActions = useMemo<ExportPreviewColumnMenuActions>(() => ({
        clearColumnRows: clearPreviewColumnRows,
        deleteColumn: removePreviewColumn,
        isPrintColumnSelected: (columnIndex) => selectedProductPrintColumns.has(columnIndex),
        setPrintColumnSelected,
        clearRowsLabel: t('products.export.clearRows'),
        deleteColumnLabel: t('products.export.deleteColumn'),
        selectColumnForPrintLabel: (column) => t('products.export.selectColumnForPrint', { column }),
    }), [clearPreviewColumnRows, removePreviewColumn, selectedProductPrintColumns, setPrintColumnSelected, t])

    const handlePreviewKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (event.key !== 'Delete') {
            return
        }

        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, [contenteditable="true"]')) {
            return
        }

        const rowRange = getSelectedRowRange(selectedPreviewCells, previewData.length)
        if (rowRange) {
            event.preventDefault()
            event.stopPropagation()

            setPreviewData((current) => current.filter((_, rowIndex) => rowIndex < rowRange.start || rowIndex > rowRange.end))
            setSelectedPreviewCells(null)
            return
        }

        const columnRange = getSelectedColumnRange(selectedPreviewCells, previewData[0]?.length ?? 0)
        if (!columnRange) return

        event.preventDefault()
        event.stopPropagation()

        setPreviewData((current) => current.map((row) =>
            row?.filter((_, columnIndex) => columnIndex < columnRange.start || columnIndex > columnRange.end) ?? []
        ))
        setSelectedProductPrintColumns((current) => {
            let remapped = current
            for (let columnIndex = columnRange.end; columnIndex >= columnRange.start; columnIndex -= 1) {
                remapped = remapSelectedPrintColumnsAfterDeletion(remapped, columnIndex)
            }
            return remapped
        })
        setSelectedPreviewCells(null)
    }, [previewData, selectedPreviewCells])

    const openProductExportPrintFlow = useCallback(() => {
        if (selectedProductPrintTable.columns.length === 0 || selectedProductPrintTable.rows.length === 0) return

        const snapshot = {
            table: selectedProductPrintTable,
            generatedAt: new Date().toISOString()
        }
        const printTemplate: TemplatePreview = {
            fields: [],
            page: { widthMm: 210, heightMm: 297 },
            createElement: (_fieldValues, _effectiveId, printLangOverride) => (
                <ProductExportPrintTemplate
                    workspaceName={workspaceName}
                    printLang={printLangOverride || printLang}
                    table={snapshot.table}
                    generatedAt={snapshot.generatedAt}
                />
            ),
            buildPdf: (element, printLangOverride) => generateTemplatePdf({
                element,
                format: 'a4',
                printLang: printLangOverride || printLang
            })
        }

        setProductPrintTemplatePreview(printTemplate)
        setIsProductPrintSelectionOpen(true)
    }, [printLang, selectedProductPrintTable, workspaceName])

    const handleExport = async () => {
        setIsExporting(true)
        try {
            await new Promise(resolve => setTimeout(resolve, 500))
            const prefix = type === 'revenue'
                ? 'Revenue_Export'
                : type === 'finance'
                    ? 'Finance_Export'
                    : type === 'inventory-product-summary'
                        ? 'Inventory_Product_Summary'
                        : type === 'products'
                        ? 'Products_Export'
                        : 'Sales_Export'
            const success = await exportToExcel(previewExportData, `${prefix}_${new Date().toISOString().split('T')[0]}`)
            if (success) {
                onClose()
            }
        } catch (error) {
            console.error('Export failed:', error)
        } finally {
            setIsExporting(false)
        }
    }

    if (!isOpen) return null

    return (
        <>
        <div className="space-y-6 min-h-screen">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onClose}
                        className="rounded-full hover:bg-muted shrink-0"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </Button>
                    <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20">
                        <FileSpreadsheet className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                        <h1 className="text-xl font-black tracking-tight">
                            {t('sales.export.previewTitle') || 'Export Preview'}
                        </h1>
                        <p className="text-muted-foreground text-xs font-bold uppercase tracking-wider">
                            {isLoading ? (
                                <span className="flex items-center gap-2">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    {t('common.loading') || 'Loading...'}
                                </span>
                            ) : (
                                `${data.length} ${t('sales.export.recordsCount') || 'Records ready for export'}`
                            )}
                        </p>
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <div className="flex flex-wrap items-center justify-end gap-3">
                        {type === 'products' ? (
                        <Button
                            type="button"
                            onClick={openProductExportPrintFlow}
                            disabled={isExporting || isLoading || selectedProductPrintColumns.size === 0 || selectedProductPrintTable.rows.length === 0}
                            className="h-10 gap-2 rounded-xl bg-violet-600 px-6 font-black text-white shadow-lg shadow-violet-500/20 transition-all hover:bg-violet-700 active:scale-95 disabled:bg-violet-500/40 disabled:text-white/70 disabled:shadow-none"
                        >
                            <Printer className="h-4 w-4" />
                            {productPrintButtonLabel}
                        </Button>
                        ) : null}
                        <Button
                        variant="ghost"
                        onClick={onClose}
                        disabled={isExporting}
                        className="h-10 px-6 rounded-xl font-bold"
                    >
                        {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button
                        onClick={handleExport}
                        disabled={isExporting || isLoading || previewExportData.length === 0}
                        className={cn(
                            "h-10 px-6 rounded-xl font-black shadow-lg transition-all active:scale-95 flex gap-2 items-center justify-center",
                            "bg-emerald-500 hover:bg-emerald-600 text-white shadow-emerald-500/20 border-t border-white/10"
                        )}
                    >
                        {isExporting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Download className="w-4 h-4" />
                        )}
                        {t('sales.export.downloadBtn')}
                        </Button>
                    </div>
                    {type === 'products' ? (
                        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                            {selectedProductPrintColumns.size > 0
                                ? t('products.export.selectedColumnsForPrint', { count: selectedProductPrintColumns.size })
                                : t('products.export.selectColumnsForPrint')}
                        </p>
                    ) : null}
                </div>
            </div>

            <div className="rounded-2xl border border-border/50 bg-background/50 p-4">
                {isLoading ? (
                    <div className="flex items-center justify-center py-20 text-muted-foreground gap-3">
                        <Loader2 className="w-6 h-6 animate-spin text-primary" />
                        <span className="text-sm font-semibold">{t('sales.export.preparingData') || 'Preparing data for export...'}</span>
                    </div>
                ) : previewData.length > 0 && (previewData[0]?.length ?? 0) > 0 ? (
                    <div className="overflow-auto">
                        <div className="inline-block min-w-full">
                            <Suspense
                                fallback={(
                                    <div className="flex items-center justify-center py-16 text-muted-foreground gap-3">
                                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                                        <span className="text-sm font-semibold">{t('common.loading') || 'Loading...'}</span>
                                    </div>
                                )}
                            >
                                <ExportPreviewColumnMenuContext.Provider value={type === 'products' ? previewColumnMenuActions : null}>
                                    <SpreadsheetPreview
                                        data={previewData}
                                        onChange={setPreviewData}
                                        onSelect={setSelectedPreviewCells}
                                        onKeyDown={handlePreviewKeyDown}
                                        ColumnIndicator={type === 'products' ? ExportPreviewColumnIndicator : undefined}
                                        className="atlas-spreadsheet text-sm font-medium"
                                    />
                                </ExportPreviewColumnMenuContext.Provider>
                            </Suspense>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center justify-center py-20 text-muted-foreground">
                        {t('common.noData') || 'No data to display'}
                    </div>
                )}
            </div>

            {previewData.length > 0 && (previewData[0]?.length ?? 0) > 0 && (
                <div className="text-xs text-muted-foreground font-medium text-center">
                    {Math.max(0, previewData.length - 1)} rows &middot; {previewData[0]?.length ?? 0} columns
                </div>
            )}

        </div>
        <PrintFlow
            isOpen={isProductPrintSelectionOpen}
            onClose={() => setIsProductPrintSelectionOpen(false)}
            title={productPrintTitle}
            showSaveButton={false}
            features={features}
            workspaceName={workspaceName}
            allowA4Document
            templatePreview={productPrintTemplatePreview || undefined}
            printSelectionOptions={[{
                format: 'a4',
                label: productPrintButtonLabel,
                description: productPrintTitle
            }]}
            onPreviewPrint={(blob) => printPdfBlob(blob, { title: productPrintTitle })}
            previewPrintActionLabel={productPrintButtonLabel}
        />
        </>
    )
}
