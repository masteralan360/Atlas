import { usePostalScope } from '@/postal/usePostalAccess'
import { useAuth } from '@/auth'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import {
  ArrowDownLeft,
  ArrowUpRight,
  PackageCheck,
  Plus,
  ScanLine,
  Search,
  Eye,
  Building2,
  MapPin,
  Users,
  Wallet,
  HandCoins,
  Scale,
  Loader2,
  CircleDollarSign,
  FileText,
  QrCode,
  Printer,
  Star,
} from 'lucide-react'
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@/ui/components'
import { AppPagination } from '@/ui/components/AppPagination'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { WorkspaceAccountCreation } from '@/ui/components/workspace/WorkspaceAccountCreation'
import { CameraBarcodeScannerModal } from '@/ui/components/pos/CameraBarcodeScannerModal'
import {
  usePaginationState,
  usePaginationBounds,
} from '@/hooks/usePaginationState'
import { useDateRange } from '@/context/DateRangeContext'
import {
  usePostalPage,
  usePostalSummary,
  usePostalLocationCatalog,
  postalSummaryTables,
  postalTables,
  resolvePostalQr,
  getPostalOrganization,
} from '@/local-db/postal'
import { PostalDashboardCards } from '@/postal/PostalDashboardCards'
import { OperationDialog } from '@/postal/OperationDialog'
import {
  postalStates,
  locationLabel,
  emptyPostalLocationCatalog,
  formatPostalShipmentId,
  parseShipmentQr,
  type PostalShipment,
  type PostalState,
  type PostalBranch,
  type PostalOrganization,
  type PostalCodRecord,
} from '@/postal/domain'
import { PostalLoading, PostalError } from '@/postal/shared'
import { CreateShipmentFlow } from '@/postal/CreateShipmentFlow'
import {
  AddAllGovernoratesDialog,
  BranchDialog,
  OrganizationDialog,
} from '@/postal/ManagementDialogs'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { getPaymentMethodLabel } from '@/lib/paymentMethods'
import type { PaymentMethodOption } from '@/lib/paymentMethods'
import { OrganizationAccountStatement } from '@/postal/OrganizationAccountStatement'
import { canReadPostalStatement } from '@/local-db/postalStatement'
import { CreateOrganizationDialog } from '@/postal/CreateOrganizationDialog'
import { QRBatches } from '@/postal/QRBatches'
import { useWorkspace } from '@/workspace'
import { AutoScanPrinterDialog } from '@/postal/AutoScanPrinterDialog'
import {
  getPostalAutoScanEnabled,
  getPostalAutoScanPrinter,
  savePostalAutoScanEnabled,
} from '@/postal/autoScanSettings'
import { loadPostalShipmentLabelTemplates } from '@/lib/postalShipmentLabelTemplates'
import { buildPostalLabelPdf } from '@/postal/printing'
import {
  printService,
  AutoScanNativePrintingUnavailableError,
  AutoScanPrinterPaperSizeUnsupportedError,
  AutoScanPrinterUnavailableError,
} from '@/services/printService'
import type { StoredCustomTemplateRow } from '@/lib/customTemplates'
import { useWorkspacePermissions } from '@/permissions'

type PostalShipmentPageRow = PostalShipment & { organization_name?: string | null }
type Row = PostalShipmentPageRow | PostalBranch | PostalOrganization | PostalCodRecord
const SINGLE = ['single'] as const
const postalStatusClasses: Record<PostalState, string> = {
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  received: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  in_transit: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  arrived: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300',
  out_for_delivery: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  postponed: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  cancelled: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
}

function formatCodIqd(value: string, language: string, currency: string) {
  return `${new Intl.NumberFormat(language).format(BigInt(value))} ${currency}`
}

export default function PostalServicePage({ accountStatement = false, qrBatches = false }: { accountStatement?: boolean; qrBatches?: boolean }) {
  const { t, i18n } = useTranslation()
  const scope = usePostalScope()
  const locationCatalogQuery = usePostalLocationCatalog(scope)
  const locationCatalog = locationCatalogQuery.data ?? emptyPostalLocationCatalog
  const { user } = useAuth()
  const [, navigate] = useLocation()
  const { toast } = useToast()
  const { workspaceName } = useWorkspace()
  const { permissionKeys } = useWorkspacePermissions()
  const canAccessAutoScan = user?.role === 'admin'
    || (user?.role === 'staff' && permissionKeys.includes('postService.officeEmployee'))
  const canAutoPrint = canAccessAutoScan && !permissionKeys.includes('global.NOprint')
  const canAutoPrintRef = useRef(canAutoPrint)
  canAutoPrintRef.current = canAutoPrint
  const autoScanContextRef = useRef({
    scope,
    workspaceName,
    language: i18n.language,
    t,
    toast,
    locationCatalog,
  })
  autoScanContextRef.current = { scope, workspaceName, language: i18n.language, t, toast, locationCatalog }
  const [tab, setTab] = useState<keyof typeof postalTables>('shipments')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [codKind, setCodKind] = useState<
    'all' | 'collection' | 'settlement'
  >('all')
  const [creating, setCreating] = useState(false)
  const [scanner, setScanner] = useState(false)
  const scannedId = useRef<string | null>(null)
  const [autoScanReceiveShipment, setAutoScanReceiveShipment] = useState<
    PostalShipment | null
  >(null)
  const autoScanReceiveResolveRef = useRef<(() => void) | null>(null)
  const [autoScanEnabled, setAutoScanEnabled] = useState(false)
  const autoScanEnabledRef = useRef(false)
  const [autoScanStarting, setAutoScanStarting] = useState(false)
  const [autoScanPrinter, setAutoScanPrinter] = useState<string | null>(null)
  const autoScanPrinterRef = useRef<string | null>(null)
  const [autoScanPrinterUnavailable, setAutoScanPrinterUnavailable] = useState(false)
  const autoScanPrinterUnavailableRef = useRef(false)
  const [autoScanPrinterDialogOpen, setAutoScanPrinterDialogOpen] = useState(false)
  const resumeAutoScanAfterPrinterSaveRef = useRef(false)
  const autoScanQueueRef = useRef<Promise<void>>(Promise.resolve())
  const labelTemplatesPromiseRef = useRef<Promise<StoredCustomTemplateRow[]> | null>(null)
  const [branch, setBranch] = useState<PostalBranch | 'new' | null>(null)
  const [addAllGovernoratesOpen, setAddAllGovernoratesOpen] = useState(false)
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false)
  const [organization, setOrganization] = useState<PostalOrganization | null>(
    null,
  )
  useEffect(() => {
    let current = true
    autoScanEnabledRef.current = false
    setAutoScanEnabled(false)
    autoScanPrinterRef.current = null
    setAutoScanPrinter(null)
    autoScanPrinterUnavailableRef.current = false
    setAutoScanPrinterUnavailable(false)

    void Promise.all([
      getPostalAutoScanPrinter(scope.workspaceId),
      getPostalAutoScanEnabled(scope.workspaceId),
    ]).then(async ([printerName, shouldResume]) => {
      if (!current) return
      autoScanPrinterRef.current = printerName
      setAutoScanPrinter(printerName)
      labelTemplatesPromiseRef.current = loadPostalShipmentLabelTemplates(scope.workspaceId)
        .then((result) => result.failed ? [] : result.templates)

      if (!shouldResume || !printerName || !canAutoPrintRef.current) return

      // Keep scans blocked until the saved printer's current status is known.
      autoScanPrinterUnavailableRef.current = true
      let printerAvailable = false
      try {
        printerAvailable = await printService.isSystemPrinterAvailable(printerName)
      } catch {
        printerAvailable = false
      }
      if (!current) return

      autoScanPrinterUnavailableRef.current = !printerAvailable
      setAutoScanPrinterUnavailable(!printerAvailable)
      autoScanEnabledRef.current = true
      setAutoScanEnabled(true)
      if (!printerAvailable) {
        const { t, toast } = autoScanContextRef.current
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.printerUnavailable'),
          variant: 'destructive',
        })
      }
    }).catch(() => undefined)
    return () => {
      current = false
    }
  }, [scope.workspaceId, canAutoPrint])

  const processAutoScan = useCallback(async (
    raw: string,
    context = autoScanContextRef.current,
    configuredPrinter = autoScanPrinterRef.current,
    templatesPromise = labelTemplatesPromiseRef.current,
  ) => {
    if (!canAutoPrintRef.current) return
    if (autoScanPrinterUnavailableRef.current) return
    const { scope, workspaceName, language, t, toast, locationCatalog } = context
    const qrId = parseShipmentQr(raw.trim())
    if (!qrId) {
      toast({
        title: t('common.error'),
        description: t('postal.autoScan.invalidQr'),
        variant: 'destructive',
      })
      return
    }

    let shipment: PostalShipment
    try {
      shipment = await resolvePostalQr(scope, raw.trim())
    } catch (error) {
      const errorCode = (error as { code?: unknown } | null)?.code
      toast({
        title: t('common.error'),
        description: errorCode === 'PGRST116'
          ? t('postal.autoScan.shipmentNotFound')
          : t('postal.autoScan.lookupFailed'),
        variant: 'destructive',
      })
      return
    }

    const receiveDialogPromise = shipment.state === 'draft'
      ? new Promise<void>((resolve) => {
          autoScanReceiveResolveRef.current = resolve
          setAutoScanReceiveShipment(shipment)
        })
      : null

    try {
      let organization: { name: string; phone: string | null }
      try {
        organization = await getPostalOrganization(scope, shipment.organization_id)
      } catch {
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.lookupFailed'),
          variant: 'destructive',
        })
        return
      }

      const templates = await templatesPromise?.catch(() => []) ?? []
      const primaryTemplate = templates.find((template) => template.primary)
      const label = await buildPostalLabelPdf(
        shipment,
        scope.workspaceId,
        {
          organizationName: organization.name,
          organizationPhoneNumber: organization.phone ?? '',
          workspaceName: workspaceName || 'Atlas',
        },
        language,
        primaryTemplate,
        locationCatalog,
      )
      if (!canAutoPrintRef.current) return
      if (autoScanPrinterUnavailableRef.current) return
      const printerName = configuredPrinter
      if (!printerName) {
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.printerRequired'),
          variant: 'destructive',
        })
        return
      }
      const destinationPath = await printService.printPdfToSystemPrinter(
        label,
        printerName,
        `${t('postal.shipmentLabel')} - ${formatPostalShipmentId(shipment)}`,
      )
      if (destinationPath) {
        const shipmentReference = formatPostalShipmentId(shipment)
        console.info('[Auto Scan dev print] status=saved', {
          shipment: shipmentReference,
          destination_path: destinationPath,
        })
        toast({
          title: t('postal.autoScan.devLabelSaved'),
          description: t('postal.autoScan.devLabelSavedDescription', {
            shipment: shipmentReference,
            path: destinationPath,
          }),
        })
        return
      }
      toast({
        title: t('postal.autoScan.labelSubmitted'),
        description: t('postal.autoScan.labelSubmittedDescription', {
          shipment: formatPostalShipmentId(shipment),
          printer: printerName,
        }),
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof AutoScanPrinterUnavailableError
          ? t('postal.autoScan.printerUnavailable')
          : error instanceof AutoScanPrinterPaperSizeUnsupportedError
            ? t('postal.autoScan.paperSizeUnsupported')
            : error instanceof AutoScanNativePrintingUnavailableError
              ? t('postal.autoScan.nativeUnavailable')
              : t('postal.autoScan.printFailed'),
        variant: 'destructive',
      })
    } finally {
      if (receiveDialogPromise) await receiveDialogPromise
    }
  }, [])

  const enqueueAutoScan = useCallback((raw: string) => {
    if (!autoScanEnabledRef.current) return
    const context = autoScanContextRef.current
    const configuredPrinter = autoScanPrinterRef.current
    const templatesPromise = labelTemplatesPromiseRef.current
    autoScanQueueRef.current = autoScanQueueRef.current
      .then(() => processAutoScan(raw, context, configuredPrinter, templatesPromise))
      .catch(() => undefined)
  }, [processAutoScan])

  useEffect(() => {
    if (canAutoPrint) return
    autoScanEnabledRef.current = false
    setAutoScanEnabled(false)
  }, [canAutoPrint])

  useEffect(() => {
    if (!autoScanEnabled || !autoScanPrinter) return
    let current = true
    let stopWatching: (() => void) | undefined
    autoScanPrinterUnavailableRef.current = false
    setAutoScanPrinterUnavailable(false)
    const reportAvailability = (available: boolean) => {
      if (!current) return
      const unavailable = !available
      if (unavailable && !autoScanPrinterUnavailableRef.current) {
        const { t, toast } = autoScanContextRef.current
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.printerUnavailable'),
          variant: 'destructive',
        })
      }
      autoScanPrinterUnavailableRef.current = unavailable
      setAutoScanPrinterUnavailable(unavailable)
    }
    void printService.watchSystemPrinterStatus(autoScanPrinter, reportAvailability)
      .then((stop) => {
        if (!current) {
          stop()
          return
        }
        stopWatching = stop
      })
      .catch((error) => {
        if (error instanceof AutoScanPrinterUnavailableError) reportAvailability(false)
      })
    return () => {
      current = false
      stopWatching?.()
    }
  }, [autoScanEnabled, autoScanPrinter])

  useEffect(() => {
    if (
      !autoScanEnabled ||
      autoScanPrinterDialogOpen ||
      scanner ||
      autoScanReceiveShipment
    ) return

    let buffer = ''
    let startedAt = 0
    let lastKeyAt = 0
    let largestGap = 0
    let idleTimer: number | undefined
    let lastCompleted: { value: string; at: number } | null = null

    const reset = () => {
      buffer = ''
      startedAt = 0
      lastKeyAt = 0
      largestGap = 0
      if (idleTimer !== undefined) window.clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const finish = (): boolean => {
      const value = buffer.trim()
      const endedAt = lastKeyAt
      const duration = endedAt - startedAt
      const scannerLike = value.length >= 12
        && duration <= Math.max(1800, value.length * 80)
        && largestGap <= 120
      reset()
      if (!scannerLike) return false

      const now = Date.now()
      if (lastCompleted?.value === value && now - lastCompleted.at < 300) return true
      lastCompleted = { value, at: now }
      enqueueAutoScan(value)
      return true
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
      // Keyboard-wedge scanners and the dev simulator emit Shift as a
      // standalone keydown before characters such as the QR payload's colons.
      // Ignore that modifier event without discarding the buffered scan.
      if (event.key === 'Shift') return
      const target = event.target
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || target.closest('input, textarea, select, [role="textbox"], [role="combobox"]')
      )) {
        reset()
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (buffer && finish()) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      if (event.key.length !== 1) {
        reset()
        return
      }

      const now = Date.now()
      const gap = lastKeyAt ? now - lastKeyAt : 0
      if (buffer && gap > 120) reset()
      if (!buffer) startedAt = now
      else largestGap = Math.max(largestGap, gap)
      buffer += event.key
      lastKeyAt = now
      if (idleTimer !== undefined) window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(finish, 130)
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      reset()
    }
  }, [autoScanEnabled, autoScanPrinterDialogOpen, scanner, autoScanReceiveShipment, enqueueAutoScan])

  const openAutoScanPrinterDialog = (resumeAfterSave: boolean) => {
    resumeAutoScanAfterPrinterSaveRef.current = resumeAfterSave
    setAutoScanPrinterDialogOpen(true)
  }
  const onAutoScanPrinterDialogOpenChange = (open: boolean) => {
    if (!open) resumeAutoScanAfterPrinterSaveRef.current = false
    setAutoScanPrinterDialogOpen(open)
  }
  const onAutoScanPrinterSaved = async (printerName: string) => {
    autoScanPrinterRef.current = printerName
    setAutoScanPrinter(printerName)
    const resume = resumeAutoScanAfterPrinterSaveRef.current
    resumeAutoScanAfterPrinterSaveRef.current = false
    setAutoScanPrinterDialogOpen(false)
    toast({ title: t('postal.autoScan.printerSaved') })
    if (resume && canAutoPrintRef.current) {
      try {
        await savePostalAutoScanEnabled(scope.workspaceId, true)
      } catch {
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.settingSaveFailed'),
          variant: 'destructive',
        })
        return
      }
      autoScanPrinterUnavailableRef.current = false
      setAutoScanPrinterUnavailable(false)
      autoScanEnabledRef.current = true
      setAutoScanEnabled(true)
      toast({ title: t('postal.autoScan.enabled') })
    }
  }
  const toggleAutoScan = async () => {
    if (autoScanEnabledRef.current) {
      autoScanEnabledRef.current = false
      setAutoScanEnabled(false)
      setAutoScanStarting(true)
      try {
        await savePostalAutoScanEnabled(scope.workspaceId, false)
        toast({ title: t('postal.autoScan.disabled') })
      } catch {
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.settingSaveFailed'),
          variant: 'destructive',
        })
      } finally {
        setAutoScanStarting(false)
      }
      return
    }
    if (!canAutoPrint) {
      toast({
        title: t('common.error'),
        description: t('postal.autoScan.printPermissionRequired'),
        variant: 'destructive',
      })
      return
    }
    if (!autoScanPrinterRef.current) {
      openAutoScanPrinterDialog(true)
      return
    }

    setAutoScanStarting(true)
    try {
      const printers = await printService.listSystemPrinters()
      if (!printers.some((printer) => printer.name === autoScanPrinterRef.current)) {
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.printerUnavailable'),
          variant: 'destructive',
        })
        openAutoScanPrinterDialog(false)
        return
      }
      try {
        await savePostalAutoScanEnabled(scope.workspaceId, true)
      } catch {
        toast({
          title: t('common.error'),
          description: t('postal.autoScan.settingSaveFailed'),
          variant: 'destructive',
        })
        return
      }
      autoScanEnabledRef.current = true
      autoScanPrinterUnavailableRef.current = false
      setAutoScanPrinterUnavailable(false)
      setAutoScanEnabled(true)
      toast({ title: t('postal.autoScan.enabled') })
    } catch {
      openAutoScanPrinterDialog(false)
    } finally {
      setAutoScanStarting(false)
    }
  }
  const { dateRange, customDates } = useDateRange()
  const dates = getDateRangeBounds(dateRange, customDates)
  const pagination = usePaginationState({
    initialPageSize: (() => {
      const saved = Number(localStorage.getItem('postal_page_size'))
      return [20, 50, 100].includes(saved) ? saved : 20
    })(),
    resetOn: [
      tab,
      search,
      status,
      codKind,
      dateRange,
      customDates.start,
      customDates.end,
    ],
    onPageSizeChange: (size) =>
      localStorage.setItem('postal_page_size', String(size)),
  })
  const query = usePostalPage<Row>({
    ...scope,
    kind: tab,
    page: pagination.currentPage,
    pageSize: pagination.pageSize,
    search,
    status,
    codKind,
    ...(tab === 'shipments' || tab === 'cod'
      ? { start: dates.start?.toISOString(), end: dates.end?.toISOString() }
      : {}),
  }, !accountStatement && !qrBatches)
  const summary = usePostalSummary(
    {
      ...scope,
      search,
      status,
      start: dates.start?.toISOString(),
      end: dates.end?.toISOString(),
    },
    !accountStatement && !qrBatches && tab === 'shipments',
  )
  const bounds = usePaginationBounds({
    ...pagination,
    totalCount: query.data?.total,
    isLoading: query.isFetching,
    error: query.error,
  })
  const columns = useMemo<ColumnDef<Row>[]>(() => {
    if (tab === 'shipments')
      return [
        {
          id: 'shipmentId',
          header: t('postal.shipmentId'),
          cell: ({ row }) => (
            <span className="font-mono" dir="ltr">
              {formatPostalShipmentId(row.original as PostalShipment)}
            </span>
          ),
        },
        ...(scope.role === 'admin'
          ? [
              {
                id: 'organization',
                header: t('postal.organizationName'),
                cell: ({ row }) => (
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    {(row.original as PostalShipmentPageRow).organization_name ?? '—'}
                  </span>
                ),
              } satisfies ColumnDef<Row>,
            ]
          : []),
        {
          id: 'recipient',
          header: t('postal.recipient_name'),
          cell: ({ row }) => {
            const s = row.original as PostalShipment
            return (
              <Button
                variant="link"
                className="h-auto p-0 font-semibold"
                onClick={() =>
                  navigate(`/post-service/shipments/${formatPostalShipmentId(s)}`)
                }
              >
                {s.recipient_name}
              </Button>
            )
          },
        },
        {
          id: 'status',
          header: t('postal.status'),
          cell: ({ row }) => {
            const state = (row.original as PostalShipment).state
            return (
              <span className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${postalStatusClasses[state]}`}>
                {t(`postal.states.${state}`)}
              </span>
            )
          },
        },
        {
          id: 'destination',
          header: t('postal.destination'),
          cell: ({ row }) => {
            const s = row.original as PostalShipment
            return `${locationLabel(s.governorate, i18n.language, undefined, locationCatalog)} / ${locationLabel(s.area, i18n.language, s.governorate, locationCatalog)}`
          },
        },
        {
          id: 'cod',
          header: t('postal.codAmount'),
          cell: ({ row }) =>
            `${Number((row.original as PostalShipment).cod_amount).toLocaleString(i18n.language)} ${t('postal.iqd')}`,
        },
        {
          id: 'view',
          header: t('postal.view'),
          cell: ({ row }) => (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate(
                  `/post-service/shipments/${formatPostalShipmentId(row.original as PostalShipment)}`,
                )
              }
            >
              <Eye className="me-2 h-4 w-4" />
              {t('postal.view')}
            </Button>
          ),
        },
      ]
    if (tab === 'branches')
      return [
        {
          accessorKey: 'name',
          header: t('postal.branchName'),
          cell: ({ row }) => {
            const branch = row.original as PostalBranch
            return (
              <span className="flex flex-wrap items-center gap-2">
                <span>{branch.name}</span>
                {branch.is_primary && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                    <Star className="h-3 w-3" />
                    {t('postal.primary')}
                  </span>
                )}
              </span>
            )
          },
        },
        {
          id: 'active',
          header: t('postal.status'),
          cell: ({ row }) =>
            t(
              (row.original as PostalBranch).active
                ? 'postal.active'
                : 'postal.inactive',
            ),
        },
        {
          id: 'edit',
          header: t('postal.manage'),
          cell: ({ row }) => (
            <Button
              variant="outline"
              onClick={() => setBranch(row.original as PostalBranch)}
            >
              {t('postal.manage')}
            </Button>
          ),
        },
      ]
    if (tab === 'organizations')
      return [
        { accessorKey: 'name', header: t('postal.organizationName') },
        {
          id: 'code',
          header: t('postal.organizationCode'),
          cell: ({ row }) => {
            const code = (row.original as PostalOrganization).code
            return (
              <span className="font-mono" dir="ltr">
                {code.slice(0, 4)}-{code.slice(4)}
              </span>
            )
          },
        },
        {
          id: 'edit',
          header: t('postal.manage'),
          cell: ({ row }) => (
            <Button
              variant="outline"
              onClick={() =>
                setOrganization(row.original as PostalOrganization)
              }
            >
              {t('postal.manage')}
            </Button>
          ),
        },
      ]
    if (tab === 'cod')
      return [
        {
          id: 'shipment',
          header: t('postal.shipmentAndRecipient'),
          cell: ({ row }) => {
            const record = row.original as PostalCodRecord
            const shipment = record.postal_shipments
            return (
              <div className="min-w-52 space-y-1">
                <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                  {shipment ? formatPostalShipmentId(shipment) : '—'}
                </span>
                <p className="font-semibold">{shipment?.recipient_name ?? '—'}</p>
                {shipment?.primary_phone && (
                  <p className="text-xs text-muted-foreground" dir="ltr">
                    {shipment.primary_phone}
                  </p>
                )}
              </div>
            )
          },
        },
        {
          id: 'merchant',
          header: t('postal.merchantOrganization'),
          cell: ({ row }) => (
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              {(row.original as PostalCodRecord).organization_name ?? '—'}
            </span>
          ),
        },
        {
          id: 'activity',
          header: t('postal.financialEvent'),
          cell: ({ row }) => {
            const record = row.original as PostalCodRecord
            const isCollection = record.kind === 'collection'
            const DirectionIcon = record.payment_direction === 'outgoing' ? ArrowUpRight : ArrowDownLeft
            return (
              <div className="space-y-1.5">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${isCollection ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-blue-500/10 text-blue-700 dark:text-blue-300'}`}>
                  {isCollection ? <ArrowDownLeft className="h-3.5 w-3.5" /> : <HandCoins className="h-3.5 w-3.5" />}
                  {t(`postal.${isCollection ? 'collectionEvent' : 'settlementEvent'}`)}
                </span>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <DirectionIcon className="h-3.5 w-3.5" />
                  {record.payment_direction ? t(`postal.${record.payment_direction}`) : '—'}
                </p>
              </div>
            )
          },
        },
        {
          id: 'amount',
          header: t('postal.codAmount'),
          cell: ({ row }) => {
            const amount = (row.original as PostalCodRecord).signed_amount
            return (
              <span className={`whitespace-nowrap font-semibold tabular-nums ${amount < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-300'}`} dir="ltr">
                {amount > 0 ? '+' : ''}{amount.toLocaleString(i18n.language)} {t('postal.iqd')}
              </span>
            )
          },
        },
        {
          id: 'method',
          header: t('postal.paymentMethod'),
          cell: ({ row }) => {
            const record = row.original as PostalCodRecord
            return (
              <div className="min-w-36 space-y-1">
                <p className="font-medium">
                  {record.payment_method
                    ? getPaymentMethodLabel(record.payment_method as PaymentMethodOption, t)
                    : '—'}
                </p>
                {record.account_name_snapshot && (
                  <p className="text-xs text-muted-foreground">
                    {record.account_name_snapshot}
                  </p>
                )}
                {record.reference_label && (
                  <p className="text-xs text-muted-foreground" dir="auto">
                    {record.reference_label}
                  </p>
                )}
                {record.notes && (
                  <p className="line-clamp-2 max-w-56 text-xs text-muted-foreground" title={record.notes}>
                    {record.notes}
                  </p>
                )}
              </div>
            )
          },
        },
        {
          accessorKey: 'created_at',
          header: t('postal.createdAt'),
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-sm text-muted-foreground">
              {new Date((row.original as PostalCodRecord).created_at).toLocaleString(i18n.language)}
            </span>
          ),
        },
        {
          id: 'view',
          header: t('postal.view'),
          cell: ({ row }) => {
            const shipment = (row.original as PostalCodRecord).postal_shipments
            return (
              <Button
                variant="outline"
                size="sm"
                disabled={!shipment}
                onClick={() => shipment && navigate(`/post-service/shipments/${formatPostalShipmentId(shipment)}`)}
              >
                <Eye className="me-2 h-4 w-4" />
                {t('postal.shipmentDetails')}
              </Button>
            )
          },
        },
      ]
    return []
  }, [tab, t, i18n.language, navigate, scope.role])
  const table = useReactTable({
    data: query.data?.rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualFiltering: true,
    manualSorting: true,
    rowCount: query.data?.total ?? 0,
    state: {
      pagination: {
        pageIndex: bounds.currentPage - 1,
        pageSize: pagination.pageSize,
      },
    },
  })
  const tabs = [
    { key: 'shipments', icon: PackageCheck },
    ...(scope.role === 'admin'
      ? [
          { key: 'branches', icon: Building2 },
          { key: 'organizations', icon: Users },
          { key: 'qrBatches', icon: QrCode },
        ]
      : []),
    { key: 'cod', icon: Wallet },
    ...(canReadPostalStatement(scope) ? [{ key: 'accountStatement', icon: FileText }] : []),
  ] as const
  return (
    <div className="w-full min-w-0 space-y-5 p-3 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <PackageCheck className="h-7 w-7 text-primary" />
            {t(
              scope.role === 'merchant' ? 'postal.myShipments' : 'postal.title',
            )}
          </h1>
          {!accountStatement && !qrBatches && <ModulePageFreshness
            tableNames={
              tab === 'shipments'
                ? scope.role === 'admin'
                  ? [...postalSummaryTables, 'postal_organizations', 'postal_locations', 'postal_governorates', 'postal_shipment_tariffs']
                  : [...postalSummaryTables, 'postal_locations', 'postal_governorates', 'postal_shipment_tariffs']
                : tab === 'cod'
                  ? ['postal_cod_records', 'postal_shipments', 'postal_organizations']
                  : [postalTables[tab]]
            }
          />}
        </div>
        <div className="flex flex-wrap gap-2">
          {(
            scope.role === 'merchant' ||
            scope.role === 'admin' ||
            scope.role === 'office'
          ) && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="me-2 h-4 w-4" />
              {t('postal.createShipment')}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              scannedId.current = null
              setScanner(true)
            }}
          >
            <ScanLine className="me-2 h-4 w-4" />
            {t('postal.trackShipment')}
          </Button>
          {canAccessAutoScan && (
            <Button
              type="button"
              variant={autoScanEnabled ? 'default' : 'outline'}
              aria-pressed={autoScanEnabled}
              disabled={autoScanStarting || !canAutoPrint}
              title={!canAutoPrint
                ? t('postal.autoScan.printPermissionRequired')
                : autoScanPrinterUnavailable
                  ? t('postal.autoScan.printerUnavailable')
                  : t('postal.autoScan.contextHint')}
              onContextMenu={(event) => {
                event.preventDefault()
                openAutoScanPrinterDialog(autoScanEnabledRef.current)
              }}
              onClick={(event) => {
                event.currentTarget.blur()
                void toggleAutoScan()
              }}
            >
              {autoScanStarting
                ? <Loader2 className="me-2 h-4 w-4 animate-spin" />
                : <Printer className="me-2 h-4 w-4" />}
              {t('postal.autoScan.title')}
            </Button>
          )}
        </div>
      </header>
      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label={t('postal.title')}
      >
        {tabs.map(({ key, icon: Icon }) => (
          <Button
            role="tab"
            aria-selected={qrBatches ? key === 'qrBatches' : accountStatement ? key === 'accountStatement' : tab === key}
            key={key}
            variant={(qrBatches ? key === 'qrBatches' : accountStatement ? key === 'accountStatement' : tab === key) ? 'default' : 'outline'}
            onClick={() => {
              if (key === 'qrBatches') navigate('/post-service/qr-batches')
              else if (key === 'accountStatement') navigate('/post-service/account-statement')
              else {
                setTab(key as keyof typeof postalTables)
                if (accountStatement || qrBatches) navigate('/post-service')
              }
            }}
          >
            <Icon className="me-2 h-4 w-4" />
            {t(`postal.${key}`)}
          </Button>
        ))}
      </div>
      {qrBatches ? scope.role === 'admin' && <QRBatches key={JSON.stringify(scope)} scope={scope} /> : accountStatement ? canReadPostalStatement(scope) && <OrganizationAccountStatement scope={scope} /> : <div className="space-y-4 rounded-xl border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          {(tab === 'shipments' || tab === 'cod') && (
            <div className="relative min-w-40 flex-1">
              <Search className="absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                className="ps-9"
                aria-label={t('common.search')}
                placeholder={tab === 'cod' ? t('postal.codSearchPlaceholder') : t('common.search')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
          {tab === 'shipments' && (
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('postal.allStatuses')}</SelectItem>
                {postalStates.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`postal.states.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {tab === 'cod' && (
            <Select value={codKind} onValueChange={(value) => setCodKind(value as typeof codKind)}>
              <SelectTrigger className="w-full sm:w-56" aria-label={t('postal.codEventFilter')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('postal.allCodEvents')}</SelectItem>
                <SelectItem value="collection">{t('postal.collectionEvent')}</SelectItem>
                <SelectItem value="settlement">{t('postal.settlementEvent')}</SelectItem>
              </SelectContent>
            </Select>
          )}
          {tab === 'branches' && (
            <>
              <Button onClick={() => setBranch('new')}>
                <Plus className="me-2 h-4 w-4" />
                {t('postal.createBranch')}
              </Button>
              <Button
                variant="outline"
                onClick={() => setAddAllGovernoratesOpen(true)}
              >
                <MapPin className="me-2 h-4 w-4" />
                {t('postal.addAllGovernorates')}
              </Button>
            </>
          )}
          {tab === 'organizations' && scope.role === 'admin' && (
            <>
              <WorkspaceAccountCreation accountType="postalMerchant" />
              <Button onClick={() => setCreateOrganizationOpen(true)}>
                <Plus className="me-2 h-4 w-4" />
                {t('postal.createOrganization')}
              </Button>
            </>
          )}
        </div>
        {(tab === 'shipments' || tab === 'cod') && <DateRangeFilters />}
        {tab === 'shipments' && (
          <PostalDashboardCards
            summary={summary.data}
            loading={summary.isFetching || (!summary.data && !summary.error)}
            error={summary.error}
            onRetry={() => void summary.refetch()}
          />
        )}
        {tab === 'cod' && (
          <section
            aria-label={t('postal.codActivitySummary')}
            aria-busy={query.isFetching}
            className="grid min-w-0 gap-3 md:grid-cols-3"
          >
            {([
              { key: 'collectionsInRange', value: query.data?.summary?.collection_total, icon: ArrowDownLeft, tone: 'emerald' },
              { key: 'settlementsInRange', value: query.data?.summary?.settlement_total, icon: HandCoins, tone: 'blue' },
              { key: 'netCodActivity', value: query.data?.summary?.net_total, icon: Scale, tone: 'violet' },
            ] as const).map(({ key, value, icon: Icon, tone }) => (
              <article key={key} className="flex min-w-0 items-center gap-3 rounded-xl border bg-gradient-to-br from-card to-muted/40 p-4">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone === 'emerald' ? 'bg-emerald-500/10 text-emerald-600' : tone === 'blue' ? 'bg-blue-500/10 text-blue-600' : 'bg-violet-500/10 text-violet-600'}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">{t(`postal.${key}`)}</p>
                  <p className="mt-1 break-words text-lg font-bold tabular-nums" dir="ltr">
                    {query.isFetching
                      ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t('common.loading')} />
                      : value === undefined
                        ? '—'
                        : formatCodIqd(value, i18n.language, t('postal.iqd'))}
                  </p>
                </div>
              </article>
            ))}
            <p className="text-xs text-muted-foreground md:col-span-3">
              <CircleDollarSign className="me-1 inline h-3.5 w-3.5" />
              {t('postal.codSummaryHint')}
            </p>
          </section>
        )}
        <AppPagination
          currentPage={bounds.currentPage}
          pageCount={bounds.pageCount}
          totalCount={query.data?.total ?? 0}
          pageSize={pagination.pageSize}
          pageSizeOptions={[20, 50, 100]}
          onPageChange={pagination.setCurrentPage}
          onPageSizeChange={pagination.setPageSize}
        />
        {query.isFetching ? (
          <PostalLoading />
        ) : query.error ? (
          <PostalError retry={() => void query.refetch()} />
        ) : !query.data?.rows.length ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
            <PackageCheck className="h-10 w-10" />
            <p>{t('postal.empty')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id}>
                    {group.headers.map((header) => (
                      <TableHead key={header.id}>
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.original.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>}
      {creating && (
        <CreateShipmentFlow
          scope={scope}
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            setCreating(false)
            navigate(`/post-service/shipments/${formatPostalShipmentId(s)}`)
          }}
        />
      )}
      {branch && (
        <BranchDialog
          scope={scope}
          branch={branch === 'new' ? undefined : branch}
          onClose={() => setBranch(null)}
        />
      )}
      {addAllGovernoratesOpen && (
        <AddAllGovernoratesDialog
          scope={scope}
          onClose={() => setAddAllGovernoratesOpen(false)}
        />
      )}
      {createOrganizationOpen && (
        <CreateOrganizationDialog
          open={createOrganizationOpen}
          scope={scope}
          onClose={() => setCreateOrganizationOpen(false)}
        />
      )}
      {organization && (
        <OrganizationDialog
          scope={scope}
          organization={organization}
          onClose={() => setOrganization(null)}
        />
      )}
      {canAccessAutoScan && (
        <AutoScanPrinterDialog
          open={autoScanPrinterDialogOpen}
          onOpenChange={onAutoScanPrinterDialogOpenChange}
          workspaceId={scope.workspaceId}
          selectedPrinterName={autoScanPrinter}
          onSaved={onAutoScanPrinterSaved}
        />
      )}
      {autoScanReceiveShipment && (
        <OperationDialog
          scope={scope}
          shipment={autoScanReceiveShipment}
          operation="receive"
          titleShipmentId={formatPostalShipmentId(autoScanReceiveShipment)}
          onClose={() => {
            setAutoScanReceiveShipment(null)
            const resolve = autoScanReceiveResolveRef.current
            autoScanReceiveResolveRef.current = null
            resolve?.()
          }}
        />
      )}
      {scanner && (
        <CameraBarcodeScannerModal
          open
          qrMode
          allowImageUpload
          modes={SINGLE}
          title={t('postal.trackShipment')}
          onScan={async (raw) => {
            try {
              scannedId.current = formatPostalShipmentId(
                await resolvePostalQr(scope, raw),
              )
              return true
            } catch {
              toast({
                title: t('common.error'),
                description: t('postal.errors.qrUnavailable'),
                variant: 'destructive',
              })
              return false
            }
          }}
          onOpenChange={(open) => {
            if (!open) {
              setScanner(false)
              if (scannedId.current !== null)
                navigate(`/post-service/shipments/${scannedId.current}`)
            }
          }}
        />
      )}
    </div>
  )
}
