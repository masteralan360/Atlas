import { usePostalScope } from '@/postal/usePostalAccess'
import { useMemo, useRef, useState } from 'react'
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
  Users,
  Wallet,
  HandCoins,
  Scale,
  Loader2,
  CircleDollarSign,
  FileText,
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
  postalSummaryTables,
  postalTables,
  resolvePostalQr,
} from '@/local-db/postal'
import { PostalDashboardCards } from '@/postal/PostalDashboardCards'
import {
  postalStates,
  locationLabel,
  formatPostalShipmentId,
  type PostalShipment,
  type PostalBranch,
  type PostalOrganization,
  type PostalCodRecord,
} from '@/postal/domain'
import { PostalLoading, PostalError } from '@/postal/shared'
import { CreateShipmentFlow } from '@/postal/CreateShipmentFlow'
import { BranchDialog, OrganizationDialog } from '@/postal/ManagementDialogs'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { getPaymentMethodLabel } from '@/lib/paymentMethods'
import type { PaymentMethodOption } from '@/lib/paymentMethods'
import { OrganizationAccountStatement } from '@/postal/OrganizationAccountStatement'
import { canReadPostalStatement } from '@/local-db/postalStatement'

type Row = PostalShipment | PostalBranch | PostalOrganization | PostalCodRecord
const SINGLE = ['single'] as const

function formatCodIqd(value: string, language: string, currency: string) {
  return `${new Intl.NumberFormat(language).format(BigInt(value))} ${currency}`
}

export default function PostalServicePage({ accountStatement = false }: { accountStatement?: boolean }) {
  const { t, i18n } = useTranslation()
  const scope = usePostalScope()
  const [, navigate] = useLocation()
  const { toast } = useToast()
  const [tab, setTab] = useState<keyof typeof postalTables>('shipments')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [codKind, setCodKind] = useState<
    'all' | 'collection' | 'settlement'
  >('all')
  const [creating, setCreating] = useState(false)
  const [scanner, setScanner] = useState(false)
  const scannedId = useRef<string | null>(null)
  const [branch, setBranch] = useState<PostalBranch | 'new' | null>(null)
  const [organization, setOrganization] = useState<PostalOrganization | null>(
    null,
  )
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
  }, !accountStatement)
  const summary = usePostalSummary(
    {
      ...scope,
      search,
      status,
      start: dates.start?.toISOString(),
      end: dates.end?.toISOString(),
    },
    !accountStatement && tab === 'shipments',
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
          cell: ({ row }) => (
            <span className="whitespace-nowrap rounded-full bg-primary/10 px-3 py-1 text-xs font-medium">
              {t(`postal.states.${(row.original as PostalShipment).state}`)}
            </span>
          ),
        },
        {
          id: 'destination',
          header: t('postal.destination'),
          cell: ({ row }) => {
            const s = row.original as PostalShipment
            return `${locationLabel(s.governorate, i18n.language)} / ${locationLabel(s.area, i18n.language, s.governorate)}`
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
        { accessorKey: 'name', header: t('postal.branchName') },
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
  }, [tab, t, i18n.language, navigate])
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
          {!accountStatement && <ModulePageFreshness
            tableNames={
              tab === 'shipments'
                ? postalSummaryTables
                : tab === 'cod'
                  ? ['postal_cod_records', 'postal_shipments', 'postal_organizations']
                  : [postalTables[tab]]
            }
          />}
        </div>
        <div className="flex flex-wrap gap-2">
          {scope.role === 'admin' && (
            <WorkspaceAccountCreation accountType="postalMerchant" />
          )}
          {scope.role === 'merchant' && (
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
            aria-selected={accountStatement ? key === 'accountStatement' : tab === key}
            key={key}
            variant={(accountStatement ? key === 'accountStatement' : tab === key) ? 'default' : 'outline'}
            onClick={() => {
              if (key === 'accountStatement') navigate('/post-service/account-statement')
              else {
                setTab(key as keyof typeof postalTables)
                if (accountStatement) navigate('/post-service')
              }
            }}
          >
            <Icon className="me-2 h-4 w-4" />
            {t(`postal.${key}`)}
          </Button>
        ))}
      </div>
      {accountStatement ? canReadPostalStatement(scope) && <OrganizationAccountStatement scope={scope} /> : <div className="space-y-4 rounded-xl border bg-card p-3 sm:p-4">
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
            <Button onClick={() => setBranch('new')}>
              <Plus className="me-2 h-4 w-4" />
              {t('postal.createBranch')}
            </Button>
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
      {organization && (
        <OrganizationDialog
          scope={scope}
          organization={organization}
          onClose={() => setOrganization(null)}
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
