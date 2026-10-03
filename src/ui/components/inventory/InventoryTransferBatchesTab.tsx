import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeftRight,
  Eye,
  FileText,
  Loader2,
  Printer,
  Search,
  Warehouse,
} from 'lucide-react'
import type { DateRangeType } from '@/context/DateRangeContext'
import {
  fetchInventoryTransferBatchDetails,
  fetchInventoryTransferBatchHistory,
  type InventoryTransferBatchDetails,
  type InventoryTransferBatchHistoryItem,
} from '@/local-db'
import { fetchCachedCustomTemplates } from '@/lib/cachedCustomTemplates'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  AppPagination,
  Badge,
  Button,
  Card,
  CardContent,
  DateRangeFilters,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/ui/components'
import { PrintFlow } from '@/ui/components/PrintFlow'
import {
  buildCustomTemplateLayoutPdf,
  type StoredCustomTemplateRow,
} from '@/lib/customTemplates'
import {
  getCustomTemplatePrintLanguageWarning,
  getCustomTemplateTarget,
  getStoredCustomTemplateLabel,
  INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY,
  isCustomTemplatePrintLanguageCompatible,
  readCustomTemplateLayout,
  resolveCustomTemplatePrintLanguage,
} from '@/lib/customTemplates'
import type { CustomTemplateLayout, TemplatePreview } from '@/lib/printPreviewEditorStore'
import { createCustomTemplatePreview } from '@/lib/customTemplates'
import type { PrintFormat } from '@/services/pdfGenerator'
import { printPdfBlob } from '@/services/pdfPrintService'
import { formatDateTime, parseLocalDateValue } from '@/lib/utils'
import { useWorkspace, type WorkspaceFeatures } from '@/workspace'
import type { PrintSelectionTemplateOption } from '@/ui/components/PrintSelectionModal'
import { areTransferBatchWorkspacesSame, type InventoryTransferBatchPrintData } from './InventoryTransferBatchPrintTemplate'

const TRANSFER_TEMPLATE_TARGET = getCustomTemplateTarget(INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY)

type CustomDates = { start: string; end: string }

function startOfDay(date: Date) {
  const value = new Date(date)
  value.setHours(0, 0, 0, 0)
  return value
}

function addDays(date: Date, count: number) {
  const value = new Date(date)
  value.setDate(value.getDate() + count)
  return value
}

function getDateBounds(range: DateRangeType, customDates: CustomDates) {
  const now = new Date()
  let from: Date | null = null
  let to: Date | null = null
  if (range === 'today') {
    from = startOfDay(now)
    to = addDays(from, 1)
  } else if (range === 'yesterday') {
    to = startOfDay(now)
    from = addDays(to, -1)
  } else if (range === 'month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1)
    to = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  } else if (range === 'lastMonth') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    to = new Date(now.getFullYear(), now.getMonth(), 1)
  } else if (range === 'custom') {
    from = customDates.start ? parseLocalDateValue(customDates.start) ?? null : null
    const end = customDates.end ? parseLocalDateValue(customDates.end) ?? null : null
    to = end ? addDays(end, 1) : null
  }
  return { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null }
}

export function InventoryTransferBatchesTab({
  workspaceId,
  workspaceName,
  features,
}: {
  workspaceId?: string | null
  workspaceName?: string | null
  features: WorkspaceFeatures
}) {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const { activeWorkspace, branchInfo } = useWorkspace()
  const resolvedWorkspaceId = workspaceId || activeWorkspace?.id || ''
  const [dateRange, setDateRange] = useState<DateRangeType>('month')
  const [customDates, setCustomDates] = useState<CustomDates>({ start: '', end: '' })
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [rows, setRows] = useState<InventoryTransferBatchHistoryItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [selectedDetails, setSelectedDetails] = useState<InventoryTransferBatchDetails | null>(null)
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)
  const [isLoadingDetails, setIsLoadingDetails] = useState(false)
  const [detailsLoadError, setDetailsLoadError] = useState(false)
  const [customTemplates, setCustomTemplates] = useState<StoredCustomTemplateRow[]>([])
  const [selectedPrintTemplate, setSelectedPrintTemplate] = useState<StoredCustomTemplateRow | null>(null)
  const [printData, setPrintData] = useState<InventoryTransferBatchPrintData | null>(null)
  const [isPrintOpen, setIsPrintOpen] = useState(false)
  const requestId = useRef(0)
  const detailRequestId = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { from, to } = useMemo(() => getDateBounds(dateRange, customDates), [customDates, dateRange])

  const quantityFormatter = useMemo(() => new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, {
    maximumFractionDigits: 6,
  }), [i18n.language, i18n.resolvedLanguage])
  const currentPrintLanguage = resolveCustomTemplatePrintLanguage(features.print_lang, i18n.language)
  const availablePrintTemplates = useMemo(
    () => customTemplates.filter((template) => template.module_type_key === INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY
      && template.active !== false && Boolean(readCustomTemplateLayout(template))),
    [customTemplates],
  )
  const selectedPrintLayout = useMemo(
    () => selectedPrintTemplate && isCustomTemplatePrintLanguageCompatible(selectedPrintTemplate, currentPrintLanguage)
      ? readCustomTemplateLayout(selectedPrintTemplate)
      : null,
    [currentPrintLanguage, selectedPrintTemplate],
  )
  const activePrintLayout = useMemo<CustomTemplateLayout | null>(() => {
    if (selectedPrintLayout) return selectedPrintLayout
    if (!TRANSFER_TEMPLATE_TARGET) return null
    return {
      version: 1,
      label: t('inventoryTransfer.batch.atlasStandard', { defaultValue: 'Inventory Transfer · Atlas Standard' }),
      moduleTypeKey: INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY,
      nativeTemplateKey: INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY,
      page: { widthMm: 210, heightMm: 297 },
      fields: {},
      fieldOrders: {},
      fieldLabelOverrides: {},
      annotations: [],
      texts: [],
      images: [],
      shapes: [],
      updatedAt: new Date().toISOString(),
    }
  }, [selectedPrintLayout, t])

  const printOptions = useMemo((): PrintSelectionTemplateOption[] => availablePrintTemplates.map((template) => ({
    format: 'a4',
    template,
    label: getStoredCustomTemplateLabel(template),
    description: t('inventoryTransfer.batch.customTemplateDescription', {
      defaultValue: 'Use this saved Inventory Transfer layout.',
    }),
    primary: template.primary,
    disabled: !isCustomTemplatePrintLanguageCompatible(template, currentPrintLanguage),
    warning: getCustomTemplatePrintLanguageWarning(template, currentPrintLanguage, t),
  })), [availablePrintTemplates, currentPrintLanguage, t])

  const makePreview = useCallback((data: InventoryTransferBatchPrintData): TemplatePreview | undefined => {
    if (!TRANSFER_TEMPLATE_TARGET) return undefined
    return createCustomTemplatePreview(TRANSFER_TEMPLATE_TARGET, {
      workspaceId: resolvedWorkspaceId,
      workspaceName,
      features,
      inventoryTransferBatchData: data,
      printLang: currentPrintLanguage,
    })
  }, [currentPrintLanguage, features, resolvedWorkspaceId, workspaceName])
  const templatePreview = useMemo(() => printData ? makePreview(printData) : undefined, [makePreview, printData])

  const buildPrintPdf = useCallback(async ({ effectiveId }: { format: PrintFormat; effectiveId: string }) => {
    if (!printData || !activePrintLayout || !TRANSFER_TEMPLATE_TARGET) {
      throw new Error('Transfer print data is unavailable.')
    }
    return buildCustomTemplateLayoutPdf({
      target: TRANSFER_TEMPLATE_TARGET,
      layout: activePrintLayout,
      values: {},
      options: { workspaceId: resolvedWorkspaceId, workspaceName, features, inventoryTransferBatchData: printData, printLang: currentPrintLanguage },
      effectiveId,
      fieldMode: 'layoutOverrides',
    })
  }, [activePrintLayout, currentPrintLanguage, features, printData, resolvedWorkspaceId, workspaceName])

  const buildEditedPrintPdf = useCallback(async (layout: CustomTemplateLayout, printLangOverride?: string, effectiveId?: string) => {
    if (!printData || !TRANSFER_TEMPLATE_TARGET) throw new Error('Transfer print data is unavailable.')
    return buildCustomTemplateLayoutPdf({
      target: TRANSFER_TEMPLATE_TARGET,
      layout,
      values: {},
      options: { workspaceId: resolvedWorkspaceId, workspaceName, features, inventoryTransferBatchData: printData, printLang: printLangOverride || currentPrintLanguage },
      effectiveId,
      fieldMode: 'layoutOverrides',
    })
  }, [currentPrintLanguage, features, printData, resolvedWorkspaceId, workspaceName])

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 250)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [searchInput])

  useEffect(() => {
    if (!resolvedWorkspaceId) {
      setRows([])
      setTotalCount(0)
      return
    }
    const currentRequest = ++requestId.current
    setIsLoading(true)
    setLoadError(false)
    void fetchInventoryTransferBatchHistory({
      workspaceId: resolvedWorkspaceId,
      search,
      from,
      to,
      page,
      pageSize,
    }).then((result) => {
      if (currentRequest !== requestId.current) return
      setRows(result.rows)
      setTotalCount(result.totalCount)
    }).catch((error) => {
      console.error('[InventoryTransfer] Failed to load batch history:', error)
      if (currentRequest === requestId.current) {
        setRows([])
        setTotalCount(0)
        setLoadError(true)
      }
    }).finally(() => {
      if (currentRequest === requestId.current) setIsLoading(false)
    })
    return () => { requestId.current += 1 }
  }, [from, page, pageSize, resolvedWorkspaceId, search, to])

  const loadBatchDetails = useCallback(async (batchId: string) => {
    if (!resolvedWorkspaceId) return null
    const currentRequest = ++detailRequestId.current
    setIsLoadingDetails(true)
    setDetailsLoadError(false)
    try {
      const details = await fetchInventoryTransferBatchDetails(resolvedWorkspaceId, batchId)
      if (currentRequest !== detailRequestId.current) return null
      setSelectedDetails(details)
      return details
    } catch (error) {
      console.error('[InventoryTransfer] Failed to load batch details:', error)
      if (currentRequest === detailRequestId.current) {
        setDetailsLoadError(true)
        toast({
          title: t('inventoryTransfer.batch.detailsErrorTitle', { defaultValue: 'Could not load transfer details' }),
          description: t('inventoryTransfer.batch.detailsError', { defaultValue: 'Refresh and try again.' }),
          variant: 'destructive',
        })
      }
      return null
    } finally {
      if (currentRequest === detailRequestId.current) setIsLoadingDetails(false)
    }
  }, [resolvedWorkspaceId, t, toast])

  const handleViewDetails = useCallback(async (row: InventoryTransferBatchHistoryItem) => {
    setSelectedDetails(null)
    setDetailsLoadError(false)
    setIsDetailsOpen(true)
    const details = await loadBatchDetails(row.batch.id)
    if (details) setSelectedDetails(details)
  }, [loadBatchDetails])

  const handlePrint = useCallback(async (row: InventoryTransferBatchHistoryItem) => {
    const details = await loadBatchDetails(row.batch.id)
    if (!details) return
    if (!TRANSFER_TEMPLATE_TARGET) return
    const localBranch = Boolean(branchInfo?.isBranch)
    const sameTransferWorkspace = areTransferBatchWorkspacesSame(details)
    const nextPrintData = {
      ...details,
      sourceIsBranch: details.sourceIsBranch || (sameTransferWorkspace && localBranch),
      destinationIsBranch: details.destinationIsBranch || (sameTransferWorkspace && localBranch),
      printedAt: new Date().toISOString(),
    }
    setPrintData(nextPrintData)
    setSelectedPrintTemplate(null)
    try {
      const templates = await fetchCachedCustomTemplates(resolvedWorkspaceId, {
        moduleTypeKey: INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY,
        activeOnly: true,
      })
      setCustomTemplates(templates)
      setIsPrintOpen(true)
    } catch (error) {
      console.error('[InventoryTransfer] Failed to load transfer templates:', error)
      toast({
        title: t('inventoryTransfer.batch.printErrorTitle', { defaultValue: 'Could not open transfer print options' }),
        description: t('inventoryTransfer.batch.printError', { defaultValue: 'Please try again.' }),
        variant: 'destructive',
      })
    }
  }, [branchInfo?.isBranch, loadBatchDetails, resolvedWorkspaceId, t, toast])

  const handlePrintSelection = useCallback((
    _format: PrintFormat,
    template?: StoredCustomTemplateRow,
    nativeTemplateKey?: string,
  ) => {
    if ((template?.module_type_key || nativeTemplateKey) !== INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY) return
    if (template && !isCustomTemplatePrintLanguageCompatible(template, currentPrintLanguage)) return
    setSelectedPrintTemplate(template || null)
  }, [currentPrintLanguage])

  const printStatus = (status: InventoryTransferBatchHistoryItem['batch']['status']) => t(
    `inventoryTransfer.batch.status.${status}`,
    { defaultValue: status },
  )
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="relative w-full xl:max-w-md">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t('inventoryTransfer.batch.searchPlaceholder', { defaultValue: 'Search transfer number, storage, person, product, SKU, or barcode' })}
            aria-label={t('inventoryTransfer.batch.search', { defaultValue: 'Search transfer batches' })}
            className="ps-9"
          />
        </div>
        <DateRangeFilters
          dateRange={dateRange}
          customDates={customDates}
          onDateRangeChange={(value) => { setDateRange(value); setPage(1) }}
          onCustomDatesChange={(value) => { setCustomDates(value); setPage(1) }}
          showYesterday
          showAllTime
          className="xl:max-w-fit"
        />
      </div>

      <Card className="overflow-hidden rounded-2xl border shadow-sm">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('inventoryTransfer.batch.columns.transferNumber', { defaultValue: 'Transfer Number' })}</TableHead>
                  <TableHead>{t('inventoryTransfer.batch.columns.date', { defaultValue: 'Date / Time' })}</TableHead>
                  <TableHead>{t('inventoryTransfer.batch.columns.source', { defaultValue: 'From Workspace / Branch · Storage' })}</TableHead>
                  <TableHead>{t('inventoryTransfer.batch.columns.destination', { defaultValue: 'To Workspace / Branch · Storage' })}</TableHead>
                  <TableHead className="text-end">{t('inventoryTransfer.batch.columns.products', { defaultValue: 'Products' })}</TableHead>
                  <TableHead>{t('inventoryTransfer.batch.columns.performedBy', { defaultValue: 'Performed By' })}</TableHead>
                  <TableHead>{t('inventoryTransfer.batch.columns.status', { defaultValue: 'Status' })}</TableHead>
                  <TableHead className="text-end">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                    <Loader2 className="me-2 inline h-4 w-4 animate-spin" />{t('common.loading', { defaultValue: 'Loading...' })}
                  </TableCell></TableRow>
                ) : loadError ? (
                  <TableRow><TableCell colSpan={8} className="h-32 text-center text-destructive">
                    {t('inventoryTransfer.batch.loadError', { defaultValue: 'Could not load transfer batches. Check your connection and try again.' })}
                  </TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="h-36 text-center">
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 text-muted-foreground">
                      <FileText className="h-8 w-8 opacity-40" />
                      <span className="font-semibold text-foreground">{t('inventoryTransfer.batch.emptyTitle', { defaultValue: 'No transfer batches found' })}</span>
                      <span className="text-sm">{search || dateRange !== 'allTime'
                        ? t('inventoryTransfer.batch.emptyFiltered', { defaultValue: 'Try changing the search or date range.' })
                        : t('inventoryTransfer.batch.emptyDescription', { defaultValue: 'Completed inventory transfers will appear here.' })}</span>
                    </div>
                  </TableCell></TableRow>
                ) : rows.map((row) => {
                  const batch = row.batch
                  const sourceWorkspace = batch.sourceWorkspaceName || workspaceName || '—'
                  const destinationWorkspace = batch.destinationWorkspaceName || workspaceName || '—'
                  return (
                    <TableRow key={batch.id}>
                      <TableCell className="whitespace-nowrap font-semibold">
                        <span className="inline-flex items-center gap-2"><FileText className="h-4 w-4 text-primary" />{batch.transferNumber}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{formatDateTime(batch.transferredAt)}</TableCell>
                      <TableCell className="min-w-52">
                        <div className="font-medium">{sourceWorkspace}</div>
                        <div className="text-xs text-muted-foreground">{batch.sourceStorageName || '—'}</div>
                      </TableCell>
                      <TableCell className="min-w-52">
                        <div className="font-medium">{destinationWorkspace}</div>
                        <div className="text-xs text-muted-foreground">{batch.destinationStorageName || '—'}</div>
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{quantityFormatter.format(row.productCount)}</TableCell>
                      <TableCell>{row.performedByName || batch.performedBy || '—'}</TableCell>
                      <TableCell><Badge variant={batch.status === 'completed' ? 'secondary' : 'outline'}>{printStatus(batch.status)}</Badge></TableCell>
                      <TableCell className="text-end">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('inventoryTransfer.batch.viewDetails', { defaultValue: 'View Details' })}
                            title={t('inventoryTransfer.batch.viewDetails', { defaultValue: 'View Details' })}
                            onClick={() => void handleViewDetails(row)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('common.print', { defaultValue: 'Print' })}
                            title={t('common.print', { defaultValue: 'Print' })}
                            onClick={() => void handlePrint(row)}
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <AppPagination
        currentPage={page}
        totalCount={totalCount}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(value) => { setPageSize(value); setPage(1) }}
        className="justify-end"
      />

      <AppDialog open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
        <AppDialogContent className="max-w-5xl">
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2"><ArrowLeftRight className="h-5 w-5 text-primary" />
              {selectedDetails?.batch.transferNumber || t('inventoryTransfer.batch.detailsTitle', { defaultValue: 'Transfer Batch Details' })}
            </AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody className="space-y-5">
            {isLoadingDetails ? (
              <div className="flex min-h-36 items-center justify-center text-muted-foreground">
                <Loader2 className="me-2 h-4 w-4 animate-spin" />{t('common.loading', { defaultValue: 'Loading...' })}
              </div>
            ) : detailsLoadError ? (
              <div className="flex min-h-36 items-center justify-center text-center text-destructive">
                {t('inventoryTransfer.batch.detailsError', { defaultValue: 'Could not load transfer details. Refresh and try again.' })}
              </div>
            ) : !selectedDetails ? (
              <div className="flex min-h-36 items-center justify-center text-muted-foreground">
                {t('inventoryTransfer.batch.detailsUnavailable', { defaultValue: 'Transfer details are unavailable.' })}
              </div>
            ) : (
              <>
                <div className="grid gap-3 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Detail label={t('inventoryTransfer.batch.columns.transferNumber', { defaultValue: 'Transfer Number' })} value={selectedDetails.batch.transferNumber} />
                  <Detail label={t('inventoryTransfer.batch.columns.date', { defaultValue: 'Date / Time' })} value={formatDateTime(selectedDetails.batch.transferredAt)} />
                  <Detail label={t('inventoryTransfer.batch.columns.performedBy', { defaultValue: 'Performed By' })} value={selectedDetails.performedByName || selectedDetails.batch.performedBy || '—'} />
                  {areTransferBatchWorkspacesSame(selectedDetails) ? (
                    <Detail label={selectedDetails.sourceIsBranch || selectedDetails.destinationIsBranch || branchInfo?.isBranch
                      ? t('inventoryTransfer.batch.branch', { defaultValue: 'Branch' })
                      : t('inventoryTransfer.batch.workspace', { defaultValue: 'Workspace' })}
                    value={selectedDetails.batch.sourceWorkspaceName || selectedDetails.batch.destinationWorkspaceName || workspaceName || '—'} />
                  ) : (
                    <>
                      <Detail label={selectedDetails.sourceIsBranch
                        ? t('inventoryTransfer.batch.fromBranch', { defaultValue: 'From Branch' })
                        : t('inventoryTransfer.batch.fromWorkspace', { defaultValue: 'From Workspace' })}
                      value={selectedDetails.batch.sourceWorkspaceName || '—'} />
                      <Detail label={selectedDetails.destinationIsBranch
                        ? t('inventoryTransfer.batch.toBranch', { defaultValue: 'To Branch' })
                        : t('inventoryTransfer.batch.toWorkspace', { defaultValue: 'To Workspace' })}
                      value={selectedDetails.batch.destinationWorkspaceName || '—'} />
                    </>
                  )}
                  <Detail label={t('inventoryTransfer.batch.fromStorage', { defaultValue: 'From Storage' })} value={selectedDetails.batch.sourceStorageName || '—'} />
                  <Detail label={t('inventoryTransfer.batch.toStorage', { defaultValue: 'To Storage' })} value={selectedDetails.batch.destinationStorageName || '—'} />
                  <Detail label={t('inventoryTransfer.batch.statusLabel', { defaultValue: 'Status' })} value={printStatus(selectedDetails.batch.status)} />
                  {selectedDetails.batch.notes ? <Detail label={t('inventoryTransfer.batch.notes', { defaultValue: 'Notes' })} value={selectedDetails.batch.notes} /> : null}
                </div>
                <div className="overflow-hidden rounded-xl border">
                  <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-3 font-semibold">
                    <Warehouse className="h-4 w-4 text-primary" />{t('inventoryTransfer.batch.products', { defaultValue: 'Products Transferred' })}
                    <Badge variant="secondary" className="ms-auto">{selectedDetails.products.length}</Badge>
                  </div>
                  <div className="max-h-[44vh] overflow-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-background">
                        <TableRow>
                          <TableHead>{t('inventoryTransfer.batch.columns.product', { defaultValue: 'Product' })}</TableHead>
                          <TableHead>{t('inventoryTransfer.batch.columns.sku', { defaultValue: 'SKU' })}</TableHead>
                          <TableHead className="text-end">{t('inventoryTransfer.batch.columns.quantity', { defaultValue: 'Quantity' })}</TableHead>
                          <TableHead>{t('inventoryTransfer.batch.columns.unit', { defaultValue: 'Unit' })}</TableHead>
                          <TableHead>{t('inventoryTransfer.batch.columns.batchLot', { defaultValue: 'Batch / Lot' })}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedDetails.products.map((product) => (
                          <TableRow key={product.transactionId}>
                            <TableCell className="font-medium">{product.productName || t('inventoryTransfer.transactions.unknownProduct', { defaultValue: 'Unknown product' })}</TableCell>
                            <TableCell>{product.sku || '—'}</TableCell>
                            <TableCell className="text-end tabular-nums">{quantityFormatter.format(product.quantity)}</TableCell>
                            <TableCell>{product.unit || '—'}</TableCell>
                            <TableCell>{product.batchAllocations.map((allocation) => allocation.batchNumber).filter(Boolean).join(', ') || '—'}</TableCell>
                          </TableRow>
                        ))}
                        {selectedDetails.products.length === 0 ? (
                          <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">{t('inventoryTransfer.batch.noProducts', { defaultValue: 'No products are linked to this transfer batch.' })}</TableCell></TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </>
            )}
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setIsDetailsOpen(false)}>
              {t('common.close', { defaultValue: 'Close' })}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      {printData && templatePreview && activePrintLayout ? (
        <PrintFlow
          isOpen={isPrintOpen}
          onClose={() => { setIsPrintOpen(false); setSelectedPrintTemplate(null) }}
          onConfirm={() => { setIsPrintOpen(false); setSelectedPrintTemplate(null) }}
          title={t('inventoryTransfer.batch.printTitle', { defaultValue: 'Print Inventory Transfer' })}
          documentId={printData.batch.id}
          originId={printData.batch.id}
          pdfBuilder={buildPrintPdf}
          templatePreview={templatePreview}
          customTemplate={{
            moduleTypeKey: INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY,
            nativeTemplateKey: TRANSFER_TEMPLATE_TARGET?.nativeTemplateKey || INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY,
            templateId: selectedPrintTemplate?.id,
            label: selectedPrintTemplate
              ? getStoredCustomTemplateLabel(selectedPrintTemplate)
              : t('inventoryTransfer.batch.atlasStandard', { defaultValue: 'Inventory Transfer · Atlas Standard' }),
          }}
          initialTemplateLayout={activePrintLayout}
          enableTemplatePreviewSave
          generateTemplateLayoutBlob={buildEditedPrintPdf}
          showSaveButton={false}
          onPreviewPrint={async (blob) => {
            await printPdfBlob(blob, { title: t('inventoryTransfer.batch.printTitle', { defaultValue: 'Print Inventory Transfer' }) })
            setIsPrintOpen(false)
          }}
          features={features}
          workspaceName={workspaceName}
          module="inventoryTransfer"
          allowA4Document
          printSelectionOptions={[{
            format: 'a4',
            nativeTemplateKey: INVENTORY_TRANSFER_BATCH_TEMPLATE_KEY,
            label: t('inventoryTransfer.batch.atlasStandard', { defaultValue: 'Inventory Transfer · Atlas Standard' }),
            description: t('inventoryTransfer.batch.atlasStandardDescription', { defaultValue: 'Print the complete transfer batch using the Atlas Standard layout.' }),
          }]}
          printSelectionTemplates={printOptions}
          onPrintSelection={handlePrintSelection}
        />
      ) : null}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold">{value || '—'}</div>
    </div>
  )
}
