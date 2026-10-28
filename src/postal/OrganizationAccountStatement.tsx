import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { Building2, FileText, Link2, Unlink, RefreshCw, Search, Wallet, TrendingUp, TrendingDown, Scale, HandCoins } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/ui/components'
import { AppPagination } from '@/ui/components/AppPagination'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { useDateRange } from '@/context/DateRangeContext'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { getPaymentMethodLabel, type PaymentMethodOption } from '@/lib/paymentMethods'
import { usePostalStatement, postalStatementTables, type PostalStatementEntry, type PostalStatementKind } from '@/local-db/postalStatement'
import type { PostalScope } from '@/local-db/postal'
import { formatPostalShipmentId, type PostalOrganization } from './domain'
import { OrganizationAutoCompleteInput } from './OrganizationAutoCompleteInput'
import { PostalError, PostalLoading } from './shared'

const KINDS = ['all', 'collection', 'settlement', 'delivery_fee'] as const
const kindKeys = { all: 'postal.statement.allTransactions', collection: 'postal.statement.recipientMovements', settlement: 'postal.settlementEvent', delivery_fee: 'postal.deliveryFeeCollection' } as const
const NUMERIC_COLUMNS = new Set(['cash', 'debit', 'credit', 'balance'])

export function OrganizationAccountStatement({ scope }: { scope: PostalScope }) {
  // Remount on workspace/viewer/permission changes so selections cannot leak scopes.
  return <StatementContent key={JSON.stringify(scope)} scope={scope} />
}
function StatementContent({ scope }: { scope: PostalScope }) {
  const { t, i18n } = useTranslation()
  const [, navigate] = useLocation()
  const [organization, setOrganization] = useState<PostalOrganization | null>(null)
  const [organizationQuery, setOrganizationQuery] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<PostalStatementKind>('all')
  const { dateRange, customDates, dateFilterDayBoundary } = useDateRange()
  const dates = getDateRangeBounds(dateRange, customDates, new Date(), dateFilterDayBoundary)
  const start = dates.start?.toISOString()
  const end = dates.end?.toISOString()
  const pagination = usePaginationState({
    initialPageSize: (() => {
      const saved = Number(localStorage.getItem('postal_statement_page_size'))
      return [20, 50, 100].includes(saved) ? saved : 20
    })(),
    resetOn: [organization?.id, search, kind, start, end],
    onPageSizeChange: (size) => localStorage.setItem('postal_statement_page_size', String(size)),
  })
  const query = usePostalStatement({ ...scope, organizationId: organization?.id ?? '',
    page: pagination.currentPage, pageSize: pagination.pageSize, start, end, search, kind })
  const bounds = usePaginationBounds({ ...pagination, totalCount: query.data?.total,
    isLoading: query.isFetching || query.isPending, error: query.error })
  const display = (amount: string) => `${new Intl.NumberFormat(i18n.language).format(BigInt(amount))} ${t('postal.iqd')}`
  const balanceLabel = (amount: string) => t(BigInt(amount) > 0n ? 'postal.statement.dueToOrganization'
    : BigInt(amount) < 0n ? 'postal.statement.dueFromOrganization' : 'postal.statement.settled')
  const columns = useMemo<ColumnDef<PostalStatementEntry>[]>(() => {
    const money = (value: string) => new Intl.NumberFormat(i18n.language).format(BigInt(value))
    return [
      { id: 'date', header: t('postal.statement.transactionDate'), cell: ({ row }) => (
        <bdi dir="ltr" className="whitespace-nowrap text-xs text-muted-foreground">{new Date(row.original.created_at).toLocaleString(i18n.language)}</bdi>
      ) },
      { id: 'shipment', header: t('postal.shipmentId'), cell: ({ row }) => {
        const entry = row.original
        const id = formatPostalShipmentId({ shipment_number: entry.shipment_number, created_at: entry.shipment_created_at })
        return <div className="flex min-w-40 flex-col items-start gap-1 text-start">
          <Button variant="link" className="h-auto p-0 font-mono" onClick={() => navigate(`/post-service/shipments/${id}`)}><bdi dir="ltr">{id}</bdi></Button>
          <p className="text-xs font-medium"><bdi>{entry.recipient_name}</bdi></p>
          <p className="text-xs text-muted-foreground"><bdi dir="ltr">{entry.primary_phone}</bdi></p>
          <Badge variant="secondary">{t(`postal.states.${entry.shipment_state}`)}</Badge>
        </div>
      } },
      { id: 'description', header: t('postal.statement.transaction'), cell: ({ row }) => {
        const entry = row.original
        return <div className="min-w-48 space-y-1 text-start">
          <p className="font-medium">{t(entry.kind === 'collection'
            ? BigInt(entry.signed_amount) < 0n ? 'postal.collectionPayRecipient' : 'postal.collectionEvent'
            : entry.kind === 'settlement' && BigInt(entry.signed_amount) < 0n
              ? 'postal.settlementReceiveFromMerchant' : kindKeys[entry.kind])}</p>
          {entry.payment_method && <p className="text-xs text-muted-foreground">{getPaymentMethodLabel(entry.payment_method as PaymentMethodOption, t)}</p>}
          {entry.account_name_snapshot && <p className="text-xs text-muted-foreground"><bdi>{entry.account_name_snapshot}</bdi></p>}
          <p className="break-all font-mono text-[10px] text-muted-foreground" title={t('postal.statement.paymentReference')}><bdi dir="ltr">{entry.payment_transaction_id}</bdi></p>
          {entry.notes && <p className="max-w-64 whitespace-pre-wrap break-words text-xs text-muted-foreground"><bdi>{entry.notes}</bdi></p>}
        </div>
      } },
      { id: 'cash', header: t('postal.statement.cashMovement'), cell: ({ row }) => {
        const entry = row.original
        const amount = BigInt(entry.signed_amount)
        return <div className="min-w-32 space-y-1 text-end tabular-nums">
          <p><bdi dir="ltr">{money(String(amount < 0n ? -amount : amount))}</bdi></p>
          <p className="text-xs text-muted-foreground">{entry.payment_direction ? t(`postal.${entry.payment_direction}`) : '—'}</p>
        </div>
      } },
      ...(['debit', 'credit', 'balance'] as const).map((field): ColumnDef<PostalStatementEntry> => ({
        id: field, header: t(`postal.statement.${field}`), cell: ({ row }) => (
          <span className={`block min-w-28 text-end font-semibold tabular-nums ${field === 'balance' ? 'text-primary' : ''}`}><bdi dir="ltr">{money(row.original[field])}</bdi></span>
        ),
      })),
    ]
  }, [t, i18n.language, navigate])
  const table = useReactTable({ data: query.isFetching || query.error ? [] : query.data?.entries ?? [], columns,
    getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true, manualFiltering: true,
    rowCount: query.data?.total ?? 0, getRowId: (row) => `${row.kind}:${row.id}`,
    state: { pagination: { pageIndex: bounds.currentPage - 1, pageSize: pagination.pageSize } } })
  const statement = !query.isFetching && !query.error ? query.data : undefined
  const clear = () => { setOrganization(null); setOrganizationQuery('') }
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><FileText className="h-5 w-5 text-primary" />{t('postal.accountStatement')}</h2>
          {organization && <ModulePageFreshness tableNames={postalStatementTables} />}
        </div>
        <Button variant="outline" className="gap-2 rounded-xl" disabled={!organization || query.isFetching} onClick={() => void query.refetch()}>
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />{t('postal.statement.refresh')}
        </Button>
      </div>
      <Card><CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="statement-organization" className="inline-flex items-center gap-1.5 text-sm font-semibold"><Building2 className="h-4 w-4" />{t('postal.organizationName')} *</label>
            {organization && <>
              <Badge variant="secondary"><Link2 className="me-1 h-3 w-3" />{t('businessPartners.linked')}</Badge>
              <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={clear}><Unlink className="h-3.5 w-3.5" />{t('postal.statement.unlink')}</Button>
            </>}
          </div>
          <OrganizationAutoCompleteInput id="statement-organization" scope={scope} value={organizationQuery}
            onChange={(value) => { setOrganizationQuery(value); setOrganization(null) }} onSelectOrganization={setOrganization} />
          <p className="text-xs text-muted-foreground">{t('postal.statement.searchHint')}</p>
        </div>
        <DateRangeFilters className="justify-start lg:justify-end" />
      </CardContent></Card>
      {!organization ? (
        <Card><CardContent className="flex min-h-72 flex-col items-center justify-center p-8 text-center">
          <FileText className="mb-4 h-10 w-10 text-muted-foreground" />
          <h3 className="text-lg font-semibold">{t('postal.statement.selectOrganization')}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{t('postal.statement.selectDescription')}</p>
        </CardContent></Card>
      ) : <>
        <Card className="overflow-hidden">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b bg-muted/20 py-4">
            <div className="min-w-0 text-start">
              <CardTitle className="break-words text-base"><bdi>{statement?.organization.name ?? organization.name}</bdi></CardTitle>
              <p className="mt-1 font-mono text-xs text-muted-foreground"><bdi dir="ltr">{statement?.organization.code ?? organization.code}</bdi></p>
            </div>
            <Badge variant="outline">{t('postal.iqd')}</Badge>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid grid-cols-2 divide-x border-b sm:grid-cols-4">
              {([
                ['opening_balance', 'openingBalance', Wallet], ['debit_total', 'debit', TrendingDown],
                ['credit_total', 'credit', TrendingUp], ['closing_balance', 'closingBalance', Scale],
              ] as const).map(([field, label, Icon]) => (
                <div key={field} className="min-w-0 p-3 text-start sm:p-4">
                  <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><Icon className="h-3.5 w-3.5 shrink-0" />{t(`postal.statement.${label}`)}</p>
                  <p className="mt-1 break-words text-sm font-black tabular-nums"><bdi dir="ltr">{statement ? display(statement.summary[field]) : '—'}</bdi></p>
                  {statement && (field === 'opening_balance' || field === 'closing_balance') && <p className="mt-1 text-xs text-muted-foreground">{balanceLabel(statement.summary[field])}</p>}
                </div>
              ))}
            </div>
            <div className="space-y-3 border-b p-4">
              <p className="text-xs text-muted-foreground">{t('postal.statement.accountingHint')}</p>
              <p className="text-xs text-muted-foreground">{t('postal.statement.filterHint')}</p>
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-40 flex-1"><Search className="absolute start-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input className="ps-9" value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t('common.search')} placeholder={t('postal.statement.searchTransactions')} />
                </div>
                <Select value={kind} onValueChange={(value) => { if (KINDS.includes(value as PostalStatementKind)) setKind(value as PostalStatementKind) }}>
                  <SelectTrigger className="w-full sm:w-56" aria-label={t('postal.statement.transaction')}><SelectValue /></SelectTrigger>
                  <SelectContent>{KINDS.map((key) => <SelectItem key={key} value={key}>{t(kindKeys[key])}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <AppPagination currentPage={bounds.currentPage} pageCount={bounds.pageCount} totalCount={query.data?.total ?? 0}
                pageSize={pagination.pageSize} pageSizeOptions={[20, 50, 100]} onPageChange={pagination.setCurrentPage} onPageSizeChange={pagination.setPageSize} />
            </div>
            {query.isFetching || query.isPending ? <PostalLoading /> : query.error ? <PostalError retry={() => void query.refetch()} /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id} className="bg-muted/30 hover:bg-muted/30">
                    {group.headers.map((header) => <TableHead key={header.id} className={`whitespace-nowrap ${NUMERIC_COLUMNS.has(header.id) ? 'text-end' : 'text-start'}`}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}
                  </TableRow>)}</TableHeader>
                  <TableBody>
                    {statement && <TableRow className="bg-muted/10 font-semibold"><TableCell colSpan={6} className="text-start">{t('postal.statement.openingBalance')}</TableCell><TableCell className="text-end tabular-nums"><bdi dir="ltr">{display(statement.summary.opening_balance)}</bdi></TableCell></TableRow>}
                    {!statement?.entries.length && <TableRow><TableCell colSpan={7} className="h-40 text-center text-muted-foreground">{t('postal.empty')}</TableCell></TableRow>}
                    {table.getRowModel().rows.map((row) => <TableRow key={row.id}>{row.getVisibleCells().map((cell) => <TableCell key={cell.id} className={NUMERIC_COLUMNS.has(cell.column.id) ? 'text-end' : 'text-start'}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}
                    {statement && <TableRow className="bg-muted/20 font-bold"><TableCell colSpan={4} className="text-start">{t('postal.statement.periodTotals')}</TableCell>
                      <TableCell className="text-end tabular-nums"><bdi dir="ltr">{display(statement.summary.debit_total)}</bdi></TableCell>
                      <TableCell className="text-end tabular-nums"><bdi dir="ltr">{display(statement.summary.credit_total)}</bdi></TableCell>
                      <TableCell className="text-end tabular-nums"><bdi dir="ltr">{display(statement.summary.closing_balance)}</bdi></TableCell>
                    </TableRow>}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
        {statement && <Card><CardHeader className="border-b bg-muted/20 py-4"><CardTitle className="flex items-center gap-2 text-base"><HandCoins className="h-4 w-4 text-primary" />{t('postal.statement.context')}</CardTitle></CardHeader>
          <CardContent className="space-y-4 p-4">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {([
                ['collections', 'collections'], ['settlements', 'settlements'], ['delivery_fees', 'deliveryFees'],
                ['current_due_to', 'currentDueTo'], ['current_due_from', 'currentDueFrom'],
                ['recipient_due', 'recipientDue'], ['recipient_refund_due', 'recipientRefundDue'],
              ] as const).map(([field, label]) => <div key={field} className="min-w-0 text-start"><dt className="text-xs text-muted-foreground">{t(`postal.statement.${label}`)}</dt><dd className="mt-1 break-words text-sm font-bold tabular-nums"><bdi dir="ltr">{display(statement.summary[field])}</bdi></dd></div>)}
            </dl>
            <p className="text-xs text-muted-foreground">{t('postal.statement.contextHint')}</p>
            {statement.summary.missing_tariffs > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{t('postal.statement.missingTariffs', { count: statement.summary.missing_tariffs })}</p>}
          </CardContent>
        </Card>}
      </>}
    </div>
  )
}
