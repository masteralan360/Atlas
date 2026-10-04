import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownRight,
  ArrowUpRight,
  Briefcase,
  Check,
  CircleDollarSign,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Unlink,
} from 'lucide-react'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { formatCurrency, formatDate } from '@/lib/utils'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import {
  getRemainingPaymentTransactions,
  saveCustomerProfitabilityAttribution,
  saveCustomerProfitabilityEngagement,
  unlinkCustomerProfitabilitySource,
  useBusinessPartners,
  useCustomerProfitabilityAttributions,
  useCustomerProfitabilityEngagements,
  useCustomerProfitabilitySourceRows,
  useExpenseCategories,
  useFleetVehicles,
  usePurchaseOrders,
  useSalesOrders,
} from '@/local-db'
import type {
  CustomerProfitabilityAttribution,
  CustomerProfitabilityFinancialKind,
  CustomerProfitabilitySourceType,
  PaymentTransaction,
  PurchaseOrder,
  SalesOrder,
} from '@/local-db'
import { useOptionalWorkspacePermissions } from '@/permissions/workspacePermissionsState'
import type { WorkspacePermissionKey } from '@/permissions/workspacePermissionDefinitions'
import { useWorkspace } from '@/workspace'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@/ui/components'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { refreshCustomerProfitabilitySources } from '@/local-db/customerProfitability'

type ReportSourceRow = {
  sourceType: CustomerProfitabilitySourceType
  sourceRecordId: string
  sourceSubrecordId: string
  financialKind: CustomerProfitabilityFinancialKind
  reference: string
  description: string
  counterparty: string
  category: string
  amount: number
  currency: string
  date: string
  knownCustomerId?: string | null
  vehicleId?: string | null
  attribution?: CustomerProfitabilityAttribution
}

type ProfitabilityTotals = { revenue: number; expenses: number; net: number }
type GroupTotalsEntry = { key: string; label: string; totals: Map<string, ProfitabilityTotals> }

const EMPTY_SOURCE_ROWS = { expenses: [], expenseSeries: [], payments: [] }
const CUSTOMER_ROLES = ['customer', 'both', 'online_customer'] as const
const FRESHNESS_BASE_TABLES = [
  'customer_profitability_engagements',
  'customer_profitability_attributions',
  'business_partners',
  'customers',
  'fleet_vehicles',
] as const

function getSourceKey(sourceType: string, sourceRecordId: string, sourceSubrecordId = '') {
  return `${sourceType}:${sourceRecordId}:${sourceSubrecordId}`
}

function getValidDateBounds(dateRange: ReturnType<typeof useDateRange>['dateRange'], customDates: { start: string; end: string }) {
  const bounds = getDateRangeBounds(dateRange, customDates)
  return {
    start: bounds.start?.getTime(),
    end: bounds.end?.getTime(),
  }
}

function withinBounds(value: string, bounds: { start?: number; end?: number }) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const timestamp = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
    : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return false
  return (bounds.start === undefined || timestamp >= bounds.start)
    && (bounds.end === undefined || timestamp < bounds.end)
}

function toReportSourceRows(input: {
  salesOrders: SalesOrder[]
  purchaseOrders: PurchaseOrder[]
  expenses: Array<{ id: string; seriesId: string; dueDate: string; amount: number; currency: string }>
  expenseSeries: Array<{ id: string; name: string; categoryId?: string | null; category?: string | null }>
  expenseCategories: Array<{ id: string; name: string }>
  payments: PaymentTransaction[]
  allowPayroll: boolean
  allowDirectTransactions: boolean
}): ReportSourceRow[] {
  const seriesById = new Map(input.expenseSeries.map((series) => [series.id, series]))
  const categoryById = new Map(input.expenseCategories.map((category) => [category.id, category.name]))
  const rows: ReportSourceRow[] = []

  for (const order of input.salesOrders) {
    if (order.isDeleted || order.isArchived || order.status !== 'completed') continue
    const total = Math.max(0, Number(order.total || 0) - Number(order.returnedAmount || 0))
    if (total <= 0) continue
    rows.push({
      sourceType: 'sales_order',
      sourceRecordId: order.id,
      sourceSubrecordId: '',
      financialKind: 'revenue',
      reference: order.orderNumber || order.id,
      description: order.notes || order.customerName || '',
      counterparty: order.customerName || '',
      category: 'revenue',
      amount: total,
      currency: order.currency,
      date: order.actualDeliveryDate || order.updatedAt || order.createdAt,
      knownCustomerId: order.businessPartnerId || null,
    })
  }

  for (const order of input.purchaseOrders) {
    if (order.isDeleted || order.isArchived || (order.status !== 'received' && order.status !== 'completed')) continue
    const amount = Math.max(0, Number(order.total || 0))
    if (amount <= 0) continue
    rows.push({
      sourceType: 'purchase_order',
      sourceRecordId: order.id,
      sourceSubrecordId: '',
      financialKind: 'expense',
      reference: order.orderNumber || order.id,
      description: order.notes || order.supplierName || '',
      counterparty: order.supplierName || '',
      category: 'supplierPurchase',
      amount,
      currency: order.currency,
      date: order.actualDeliveryDate || order.updatedAt || order.createdAt,
    })
  }

  for (const expense of input.expenses) {
    const series = seriesById.get(expense.seriesId)
    const amount = Math.max(0, Number(expense.amount || 0))
    if (!series || amount <= 0) continue
    rows.push({
      sourceType: 'expense_item',
      sourceRecordId: expense.id,
      sourceSubrecordId: '',
      financialKind: 'expense',
      reference: series.name,
      description: series.name,
      counterparty: series.name,
      category: series.category || (series.categoryId ? categoryById.get(series.categoryId) : '') || 'other',
      amount,
      currency: expense.currency,
      date: expense.dueDate,
    })
  }

  const reportablePayments = getRemainingPaymentTransactions(input.payments)
  for (const payment of reportablePayments) {
    if (payment.sourceType === 'payroll_status' && input.allowPayroll) {
      rows.push(paymentToSourceRow(payment, 'payroll_payment'))
    } else if (payment.sourceType === 'direct_transaction' && input.allowDirectTransactions) {
      rows.push(paymentToSourceRow(payment, 'direct_transaction'))
    }
  }

  return rows.sort((left, right) => right.date.localeCompare(left.date))
}

function paymentToSourceRow(payment: PaymentTransaction, sourceType: 'payroll_payment' | 'direct_transaction'): ReportSourceRow {
  return {
    sourceType,
    sourceRecordId: payment.id,
    sourceSubrecordId: '',
    financialKind: payment.direction === 'incoming' ? 'revenue' : 'expense',
    reference: payment.voucherNumber ? `#${payment.voucherNumber}` : payment.referenceLabel || payment.id,
    description: payment.note || payment.referenceLabel || payment.counterpartyName || '',
    counterparty: payment.counterpartyName || '',
    category: sourceType === 'payroll_payment' ? 'payroll' : 'directVoucher',
    amount: Math.abs(Number(payment.amount || 0)),
    currency: payment.currency,
    date: payment.paidAt,
  }
}

function calculateTotals(rows: ReportSourceRow[]): Map<string, ProfitabilityTotals> {
  const totals = new Map<string, ProfitabilityTotals>()
  for (const row of rows) {
    const currency = row.currency.toLowerCase()
    const current = totals.get(currency) || { revenue: 0, expenses: 0, net: 0 }
    if (row.financialKind === 'revenue') current.revenue += row.amount
    else current.expenses += row.amount
    current.net = current.revenue - current.expenses
    totals.set(currency, current)
  }
  return totals
}

function calculateGroupTotals(
  rows: ReportSourceRow[],
  getGroupKey: (row: ReportSourceRow) => string,
  getGroupLabel: (key: string) => string,
): GroupTotalsEntry[] {
  const groups = new Map<string, ReportSourceRow[]>()
  for (const row of rows) {
    const key = getGroupKey(row)
    const groupedRows = groups.get(key) || []
    groupedRows.push(row)
    groups.set(key, groupedRows)
  }
  return [...groups.entries()]
    .map(([key, groupedRows]) => ({ key, label: getGroupLabel(key), totals: calculateTotals(groupedRows) }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function CustomerProfitability() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user } = useAuth()
  const { features } = useWorkspace()
  const { dateRange, customDates } = useDateRange()
  const permissions = useOptionalWorkspacePermissions()
  const online = useNetworkStatus()
  const workspaceId = user?.workspaceId
  const isAdmin = user?.role === 'admin'
  const canManageLinks = isAdmin || user?.role === 'staff'
  const hasPermission = permissions?.hasPermission
  const canAccess = useCallback((key: WorkspacePermissionKey) => (
    isAdmin || !hasPermission || hasPermission(key)
  ), [hasPermission, isAdmin])
  const access = useMemo(() => ({
    salesOrders: canAccess('orders.saleOrdersAccess'),
    purchaseOrders: canAccess('orders.purchaseOrdersAccess'),
    expenses: canAccess('budget.access'),
    payroll: canAccess('budget.access'),
    directTransactions: canAccess('directTransaction.access'),
  }), [canAccess])
  const sourceRows = useCustomerProfitabilitySourceRows(workspaceId, access) ?? EMPTY_SOURCE_ROWS
  const salesOrders = useSalesOrders(access.salesOrders ? workspaceId : undefined)
  const purchaseOrders = usePurchaseOrders(access.purchaseOrders ? workspaceId : undefined)
  const expenseCategories = useExpenseCategories(access.expenses ? workspaceId : undefined)
  const partners = useBusinessPartners(workspaceId, { roles: [...CUSTOMER_ROLES] })
  const vehicles = useFleetVehicles(workspaceId)
  const engagements = useCustomerProfitabilityEngagements(workspaceId)
  const attributions = useCustomerProfitabilityAttributions(workspaceId)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedCustomerId, setSelectedCustomerId] = useState('')
  const [customerFilterText, setCustomerFilterText] = useState('')
  const [engagementFilterId, setEngagementFilterId] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [attributionDialogOpen, setAttributionDialogOpen] = useState(false)
  const [engagementDialogOpen, setEngagementDialogOpen] = useState(false)
  const [selectedSource, setSelectedSource] = useState<ReportSourceRow | null>(null)
  const [unlinkSource, setUnlinkSource] = useState<ReportSourceRow | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isUnlinking, setIsUnlinking] = useState(false)
  const [selectedPartnerId, setSelectedPartnerId] = useState('')
  const [selectedPartnerName, setSelectedPartnerName] = useState('')
  const [selectedEngagementId, setSelectedEngagementId] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState('')
  const [newEngagementPartnerId, setNewEngagementPartnerId] = useState('')
  const [newEngagementPartnerName, setNewEngagementPartnerName] = useState('')
  const [newEngagementName, setNewEngagementName] = useState('')
  const [newEngagementNotes, setNewEngagementNotes] = useState('')

  const refresh = useCallback(async () => {
    if (!workspaceId || !online) return
    setRefreshing(true)
    try {
      await refreshCustomerProfitabilitySources(workspaceId, access)
    } catch (error) {
      console.error('[Customer Profitability] Failed to refresh report data:', error)
      toast({
        title: t('customerProfitability.messages.refreshFailed'),
        description: t('customerProfitability.messages.refreshFailedDescription'),
        variant: 'destructive',
      })
    } finally {
      setRefreshing(false)
    }
  }, [access, online, t, toast, workspaceId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const freshnessTables = useMemo(() => [
    ...FRESHNESS_BASE_TABLES,
    ...(access.salesOrders ? ['sales_orders'] : []),
    ...(access.purchaseOrders ? ['purchase_orders'] : []),
    ...(access.expenses ? ['expense_items', 'expense_series', 'expense_categories'] : []),
    ...(access.payroll || access.directTransactions ? ['payment_transactions'] : []),
  ], [access])

  const partnerById = useMemo(() => new Map(partners.map((partner) => [partner.id, partner])), [partners])
  const attributionBySource = useMemo(() => new Map(
    attributions.filter((attribution) => !attribution.isDeleted).map((attribution) => [
      getSourceKey(attribution.sourceType, attribution.sourceRecordId, attribution.sourceSubrecordId || ''),
      attribution,
    ]),
  ), [attributions])

  const allSources = useMemo(() => toReportSourceRows({
    salesOrders: access.salesOrders ? salesOrders : [],
    purchaseOrders: access.purchaseOrders ? purchaseOrders : [],
    expenses: access.expenses ? sourceRows.expenses : [],
    expenseSeries: access.expenses ? sourceRows.expenseSeries : [],
    expenseCategories: access.expenses ? expenseCategories : [],
    payments: sourceRows.payments,
    allowPayroll: access.payroll,
    allowDirectTransactions: access.directTransactions,
  }).map((row) => ({
    ...row,
    attribution: attributionBySource.get(getSourceKey(row.sourceType, row.sourceRecordId, row.sourceSubrecordId)),
  })), [access, attributionBySource, expenseCategories, purchaseOrders, salesOrders, sourceRows])

  const dateBounds = useMemo(() => getValidDateBounds(dateRange, customDates), [customDates, dateRange])
  const visibleSources = useMemo(() => allSources.filter((row) => withinBounds(row.date, dateBounds)), [allSources, dateBounds])
  const unlinkedSources = useMemo(() => visibleSources.filter((row) => !row.attribution)
    .filter((row) => sourceFilter === 'all' || row.sourceType === sourceFilter), [sourceFilter, visibleSources])

  const linkedRows = useMemo(() => visibleSources.filter((row) => row.attribution
    && (!selectedCustomerId || row.attribution?.businessPartnerId === selectedCustomerId)
    && (engagementFilterId === 'all' || row.attribution?.engagementId === engagementFilterId)), [engagementFilterId, selectedCustomerId, visibleSources])
  const totalsByCurrency = useMemo(() => calculateTotals(linkedRows), [linkedRows])
  const customerEngagements = useMemo(() => engagements.filter((engagement) => (
    !engagement.isDeleted
    && (!selectedCustomerId || engagement.businessPartnerId === selectedCustomerId)
  )), [engagements, selectedCustomerId])
  const activeEngagements = useMemo(() => engagements.filter((engagement) => (
    !engagement.isDeleted && engagement.isActive && engagement.businessPartnerId === selectedPartnerId
  )), [engagements, selectedPartnerId])

  const openAttribution = (source: ReportSourceRow) => {
    const existing = source.attribution
    const candidatePartnerId = existing?.businessPartnerId || source.knownCustomerId || ''
    const defaultPartnerId = partnerById.has(candidatePartnerId) ? candidatePartnerId : ''
    setSelectedSource(source)
    setSelectedPartnerId(defaultPartnerId)
    setSelectedPartnerName(partnerById.get(defaultPartnerId)?.partnerName || '')
    setSelectedEngagementId(existing?.engagementId || '')
    setSelectedVehicleId(existing?.vehicleId || source.vehicleId || '')
    setAttributionDialogOpen(true)
  }

  const closeAttributionDialog = (open: boolean) => {
    if (isSaving) return
    setAttributionDialogOpen(open)
    if (!open) setSelectedSource(null)
  }

  const handleSaveAttribution = async () => {
    if (!canManageLinks || !workspaceId || !selectedSource || !selectedPartnerId || isSaving) return
    const engagement = selectedEngagementId
      ? engagements.find((item) => item.id === selectedEngagementId && item.businessPartnerId === selectedPartnerId && item.isActive && !item.isDeleted)
      : null
    const vehicle = selectedVehicleId ? vehicles.find((item) => item.id === selectedVehicleId && !item.isDeleted) : null
    if ((selectedEngagementId && !engagement) || (selectedVehicleId && !vehicle)) return
    setIsSaving(true)
    try {
      await saveCustomerProfitabilityAttribution(workspaceId, {
        sourceType: selectedSource.sourceType,
        sourceRecordId: selectedSource.sourceRecordId,
        sourceSubrecordId: selectedSource.sourceSubrecordId,
        financialKind: selectedSource.financialKind,
        businessPartnerId: selectedPartnerId,
        engagementId: engagement?.id || null,
        vehicleId: vehicle?.id || null,
      })
      toast({ title: t('customerProfitability.messages.linkSaved'), description: t('customerProfitability.messages.linkSavedDescription') })
      setAttributionDialogOpen(false)
      setSelectedSource(null)
    } catch (error) {
      console.error('[Customer Profitability] Failed to save attribution:', error)
      toast({ title: t('customerProfitability.messages.saveFailed'), description: t('customerProfitability.messages.saveFailedDescription'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveEngagement = async () => {
    if (!canManageLinks || !workspaceId || !newEngagementPartnerId || !newEngagementName.trim() || isSaving) return
    setIsSaving(true)
    try {
      const engagement = await saveCustomerProfitabilityEngagement(workspaceId, {
        businessPartnerId: newEngagementPartnerId,
        name: newEngagementName.trim(),
        notes: newEngagementNotes.trim() || null,
        isActive: true,
      })
      setSelectedCustomerId(newEngagementPartnerId)
      setCustomerFilterText(newEngagementPartnerName)
      toast({ title: t('customerProfitability.messages.engagementSaved'), description: t('customerProfitability.messages.engagementSavedDescription') })
      setEngagementDialogOpen(false)
      setNewEngagementPartnerId('')
      setNewEngagementPartnerName('')
      setNewEngagementName('')
      setNewEngagementNotes('')
      setEngagementFilterId(engagement.id)
    } catch (error) {
      console.error('[Customer Profitability] Failed to save engagement:', error)
      toast({ title: t('customerProfitability.messages.saveFailed'), description: t('customerProfitability.messages.saveFailedDescription'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleUnlink = async () => {
    if (!workspaceId || !unlinkSource?.attribution || isUnlinking) return
    setIsUnlinking(true)
    try {
      await unlinkCustomerProfitabilitySource(workspaceId, unlinkSource.sourceType, unlinkSource.sourceRecordId, unlinkSource.sourceSubrecordId)
      toast({ title: t('customerProfitability.messages.linkRemoved'), description: t('customerProfitability.messages.linkRemovedDescription') })
      setUnlinkSource(null)
    } catch (error) {
      console.error('[Customer Profitability] Failed to unlink source:', error)
      toast({ title: t('customerProfitability.messages.saveFailed'), description: t('customerProfitability.messages.saveFailedDescription'), variant: 'destructive' })
    } finally {
      setIsUnlinking(false)
    }
  }

  const linkedRowsForCustomer = linkedRows.filter((row) => row.attribution?.businessPartnerId === selectedCustomerId)
  const engagementTotals = useMemo(() => calculateGroupTotals(
    linkedRowsForCustomer,
    (row) => row.attribution?.engagementId || 'unassigned',
    (engagementId) => engagements.find((item) => item.id === engagementId)?.name || t('customerProfitability.labels.unassigned'),
  ), [engagements, linkedRowsForCustomer, t])
  const vehicleTotals = useMemo(() => calculateGroupTotals(
    linkedRowsForCustomer,
    (row) => row.attribution?.vehicleId || 'unassigned',
    (vehicleId) => {
      const vehicle = vehicles.find((item) => item.id === vehicleId)
      return vehicle ? `${vehicle.plateNumber} · ${vehicle.make || vehicle.model}` : t('customerProfitability.labels.unassigned')
    },
  ), [linkedRowsForCustomer, t, vehicles])
  const isAttributionValid = Boolean(selectedSource && selectedPartnerId && partnerById.has(selectedPartnerId)
    && (!selectedEngagementId || activeEngagements.some((engagement) => engagement.id === selectedEngagementId))
    && (!selectedVehicleId || vehicles.some((vehicle) => vehicle.id === selectedVehicleId && !vehicle.isDeleted)))
  const iqdPreference = features.iqd_display_preference || 'IQD'
  const formatMoney = (amount: number, currency: string) => formatCurrency(amount, currency, iqdPreference)

  return (
    <div className="w-full min-w-0 space-y-5 p-3 sm:p-5 lg:p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-2xl bg-primary/10 p-3 text-primary"><CircleDollarSign className="size-6" /></div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">{t('customerProfitability.title')}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('customerProfitability.description')}</p>
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5 text-emerald-600" />
              {t('customerProfitability.reportingOnlyNotice')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <ModulePageFreshness tableNames={freshnessTables} />
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing || !online}>
            {refreshing ? <Loader2 className="me-2 size-4 animate-spin" /> : <RefreshCw className="me-2 size-4" />}
            {t('customerProfitability.actions.refresh')}
          </Button>
          {canManageLinks ? <Button size="sm" onClick={() => setEngagementDialogOpen(true)}>
            <Plus className="me-2 size-4" />{t('customerProfitability.actions.newEngagement')}
          </Button> : null}
        </div>
      </div>

      <Card className="border-border/70 shadow-sm">
        <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(260px,1fr)_minmax(220px,0.75fr)_auto] lg:items-end">
          <div className="space-y-2">
            <Label>{t('customerProfitability.fields.customer')}</Label>
            <PartnerAutocompleteInput
              value={customerFilterText}
              onChange={(value) => {
                setCustomerFilterText(value)
                if (value !== partnerById.get(selectedCustomerId)?.partnerName) {
                  setSelectedCustomerId('')
                  setEngagementFilterId('all')
                }
              }}
              onSelectPartner={(partner) => {
                setSelectedCustomerId(partner.id)
                setCustomerFilterText(partner.partnerName)
                setEngagementFilterId('all')
              }}
              workspaceId={workspaceId || ''}
              roles={[...CUSTOMER_ROLES]}
              placeholder={t('customerProfitability.fields.selectCustomer')}
            />
            {selectedCustomerId ? (
              <div className="flex items-center gap-2">
                <Badge variant="secondary"><Link2 className="me-1 size-3" />{t('customerProfitability.labels.linked')}</Badge>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setSelectedCustomerId(''); setCustomerFilterText(''); setEngagementFilterId('all') }}>
                  <Unlink className="me-1 size-3" />{t('customerProfitability.actions.unlink')}
                </Button>
              </div>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>{t('customerProfitability.fields.engagement')}</Label>
            <Select value={engagementFilterId} onValueChange={setEngagementFilterId} disabled={!selectedCustomerId}>
              <SelectTrigger><SelectValue placeholder={t('customerProfitability.fields.allEngagements')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('customerProfitability.fields.allEngagements')}</SelectItem>
                {customerEngagements.map((engagement) => <SelectItem key={engagement.id} value={engagement.id}>{engagement.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DateRangeFilters className="lg:min-w-[350px]" showYesterday />
        </CardContent>
      </Card>

      {!selectedCustomerId ? (
        <div className="rounded-2xl border border-dashed bg-muted/20 px-5 py-8 text-center">
          <Briefcase className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-semibold">{t('customerProfitability.empty.selectCustomerTitle')}</h2>
          <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">{t('customerProfitability.empty.selectCustomerDescription')}</p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[...totalsByCurrency.entries()].map(([currency, totals]) => (
              <Fragment key={currency}>
                <MetricCard title={t('customerProfitability.metrics.revenue')} value={formatMoney(totals.revenue, currency)} icon={<ArrowUpRight className="size-4" />} />
                <MetricCard title={t('customerProfitability.metrics.expenses')} value={formatMoney(totals.expenses, currency)} icon={<ArrowDownRight className="size-4" />} />
                <MetricCard title={t('customerProfitability.metrics.net')} value={formatMoney(totals.net, currency)} icon={<CircleDollarSign className="size-4" />} accent={totals.net < 0 ? 'text-destructive' : 'text-emerald-600'} />
              </Fragment>
            ))}
            {totalsByCurrency.size === 0 ? (
              <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">{t('customerProfitability.empty.noLinkedActivity')}</div>
            ) : null}
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <GroupedTotalsCard title={t('customerProfitability.sections.byEngagement')} groupLabel={t('customerProfitability.table.engagement')} entries={engagementTotals} formatMoney={formatMoney} emptyLabel={t('customerProfitability.empty.noLinkedActivity')} />
            <GroupedTotalsCard title={t('customerProfitability.sections.byVehicle')} groupLabel={t('customerProfitability.table.vehicle')} entries={vehicleTotals} formatMoney={formatMoney} emptyLabel={t('customerProfitability.empty.noLinkedActivity')} />
          </div>
          <p className="text-xs text-muted-foreground">{t('customerProfitability.sourcesIncluded')}</p>

          {(!access.salesOrders || !access.expenses || !access.purchaseOrders || !access.payroll || !access.directTransactions) ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
              {t('customerProfitability.permissionCoverage')}
            </div>
          ) : null}

          <Card className="shadow-sm">
            <CardHeader className="pb-2"><CardTitle className="text-base">{t('customerProfitability.sections.customerLedger')}</CardTitle></CardHeader>
            <CardContent className="p-0">
              {linkedRowsForCustomer.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted-foreground">{t('customerProfitability.empty.noLinkedActivity')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-sm">
                    <thead className="border-y bg-muted/40 text-start text-xs text-muted-foreground">
                      <tr><th className="px-4 py-3 text-start">{t('customerProfitability.table.date')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.source')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.description')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.category')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.engagement')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.vehicle')}</th><th className="px-4 py-3 text-end">{t('customerProfitability.table.amount')}</th><th className="px-4 py-3 text-end">{t('customerProfitability.table.action')}</th></tr>
                    </thead>
                    <tbody className="divide-y">
                      {linkedRowsForCustomer.map((row) => {
                        const engagement = engagements.find((item) => item.id === row.attribution?.engagementId)
                        const vehicle = vehicles.find((item) => item.id === row.attribution?.vehicleId)
                        return (
                          <tr key={getSourceKey(row.sourceType, row.sourceRecordId, row.sourceSubrecordId)}>
                            <td className="whitespace-nowrap px-4 py-3">{formatDate(row.date)}</td>
                            <td className="px-4 py-3"><Badge variant="outline">{t(`customerProfitability.sources.${row.sourceType}`)}</Badge><div className="mt-1 font-mono text-xs text-muted-foreground">{row.reference}</div></td>
                            <td className="max-w-[260px] truncate px-4 py-3" title={row.description || row.counterparty}>{row.description || row.counterparty}</td>
                            <td className="px-4 py-3">{row.category === 'revenue' ? t('customerProfitability.metrics.revenue') : t(`customerProfitability.categories.${row.category}`, { defaultValue: row.category })}</td>
                            <td className="px-4 py-3">{engagement?.name || t('customerProfitability.labels.unassigned')}</td>
                            <td className="px-4 py-3">{vehicle ? `${vehicle.plateNumber} · ${vehicle.make || vehicle.model}` : t('customerProfitability.labels.unassigned')}</td>
                            <td className={`whitespace-nowrap px-4 py-3 text-end font-semibold ${row.financialKind === 'revenue' ? 'text-emerald-600' : 'text-foreground'}`}>
                              {row.financialKind === 'expense' ? '− ' : '+ '}{formatMoney(row.amount, row.currency)}
                            </td>
                            <td className="px-4 py-3 text-end">
                              {canManageLinks ? <div className="flex justify-end gap-1">
                                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => openAttribution(row)}><Link2 className="me-1 size-3.5" />{t('customerProfitability.actions.editLink')}</Button>
                                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" title={t('customerProfitability.actions.unlink')} onClick={() => setUnlinkSource(row)}><Unlink className="size-4" /></Button>
                              </div> : null}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><CardTitle className="text-base">{t('customerProfitability.sections.sourceTransactions')}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{t('customerProfitability.sections.sourceTransactionsDescription')}</p></div>
          <div className="w-full sm:w-56">
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('customerProfitability.fields.allSources')}</SelectItem>
                {(['sales_order', 'purchase_order', 'expense_item', 'payroll_payment', 'direct_transaction'] as const).map((source) => (
                  <SelectItem key={source} value={source}>{t(`customerProfitability.sources.${source}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {unlinkedSources.length === 0 ? (
            <div className="px-5 pb-5 text-sm text-muted-foreground">{t('customerProfitability.empty.noSources')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-y bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 text-start">{t('customerProfitability.table.date')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.source')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.counterparty')}</th><th className="px-4 py-3 text-start">{t('customerProfitability.table.category')}</th><th className="px-4 py-3 text-end">{t('customerProfitability.table.amount')}</th><th className="px-4 py-3 text-end">{t('customerProfitability.table.action')}</th></tr></thead>
                <tbody className="divide-y">
                  {unlinkedSources.slice(0, 100).map((row) => (
                    <tr key={getSourceKey(row.sourceType, row.sourceRecordId, row.sourceSubrecordId)}>
                      <td className="whitespace-nowrap px-4 py-3">{formatDate(row.date)}</td>
                      <td className="px-4 py-3"><Badge variant="outline">{t(`customerProfitability.sources.${row.sourceType}`)}</Badge><div className="mt-1 font-mono text-xs text-muted-foreground">{row.reference}</div></td>
                      <td className="max-w-[220px] truncate px-4 py-3">{row.counterparty || t('customerProfitability.labels.unassigned')}</td>
                      <td className="px-4 py-3">{row.category === 'revenue' ? t('customerProfitability.metrics.revenue') : t(`customerProfitability.categories.${row.category}`, { defaultValue: row.category })}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-end font-medium">{formatMoney(row.amount, row.currency)}</td>
                      <td className="px-4 py-3 text-end">{canManageLinks ? <Button size="sm" variant="outline" onClick={() => openAttribution(row)}><Link2 className="me-1.5 size-3.5" />{t('customerProfitability.actions.link')}</Button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {unlinkedSources.length > 100 ? <p className="px-4 py-3 text-xs text-muted-foreground">{t('customerProfitability.labels.showingFirst100', { count: unlinkedSources.length })}</p> : null}
        </CardContent>
      </Card>

      <AppDialog open={attributionDialogOpen} onOpenChange={closeAttributionDialog}>
        <AppDialogContent className="max-w-2xl" showCloseButton={!isSaving} onPointerDownOutside={(event) => { if (isSaving) event.preventDefault() }} onEscapeKeyDown={(event) => { if (isSaving) event.preventDefault() }}>
          <AppDialogHeader><AppDialogTitle>{selectedSource?.attribution ? t('customerProfitability.dialogs.editLink') : t('customerProfitability.dialogs.linkTitle')}</AppDialogTitle></AppDialogHeader>
          <AppDialogBody>
            {selectedSource ? <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-muted/30 p-3">
              <Badge variant="outline">{t(`customerProfitability.sources.${selectedSource.sourceType}`)}</Badge><span className="font-mono text-sm">{selectedSource.reference}</span><span className="text-sm text-muted-foreground">{selectedSource.description || selectedSource.counterparty}</span><span className="ms-auto font-semibold">{selectedSource.financialKind === 'expense' ? '− ' : '+ '}{formatMoney(selectedSource.amount, selectedSource.currency)}</span>
            </div> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>{t('customerProfitability.fields.customerRequired')}</Label>
                <PartnerAutocompleteInput
                  value={selectedPartnerName}
                  onChange={(value) => { setSelectedPartnerName(value); if (value !== partnerById.get(selectedPartnerId)?.partnerName) { setSelectedPartnerId(''); setSelectedEngagementId('') } }}
                  onSelectPartner={(partner) => { setSelectedPartnerId(partner.id); setSelectedPartnerName(partner.partnerName); setSelectedEngagementId('') }}
                  workspaceId={workspaceId || ''}
                  roles={[...CUSTOMER_ROLES]}
                  required
                  placeholder={t('customerProfitability.fields.selectCustomer')}
                  disabled={isSaving}
                />
                {selectedPartnerId ? <div className="flex items-center gap-2"><Badge variant="secondary"><Link2 className="me-1 size-3" />{t('customerProfitability.labels.linked')}</Badge><Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setSelectedPartnerId(''); setSelectedPartnerName(''); setSelectedEngagementId('') }} disabled={isSaving}><Unlink className="me-1 size-3" />{t('customerProfitability.actions.unlink')}</Button></div> : null}
              </div>
              <div className="space-y-2">
                <Label>{t('customerProfitability.fields.engagement')}</Label>
                <Select value={selectedEngagementId || 'none'} onValueChange={(value) => setSelectedEngagementId(value === 'none' ? '' : value)} disabled={!selectedPartnerId || isSaving}>
                  <SelectTrigger><SelectValue placeholder={t('customerProfitability.fields.optionalEngagement')} /></SelectTrigger>
                  <SelectContent><SelectItem value="none">{t('customerProfitability.fields.noEngagement')}</SelectItem>{activeEngagements.map((engagement) => <SelectItem key={engagement.id} value={engagement.id}>{engagement.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('customerProfitability.fields.vehicle')}</Label>
                <Select value={selectedVehicleId || 'none'} onValueChange={(value) => setSelectedVehicleId(value === 'none' ? '' : value)} disabled={isSaving}>
                  <SelectTrigger><SelectValue placeholder={t('customerProfitability.fields.optionalVehicle')} /></SelectTrigger>
                  <SelectContent><SelectItem value="none">{t('customerProfitability.fields.noVehicle')}</SelectItem>{vehicles.filter((vehicle) => !vehicle.isDeleted).map((vehicle) => <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.plateNumber} · {vehicle.make || vehicle.model}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('customerProfitability.reportingOnlyNotice')}</p>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => closeAttributionDialog(false)} disabled={isSaving}>{t('common.cancel')}</Button>
            <Button className="w-full sm:w-auto" onClick={() => void handleSaveAttribution()} disabled={!workspaceId || !isAttributionValid || isSaving}>
              {isSaving ? <Loader2 className="me-2 size-4 animate-spin" /> : <Link2 className="me-2 size-4" />}
              {t('customerProfitability.actions.saveLink')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog open={engagementDialogOpen} onOpenChange={(open) => { if (!isSaving) setEngagementDialogOpen(open) }}>
        <AppDialogContent className="max-w-xl" showCloseButton={!isSaving} onPointerDownOutside={(event) => { if (isSaving) event.preventDefault() }} onEscapeKeyDown={(event) => { if (isSaving) event.preventDefault() }}>
          <AppDialogHeader><AppDialogTitle>{t('customerProfitability.dialogs.newEngagement')}</AppDialogTitle></AppDialogHeader>
          <AppDialogBody>
            <div className="space-y-4">
              <div className="space-y-2"><Label>{t('customerProfitability.fields.customerRequired')}</Label><PartnerAutocompleteInput value={newEngagementPartnerName} onChange={(value) => { setNewEngagementPartnerName(value); if (value !== partnerById.get(newEngagementPartnerId)?.partnerName) setNewEngagementPartnerId('') }} onSelectPartner={(partner) => { setNewEngagementPartnerId(partner.id); setNewEngagementPartnerName(partner.partnerName) }} workspaceId={workspaceId || ''} roles={[...CUSTOMER_ROLES]} required disabled={isSaving} placeholder={t('customerProfitability.fields.selectCustomer')} />{newEngagementPartnerId ? <div className="flex items-center gap-2"><Badge variant="secondary"><Link2 className="me-1 size-3" />{t('customerProfitability.labels.linked')}</Badge><Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={isSaving} onClick={() => { setNewEngagementPartnerId(''); setNewEngagementPartnerName('') }}><Unlink className="me-1 size-3" />{t('customerProfitability.actions.unlink')}</Button></div> : null}</div>
              <div className="space-y-2"><Label htmlFor="customer-profitability-engagement-name">{t('customerProfitability.fields.engagementNameRequired')}</Label><Input id="customer-profitability-engagement-name" value={newEngagementName} onChange={(event) => setNewEngagementName(event.target.value)} placeholder={t('customerProfitability.fields.engagementNamePlaceholder')} disabled={isSaving} /></div>
              <div className="space-y-2"><Label htmlFor="customer-profitability-engagement-notes">{t('customerProfitability.fields.notes')}</Label><Textarea id="customer-profitability-engagement-notes" value={newEngagementNotes} onChange={(event) => setNewEngagementNotes(event.target.value)} disabled={isSaving} rows={3} /></div>
              <p className="text-xs text-muted-foreground">{t('customerProfitability.reportingOnlyNotice')}</p>
            </div>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setEngagementDialogOpen(false)} disabled={isSaving}>{t('common.cancel')}</Button>
            <Button className="w-full sm:w-auto" onClick={() => void handleSaveEngagement()} disabled={!workspaceId || !newEngagementPartnerId || !newEngagementName.trim() || isSaving}>{isSaving ? <Loader2 className="me-2 size-4 animate-spin" /> : <Plus className="me-2 size-4" />}{t('customerProfitability.actions.createEngagement')}</Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <DeleteConfirmationModal
        isOpen={!!unlinkSource}
        onClose={() => { if (!isUnlinking) setUnlinkSource(null) }}
        onConfirm={() => void handleUnlink()}
        isLoading={isUnlinking}
        simpleConfirmation
        title={t('customerProfitability.dialogs.unlinkTitle')}
        description={t('customerProfitability.dialogs.unlinkDescription')}
        confirmLabel={t('customerProfitability.actions.unlink')}
      />
    </div>
  )
}

function MetricCard({ title, value, icon, accent }: { title: string; value: string; icon: ReactNode; accent?: string }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{title}</p><p className={`mt-1 truncate text-xl font-bold tabular-nums ${accent || ''}`}>{value}</p></div>
        <span className="rounded-xl bg-primary/10 p-2 text-primary">{icon}</span>
      </CardContent>
    </Card>
  )
}

function GroupedTotalsCard({
  title,
  groupLabel,
  entries,
  formatMoney,
  emptyLabel,
}: {
  title: string
  groupLabel: string
  entries: GroupTotalsEntry[]
  formatMoney: (amount: number, currency: string) => string
  emptyLabel: string
}) {
  const { t } = useTranslation()
  const rows = entries.flatMap((entry) => [...entry.totals.entries()].map(([currency, totals]) => ({
    key: `${entry.key}:${currency}`,
    label: `${entry.label} · ${currency.toUpperCase()}`,
    currency,
    ...totals,
  })))

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">{emptyLabel}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-y bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 text-start">{groupLabel}</th><th className="px-4 py-3 text-end">{t('customerProfitability.metrics.revenue')}</th><th className="px-4 py-3 text-end">{t('customerProfitability.metrics.expenses')}</th><th className="px-4 py-3 text-end">{t('customerProfitability.metrics.net')}</th></tr></thead>
              <tbody className="divide-y">{rows.map((row) => <tr key={row.key}><td className="px-4 py-3">{row.label}</td><td className="whitespace-nowrap px-4 py-3 text-end">{formatMoney(row.revenue, row.currency)}</td><td className="whitespace-nowrap px-4 py-3 text-end">{formatMoney(row.expenses, row.currency)}</td><td className={`whitespace-nowrap px-4 py-3 text-end font-semibold ${row.net < 0 ? 'text-destructive' : 'text-emerald-600'}`}>{formatMoney(row.net, row.currency)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
