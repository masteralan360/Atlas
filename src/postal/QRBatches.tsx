import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { ArrowLeft, Ban, CheckCircle2, Eye, Link2, Loader2, Plus, Printer, QrCode, Trash2, Unlink } from 'lucide-react'
import {
  AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle,
  Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useToast,
} from '@/ui/components'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { AppPagination } from '@/ui/components/AppPagination'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { useDateRange } from '@/context/DateRangeContext'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { postalCommand, type PostalScope } from '@/local-db/postal'
import { fetchPostalGeneratedQrsForBatch, postalQrTables, usePostalQrBatches, usePostalQrBatch, usePostalGeneratedQrs, type PostalQrBatch, type PostalGeneratedQr } from '@/local-db/postalQrBatches'
import { usePostalAction } from './usePostalAccess'
import { OrganizationAutoCompleteInput } from './OrganizationAutoCompleteInput'
import { formatPostalShipmentId, type PostalOrganization } from './domain'
import { ShipmentQr } from './ShipmentLabel'
import { PostalError, PostalLoading } from './shared'
import { PrintSelectionModal, type PrintSelectionTemplateOption } from '@/ui/components/PrintSelectionModal'
import { loadPostalQrBatchLabelTemplates } from '@/lib/postalShipmentLabelTemplates'
import { getCustomTemplateTarget, getStoredCustomTemplateLabel, readCustomTemplateLayout, type StoredCustomTemplateRow } from '@/lib/customTemplates'
import { preparePostalQrBatchCustomLabel, preparePostalQrBatchLabel, type PostalQrBatchLabelSize } from './printing'
import { useWorkspacePermissions } from '@/permissions'
import { useWorkspace } from '@/workspace'

const SIZES = [20, 50, 100]
function useQrPagination(resetOn: readonly unknown[]) {
  return usePaginationState({ resetOn,
    initialPageSize: (() => { const saved = Number(localStorage.getItem('postal_qr_page_size')); return SIZES.includes(saved) ? saved : 20 })(),
    onPageSizeChange: (size) => localStorage.setItem('postal_qr_page_size', String(size)),
  })
}
function QrTable<T>({ rows, columns, total, page, pageSize }: { rows: T[]; columns: ColumnDef<T>[]; total: number; page: number; pageSize: number }) {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(),
    manualPagination: true, manualSorting: true, manualFiltering: true, rowCount: total,
    state: { pagination: { pageIndex: page - 1, pageSize } } })
  return <div className="overflow-x-auto rounded-xl border"><Table>
    <TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>
      {group.headers.map((header) => <TableHead key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}
    </TableRow>)}</TableHeader>
    <TableBody>{table.getRowModel().rows.map((row) => <TableRow key={row.id}>
      {row.getVisibleCells().map((cell) => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
    </TableRow>)}</TableBody>
  </Table></div>
}
function BatchStatus({ active }: { active: boolean }) {
  const { t } = useTranslation()
  return <Badge variant={active ? 'default' : 'secondary'}>{t(active ? 'postal.active' : 'postal.inactive')}</Badge>
}
function BatchActions({ scope, batch }: { scope: PostalScope; batch: PostalQrBatch }) {
  const { t } = useTranslation()
  const action = usePostalAction()
  const [deleting, setDeleting] = useState(false)
  const [, navigate] = useLocation()
  const execute = (command: string, payload: object) => void action.run(JSON.stringify([command, payload]), async (request) => {
    await postalCommand(scope, command, payload, request)
    if (command === 'delete_qr_batch') setDeleting(false)
  })
  return <div className="flex flex-wrap gap-2">
    <Button variant="outline" size="sm" onClick={() => navigate(`/post-service/qr-batches/${batch.id}`)}><Eye className="me-1 h-4 w-4" />{t('postal.view')}</Button>
    <Button variant="outline" size="sm" disabled={action.busy} onClick={() => execute('set_qr_batch_active', { id: batch.id, active: !batch.active })}>
      {action.busy ? <Loader2 className="me-1 h-4 w-4 animate-spin" /> : batch.active ? <Ban className="me-1 h-4 w-4" /> : <CheckCircle2 className="me-1 h-4 w-4" />}
      {t(batch.active ? 'postal.qr.deactivate' : 'postal.qr.activate')}
    </Button>
    <Button variant="destructive" size="sm" disabled={action.busy || batch.claimed_count > 0} title={batch.claimed_count ? t('postal.qr.errors.hasClaims') : undefined} onClick={() => setDeleting(true)}>
      <Trash2 className="me-1 h-4 w-4" />{t('common.delete')}
    </Button>
    <DeleteConfirmationModal isOpen={deleting} isLoading={action.busy} itemName={batch.id}
      title={t('postal.qr.deleteTitle')} description={t('postal.qr.deleteDescription')}
      onClose={() => { if (!action.busy) setDeleting(false) }} onConfirm={() => execute('delete_qr_batch', { id: batch.id })} />
  </div>
}
export function GenerateQrBatchDialog({ scope, onClose }: { scope: PostalScope; onClose: () => void }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const action = usePostalAction()
  const [quantity, setQuantity] = useState('')
  const [organizationQuery, setOrganizationQuery] = useState('')
  const [organization, setOrganization] = useState<PostalOrganization | null>(null)
  const count = Number(quantity)
  const valid = /^\d+$/.test(quantity) && Number.isSafeInteger(count) && count > 0 && count <= 10000
    && (!organizationQuery.trim() || !!organization)
  const clear = () => { setOrganization(null); setOrganizationQuery('') }
  return <AppDialog open onOpenChange={(open) => { if (!open && !action.busy) onClose() }}>
    <AppDialogContent className="max-w-xl" showCloseButton={!action.busy}>
      <AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><QrCode className="h-5 w-5" />{t('postal.qr.generate')}</AppDialogTitle></AppDialogHeader>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
        event.preventDefault()
        if (!valid || action.busy) return
        const payload = { quantity: count, organization_id: organization?.id ?? null }
        void action.run(JSON.stringify(payload), async (request) => {
          await postalCommand(scope, 'generate_qr_batch', payload, request)
          toast({ title: t('postal.qr.generated') })
          onClose()
        })
      }}>
        <AppDialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="qr-quantity">{t('postal.qr.quantity')} *</Label>
            <Input id="qr-quantity" inputMode="numeric" placeholder="0" required disabled={action.busy}
              value={quantity ? Number(quantity).toLocaleString('en-US') : ''}
              aria-describedby="qr-quantity-hint" onChange={(event) => setQuantity(event.target.value.replace(/[^0-9]/g, '').slice(0, 5))} />
            <p id="qr-quantity-hint" className="text-sm text-muted-foreground">{t('postal.qr.quantityHint')}</p>
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2"><Label htmlFor="qr-organization">{t('postal.qr.restriction')}</Label>
              {organization && <><Badge variant="secondary"><Link2 className="me-1 h-3 w-3" />{t('postal.linked')}</Badge>
                <Button type="button" size="sm" variant="ghost" disabled={action.busy} onClick={clear}><Unlink className="me-1 h-3 w-3" />{t('postal.statement.unlink')}</Button></>}
            </div>
            <OrganizationAutoCompleteInput id="qr-organization" scope={scope} value={organizationQuery} disabled={action.busy}
              onChange={(value) => { setOrganizationQuery(value); setOrganization(null) }}
              onSelectOrganization={(value) => { setOrganization(value); setOrganizationQuery(value.name) }} />
            <p className="text-sm text-muted-foreground">{t('postal.qr.unrestrictedHint')}</p>
          </div>
        </AppDialogBody>
        <AppDialogFooter><Button type="button" variant="outline" disabled={action.busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!valid || action.busy}>{action.busy ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Plus className="me-2 h-4 w-4" />}{t('postal.qr.generate')}</Button>
        </AppDialogFooter>
      </form>
    </AppDialogContent>
  </AppDialog>
}
export function QRBatches({ scope }: { scope: PostalScope }) {
  const { t, i18n } = useTranslation()
  const [generating, setGenerating] = useState(false)
  const { dateRange, customDates, dateFilterDayBoundary } = useDateRange()
  const dates = getDateRangeBounds(dateRange, customDates, new Date(), dateFilterDayBoundary)
  const start = dates.start?.toISOString(), end = dates.end?.toISOString()
  const pagination = useQrPagination([scope.workspaceId, scope.userId, scope.permissionScope, start, end])
  const query = usePostalQrBatches({ ...scope, page: pagination.currentPage, pageSize: pagination.pageSize, start, end })
  const bounds = usePaginationBounds({ ...pagination, totalCount: query.data?.total, isLoading: query.isFetching, error: query.error })
  const columns = useMemo<ColumnDef<PostalQrBatch>[]>(() => [
    { accessorKey: 'id', header: t('postal.qr.batchId'), cell: ({ row }) => <bdi dir="ltr" className="font-mono text-xs">{row.original.id}</bdi> },
    { accessorKey: 'created_at', header: t('postal.createdAt'), cell: ({ row }) => new Date(row.original.created_at).toLocaleString(i18n.language) },
    ...(['quantity', 'claimed_count', 'unclaimed'] as const).map((key): ColumnDef<PostalQrBatch> => ({ id: key,
      header: t(`postal.qr.${key}`), cell: ({ row }) => (key === 'unclaimed' ? row.original.quantity - row.original.claimed_count : row.original[key]).toLocaleString(i18n.language) })),
    { id: 'restriction', header: t('postal.qr.restriction'), cell: ({ row }) => row.original.organization_name ?? t('postal.qr.unrestricted') },
    { id: 'active', header: t('postal.status'), cell: ({ row }) => <BatchStatus active={row.original.active} /> },
    { id: 'actions', header: t('postal.manage'), cell: ({ row }) => <BatchActions scope={scope} batch={row.original} /> },
  ], [scope, t, i18n.language])
  if (scope.role !== 'admin') return null
  return <section className="min-w-0 space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div>
      <h2 className="flex items-center gap-2 text-lg font-semibold"><QrCode className="h-5 w-5" />{t('postal.qrBatches')}</h2>
      <ModulePageFreshness tableNames={[...postalQrTables, 'postal_organizations']} />
    </div><Button onClick={() => setGenerating(true)}><Plus className="me-2 h-4 w-4" />{t('postal.qr.generate')}</Button></header>
    <div className="flex flex-wrap items-center justify-between gap-3"><DateRangeFilters />
      <AppPagination currentPage={bounds.currentPage} pageCount={bounds.pageCount} totalCount={query.data?.total ?? 0} pageSize={pagination.pageSize}
        onPageChange={pagination.setCurrentPage} onPageSizeChange={pagination.setPageSize} pageSizeOptions={SIZES} /></div>
    {query.isFetching || query.isPending ? <PostalLoading /> : query.error ? <PostalError retry={() => void query.refetch()} />
      : !query.data?.rows.length ? <p className="py-12 text-center text-muted-foreground">{t('postal.empty')}</p>
        : <QrTable rows={query.data.rows} columns={columns} total={query.data.total} page={bounds.currentPage} pageSize={pagination.pageSize} />}
    {generating && <GenerateQrBatchDialog scope={scope} onClose={() => setGenerating(false)} />}
  </section>
}
export function QRBatchDetail({ scope, batchId }: { scope: PostalScope; batchId: string }) {
  const { t, i18n } = useTranslation()
  const [, navigate] = useLocation()
  const { workspaceName } = useWorkspace()
  const { permissionKeys } = useWorkspacePermissions()
  const { toast } = useToast()
  const batch = usePostalQrBatch(scope, batchId)
  const [status, setStatus] = useState<'all' | 'claimed' | 'unclaimed'>('all')
  const [print, setPrint] = useState(false)
  const [preparingPrint, setPreparingPrint] = useState(false)
  const [printQrIds, setPrintQrIds] = useState<string[]>([])
  const [shipmentLabelTemplates, setShipmentLabelTemplates] = useState<StoredCustomTemplateRow[]>([])
  const printAbortRef = useRef<AbortController | null>(null)
  const pagination = useQrPagination([scope.workspaceId, scope.userId, batchId, status])
  const query = usePostalGeneratedQrs({ ...scope, batchId, status, page: pagination.currentPage, pageSize: pagination.pageSize })
  const reload = () => { void Promise.allSettled([batch.refetch(), query.refetch()]) }
  const bounds = usePaginationBounds({ ...pagination, totalCount: query.data?.total, isLoading: query.isFetching, error: query.error })
  const canPrint = !permissionKeys.includes('global.NOprint')
  useEffect(() => {
    let isCurrent = true
    setShipmentLabelTemplates([])
    void loadPostalQrBatchLabelTemplates(scope.workspaceId).then((result) => {
      if (isCurrent && !result.failed) setShipmentLabelTemplates(result.templates)
    })
    return () => { isCurrent = false }
  }, [scope.workspaceId])
  useEffect(() => () => printAbortRef.current?.abort(), [])
  const shipmentLabelTemplateOptions = useMemo<PrintSelectionTemplateOption[]>(() => shipmentLabelTemplates.flatMap((template) => {
    const target = getCustomTemplateTarget(template.module_type_key)
    const layout = readCustomTemplateLayout(template)
    if (!target?.page || !layout) return []
    return [{
      format: 'label' as const,
      template,
      label: getStoredCustomTemplateLabel(template),
      description: t('postal.customLabelTemplateDescription', {
        width: target.page.widthMm,
        height: target.page.heightMm,
      }),
      primary: template.primary,
    }]
  }), [shipmentLabelTemplates, t])
  const beginBatchPrint = async () => {
    if (!batch.data || preparingPrint || !canPrint) return
    const controller = new AbortController()
    printAbortRef.current?.abort()
    printAbortRef.current = controller
    setPreparingPrint(true)
    setPrintQrIds([])
    setPrint(true)
    try {
      const result = await fetchPostalGeneratedQrsForBatch(scope, batchId, controller.signal)
      if (controller.signal.aborted) return
      if (result.total !== batch.data.quantity || result.rows.length !== batch.data.quantity) throw new Error('postal_qr_batch_incomplete')
      setPrintQrIds(result.rows.map((row) => row.id))
      setPrint(true)
    } catch {
      if (!controller.signal.aborted) toast({
        title: t('common.error', { defaultValue: 'Error' }),
        description: t('postal.qr.printLoadError'),
        variant: 'destructive',
      })
      if (!controller.signal.aborted) setPrint(false)
    } finally {
      if (printAbortRef.current === controller) {
        printAbortRef.current = null
        setPreparingPrint(false)
      }
    }
  }
  const handlePrintSelection = (
    _format: import('@/services/pdfGenerator').PrintFormat,
    template?: StoredCustomTemplateRow,
    nativeTemplateKey?: string,
  ) => {
    try {
      if (template) {
        preparePostalQrBatchCustomLabel(printQrIds, scope.workspaceId, workspaceName || 'Atlas', template, i18n.language)
      } else {
        const size: PostalQrBatchLabelSize = nativeTemplateKey === 'postal-small-shipment-qr-label' ? 'small-qr' : 'standard'
        preparePostalQrBatchLabel(printQrIds, scope.workspaceId, t, workspaceName || 'Atlas', size)
      }
      setPrint(false)
      navigate('/print-preview-editor')
    } catch {
      setPrint(false)
      toast({
        title: t('common.error', { defaultValue: 'Error' }),
        description: t('postal.qr.printLoadError'),
        variant: 'destructive',
      })
    }
  }
  const closePrintSelection = () => {
    printAbortRef.current?.abort()
    printAbortRef.current = null
    setPreparingPrint(false)
    setPrint(false)
  }
  const columns = useMemo<ColumnDef<PostalGeneratedQr>[]>(() => [
    { id: 'qr', header: t('postal.shipmentQr'), cell: ({ row }) => <div className="w-32"><ShipmentQr qrId={row.original.id} size={128} /></div> },
    { accessorKey: 'id', header: t('postal.qr.identifier'), cell: ({ row }) => <bdi dir="ltr" className="font-mono text-xs">{row.original.id}</bdi> },
    { id: 'status', header: t('postal.status'), cell: ({ row }) => <Badge variant={row.original.claimed_at ? 'default' : 'secondary'}>{t(row.original.claimed_at ? 'postal.qr.claimed' : 'postal.qr.unclaimed')}</Badge> },
    { id: 'shipment', header: t('postal.shipmentId'), cell: ({ row }) => {
      const qr = row.original
      if (!qr.shipment_number || !qr.shipment_created_at) return '—'
      const id = formatPostalShipmentId({ shipment_number: qr.shipment_number, created_at: qr.shipment_created_at })
      return <Button variant="link" className="font-mono" onClick={() => navigate(`/post-service/shipments/${id}`)}><Eye className="me-1 h-4 w-4" /><bdi dir="ltr">{id}</bdi></Button>
    } },
    { accessorKey: 'organization_name', header: t('postal.organizationName'), cell: ({ row }) => row.original.organization_name ?? '—' },
    { accessorKey: 'claimant_name', header: t('postal.qr.claimant'), cell: ({ row }) => row.original.claimant_name ?? '—' },
    { accessorKey: 'claimed_at', header: t('postal.qr.claimedAt'), cell: ({ row }) => row.original.claimed_at ? new Date(row.original.claimed_at).toLocaleString(i18n.language) : '—' },
  ], [t, i18n.language, navigate])
  if (scope.role !== 'admin') return null
  return <div className="w-full min-w-0 space-y-5 p-3 sm:p-6">
    <header className="flex flex-wrap items-center gap-3"><Button variant="outline" onClick={() => navigate('/post-service/qr-batches')}><ArrowLeft className="me-2 h-4 w-4" />{t('postal.qrBatches')}</Button>
      <h1 className="flex items-center gap-2 text-2xl font-bold"><QrCode className="h-6 w-6" />{t('postal.qr.viewTitle')}</h1>
      <ModulePageFreshness tableNames={postalQrTables} />
      <Button size="lg" className="w-full gap-2 shadow-sm sm:ms-auto sm:w-auto" disabled={!canPrint || !batch.data || preparingPrint} onClick={() => void beginBatchPrint()}>
        {preparingPrint ? <Loader2 className="h-5 w-5 animate-spin" /> : <Printer className="h-5 w-5" />}
        {t('postal.printQr')}
      </Button>
    </header>
    {batch.isFetching || batch.isPending ? <PostalLoading /> : batch.error || !batch.data ? <PostalError retry={reload} /> : <>
      <dl className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [t('postal.qr.batchId'), <bdi dir="ltr" className="break-all font-mono">{batch.data.id}</bdi>],
          [t('postal.createdAt'), new Date(batch.data.created_at).toLocaleString(i18n.language)],
          [t('postal.status'), <BatchStatus active={batch.data.active} />],
          [t('postal.qr.restriction'), batch.data.organization_name ?? t('postal.qr.unrestricted')],
          [t('postal.qr.quantity'), batch.data.quantity.toLocaleString(i18n.language)],
          [t('postal.qr.claimed_count'), batch.data.claimed_count.toLocaleString(i18n.language)],
          [t('postal.qr.unclaimed'), (batch.data.quantity - batch.data.claimed_count).toLocaleString(i18n.language)],
          [t('postal.qr.createdBy'), <bdi dir="ltr" className="break-all font-mono">{batch.data.created_by}</bdi>],
        ].map(([label, value], index) => <div key={index}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-medium">{value}</dd></div>)}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={status} onValueChange={(value) => { if (value === 'all' || value === 'claimed' || value === 'unclaimed') setStatus(value) }}>
          <SelectTrigger className="w-full sm:w-48" aria-label={t('postal.status')}><SelectValue /></SelectTrigger>
          <SelectContent>{(['all', 'claimed', 'unclaimed'] as const).map((value) => <SelectItem key={value} value={value}>{t(value === 'all' ? 'postal.allStatuses' : `postal.qr.${value}`)}</SelectItem>)}</SelectContent>
        </Select>
        <AppPagination currentPage={bounds.currentPage} pageCount={bounds.pageCount} totalCount={query.data?.total ?? 0} pageSize={pagination.pageSize}
          onPageChange={pagination.setCurrentPage} onPageSizeChange={pagination.setPageSize} pageSizeOptions={SIZES} />
      </div>
      {query.isFetching || query.isPending ? <PostalLoading /> : query.error ? <PostalError retry={() => void query.refetch()} />
        : !query.data?.rows.length ? <p className="py-12 text-center text-muted-foreground">{t('postal.empty')}</p>
          : <QrTable rows={query.data.rows} columns={columns} total={query.data.total} page={bounds.currentPage} pageSize={pagination.pageSize} />}
    </>}
    <PrintSelectionModal
      isOpen={print}
      onClose={closePrintSelection}
      isLoading={preparingPrint}
      loadingMessage={t('postal.qr.loadingLabels')}
      nativeOptions={[
        {
          format: 'label',
          label: t('postal.shipmentLabel'),
          description: t('postal.labelSize'),
          nativeTemplateKey: 'postal-standard-shipment-label',
        },
        {
          format: 'label',
          label: t('postal.smallShipmentQrLabel'),
          description: t('postal.smallShipmentQrLabelSize'),
          nativeTemplateKey: 'postal-small-shipment-qr-label',
        },
      ]}
      templateOptions={shipmentLabelTemplateOptions}
      onSelect={handlePrintSelection}
    />
  </div>
}
