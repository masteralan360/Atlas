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
  PackageCheck,
  Plus,
  ScanLine,
  Search,
  Eye,
  Building2,
  Users,
  Wallet,
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

type Row = PostalShipment | PostalBranch | PostalOrganization | PostalCodRecord
const SINGLE = ['single'] as const
export default function PostalServicePage() {
  const { t, i18n } = useTranslation()
  const scope = usePostalScope()
  const [, navigate] = useLocation()
  const { toast } = useToast()
  const [tab, setTab] = useState<keyof typeof postalTables>('shipments')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
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
    ...(tab === 'shipments' || tab === 'cod'
      ? { start: dates.start?.toISOString(), end: dates.end?.toISOString() }
      : {}),
  })
  const summary = usePostalSummary(
    {
      ...scope,
      search,
      status,
      start: dates.start?.toISOString(),
      end: dates.end?.toISOString(),
    },
    tab === 'shipments',
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
    return [
      {
        id: 'shipmentId',
        header: t('postal.shipmentId'),
        cell: ({ row }) => {
          const shipment = (row.original as PostalCodRecord).postal_shipments
          return (
            <span className="font-mono" dir="ltr">
              {shipment ? formatPostalShipmentId(shipment) : null}
            </span>
          )
        },
      },
      {
        id: 'kind',
        header: t('postal.financialEvent'),
        cell: ({ row }) =>
          t(`postal.${(row.original as PostalCodRecord).kind}`),
      },
      {
        id: 'amount',
        header: t('postal.codAmount'),
        cell: ({ row }) =>
          `${Number((row.original as PostalCodRecord).signed_amount).toLocaleString(i18n.language)} ${t('postal.iqd')}`,
      },
      {
        accessorKey: 'created_at',
        header: t('postal.createdAt'),
        cell: ({ row }) =>
          new Date((row.original as PostalCodRecord).created_at).toLocaleString(
            i18n.language,
          ),
      },
      {
        id: 'shipment',
        header: t('postal.view'),
        cell: ({ row }) => {
          const shipment = (row.original as PostalCodRecord).postal_shipments
          return (
            <Button
              variant="outline"
              disabled={!shipment}
              onClick={() =>
                shipment &&
                navigate(`/post-service/shipments/${formatPostalShipmentId(shipment)}`)
              }
            >
              <Eye className="me-2 h-4 w-4" />
              {t('postal.shipmentDetails')}
            </Button>
          )
        },
      },
    ]
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
          <ModulePageFreshness
            tableNames={
              tab === 'shipments' ? postalSummaryTables : [postalTables[tab]]
            }
          />
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
            aria-selected={tab === key}
            key={key}
            variant={tab === key ? 'default' : 'outline'}
            onClick={() => setTab(key as keyof typeof postalTables)}
          >
            <Icon className="me-2 h-4 w-4" />
            {t(`postal.${key}`)}
          </Button>
        ))}
      </div>
      <div className="space-y-4 rounded-xl border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          {tab !== 'cod' && (
            <div className="relative min-w-40 flex-1">
              <Search className="absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                className="ps-9"
                aria-label={t('common.search')}
                placeholder={t('common.search')}
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
      </div>
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
