import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  Activity, ArrowUpRight, BarChart3, Boxes, Building2, Check, ClipboardList,
  FileBarChart2, Instagram, Loader2, MessageCircle, Package, Plus, Search, ShoppingBag,
  Pencil, Store, Target, TrendingUp, Unlink, UserRound, UsersRound, Wallet, X,
  type LucideIcon,
} from 'lucide-react'

import { useOptionalAuth } from '@/auth/AuthContext'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useWorkspacePermissions } from '@/permissions'
import { db } from '@/local-db/database'
import type { Agent, BusinessPartner, CommerceOperationRecord, CommerceOperationRecordType, CurrencyCode, ExchangeRateSnapshot, PaymentAccount, Product, SalesOrder, SalesOrderItem } from '@/local-db/models'
import { createQuickSalesOrder, resolveSocialOrderAgentCreator } from '@/local-db/orders'
import { createBusinessPartner } from '@/local-db/businessPartners'
import { createCommerceOperationRecord, refreshCommerceOperationRecords, updateCommerceOperationRecord } from '@/local-db/commerceOperations'
import { useProducts, useStorages, usePriceBooks, usePriceBookItems, useInventory, usePaymentAccountsState } from '@/local-db'
import { ProductAutocompleteInput } from '@/ui/components/orders/ProductAutocompleteInput'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { CompactBusinessPartnerFormDialog, type CompactBusinessPartnerFormPayload } from '@/ui/components/crm/CompactBusinessPartnerFormDialog'
import { ProductsViewModal, ProductsViewModalTrigger } from '@/ui/components/ProductsViewModal'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { DateTimePicker } from '@/ui/components/ui/date-time-picker'
import { PriceBookName } from '@/ui/components/PriceBookName'
import { PaymentMethodSelector } from '@/ui/components/PaymentMethodSelector'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { Button } from '@/ui/components/button'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CurrencySelector,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useToast,
} from '@/ui/components'
import { calculateOrderTotalWithAdjustments, createOrderAdjustment } from '@/lib/orderAdjustments'
import { buildOrderExchangeRatesSnapshot, getAppliedCurrencyConversion } from '@/lib/orderCurrency'
import { fetchEURToIQDRate, fetchTRYToIQDRate, fetchUSDToIQDRate } from '@/lib/exchangeRate'
import { formatCurrency, formatNumericInput, generateId, sanitizeNumericInput } from '@/lib/utils'
import { useDateRange } from '@/context/DateRangeContext'
import { isOnline } from '@/lib/network'
import { STANDARD_PAYMENT_METHODS, type PaymentMethodOption } from '@/lib/paymentMethods'

type CommerceSection = 'social' | 'wholesale' | 'data' | 'coaches'
type OrderChannel = 'social' | 'wholesale'
type OrderSectionTab = 'recent' | 'newOrder'
type DataRecordKind = Extract<CommerceOperationRecordType, 'ad_spend' | 'dm_funnel' | 'city_market' | 'competitor'>
type OrderLineDraft = { id: string; product: Product | null; productQuery: string; quantity: string; price: number; costPrice: number; currency?: CurrencyCode; priceBookItemId?: string }

const PLATFORM_OPTIONS = ['instagram', 'tiktok', 'whatsapp', 'messenger', 'coach', 'other'] as const
const COMMERCE_CITY_OPTIONS = [
  { value: 'erbil-soran-districts', key: 'commerceOperations.cities.erbilSoranDistricts', deliveryFeeIqd: 4500 },
  { value: 'sulaymaniyah-halabja-districts', key: 'commerceOperations.cities.sulaymaniyahHalabjaDistricts', deliveryFeeIqd: 4500 },
  { value: 'duhok-zakho-akre-districts', key: 'commerceOperations.cities.duhokZakhoAkreDistricts', deliveryFeeIqd: 4500 },
  { value: 'erbil', key: 'commerceOperations.cities.erbil', deliveryFeeIqd: 2750 },
  { value: 'sulaymaniyah', key: 'commerceOperations.cities.sulaymaniyah', deliveryFeeIqd: 4500 },
  { value: 'duhok', key: 'commerceOperations.cities.duhok', deliveryFeeIqd: 4500 },
  { value: 'kirkuk', key: 'commerceOperations.cities.kirkuk', deliveryFeeIqd: 4500 },
  { value: 'halabja', key: 'commerceOperations.cities.halabja', deliveryFeeIqd: 4500 },
  { value: 'baghdad', key: 'commerceOperations.cities.baghdad', deliveryFeeIqd: 5500 },
  { value: 'basra', key: 'commerceOperations.cities.basra', deliveryFeeIqd: 5500 },
  { value: 'mosul-nineveh', key: 'commerceOperations.cities.mosulNineveh', deliveryFeeIqd: 5500 },
  { value: 'najaf', key: 'commerceOperations.cities.najaf', deliveryFeeIqd: 5500 },
  { value: 'karbala', key: 'commerceOperations.cities.karbala', deliveryFeeIqd: 5500 },
  { value: 'nasiriyah-dhi-qar', key: 'commerceOperations.cities.nasiriyahDhiQar', deliveryFeeIqd: 5500 },
  { value: 'maysan', key: 'commerceOperations.cities.maysan', deliveryFeeIqd: 5500 },
  { value: 'diwaniyah', key: 'commerceOperations.cities.diwaniyah', deliveryFeeIqd: 5500 },
  { value: 'samawah', key: 'commerceOperations.cities.samawah', deliveryFeeIqd: 5500 },
  { value: 'diyala', key: 'commerceOperations.cities.diyala', deliveryFeeIqd: 5500 },
  { value: 'kut-wasit', key: 'commerceOperations.cities.kutWasit', deliveryFeeIqd: 5500 },
  { value: 'anbar-ramadi', key: 'commerceOperations.cities.anbarRamadi', deliveryFeeIqd: 5500 },
  { value: 'salah-al-din', key: 'commerceOperations.cities.salahAlDin', deliveryFeeIqd: 5500 },
  { value: 'samarra', key: 'commerceOperations.cities.samarra', deliveryFeeIqd: 5500 },
  { value: 'tikrit', key: 'commerceOperations.cities.tikrit', deliveryFeeIqd: 5500 },
  { value: 'fallujah', key: 'commerceOperations.cities.fallujah', deliveryFeeIqd: 5500 },
  { value: 'babil-hilla', key: 'commerceOperations.cities.babilHilla', deliveryFeeIqd: 5500 },
] as const
const DATA_KIND_OPTIONS: DataRecordKind[] = ['ad_spend', 'dm_funnel', 'city_market', 'competitor']
const EMPTY_COMMERCE_RECORDS: CommerceOperationRecord[] = []
const EMPTY_SALES_ORDERS: SalesOrder[] = []

function parseAmount(value: string) {
  if (!value.trim()) return null
  const amount = Number(value.replace(/,/g, ''))
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function amountInput(value: string, integer = false) {
  return formatNumericInput(sanitizeNumericInput(value, { allowDecimal: !integer, maxFractionDigits: integer ? 0 : 2 }))
}

async function fetchDeliveryFeeExchangeRates(orderCurrency: CurrencyCode): Promise<ExchangeRateSnapshot[]> {
  if (orderCurrency === 'iqd') return []

  const timestamp = new Date().toISOString()
  if (orderCurrency === 'usd') {
    const result = await fetchUSDToIQDRate()
    return [{ pair: 'USD/IQD', rate: result.rate, source: result.source, timestamp: result.timestamp || timestamp }]
  }
  if (orderCurrency === 'eur') {
    const result = await fetchEURToIQDRate()
    return [
      ...(result.usdEur > 0 ? [{ pair: 'USD/EUR', rate: result.usdEur, source: result.source, timestamp }] : []),
      { pair: 'EUR/IQD', rate: result.eurIqd, source: result.source, timestamp },
    ]
  }

  const result = await fetchTRYToIQDRate()
  return [
    ...(result.usdTry > 0 ? [{ pair: 'USD/TRY', rate: result.usdTry, source: result.source, timestamp }] : []),
    { pair: 'TRY/IQD', rate: result.tryIqd, source: result.source, timestamp },
  ]
}

function rangeBounds(range: ReturnType<typeof useDateRange>['dateRange'], custom: { start: string; end: string }) {
  const today = new Date()
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const endOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
  if (range === 'allTime') return null
  if (range === 'custom') {
    return {
      start: custom.start ? new Date(`${custom.start}T00:00:00`) : null,
      end: custom.end ? new Date(`${custom.end}T23:59:59.999`) : null,
    }
  }
  if (range === 'today') return { start: startOfDay(today), end: endOfDay(today) }
  if (range === 'yesterday') {
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    return { start: startOfDay(yesterday), end: endOfDay(yesterday) }
  }
  if (range === 'lastMonth') {
    return { start: new Date(today.getFullYear(), today.getMonth() - 1, 1), end: new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59, 999) }
  }
  return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: endOfDay(today) }
}

function inSelectedRange(value: string | undefined, bounds: ReturnType<typeof rangeBounds>) {
  if (!bounds) return true
  if (!value) return false
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return (!bounds.start || date >= bounds.start) && (!bounds.end || date <= bounds.end)
}

function amountLabel(value: number, currency: CurrencyCode, preference: 'IQD' | 'د.ع') {
  return formatCurrency(value, currency, preference, 2)
}

function currencySummary(rows: Array<{ amount: number; currency: CurrencyCode }>, preference: 'IQD' | 'د.ع') {
  const totals = new Map<CurrencyCode, number>()
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) || 0) + row.amount)
  return [...totals.entries()].map(([currency, amount]) => amountLabel(amount, currency, preference)).join(' · ') || '0'
}

function MetricCard({ title, value, icon: Icon, hint }: { title: string; value: string | number; icon: LucideIcon; hint?: string }) {
  return (
    <Card className="overflow-hidden border-border/70">
      <CardContent className="flex items-start justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-2 truncate text-2xl font-bold tracking-tight">{value}</p>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span>
      </CardContent>
    </Card>
  )
}

function RequiredLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return <Label htmlFor={htmlFor}>{children} *</Label>
}

export function CommerceOperations() {
  const { t } = useTranslation()
  const auth = useOptionalAuth()
  const user = auth?.user
  const workspaceId = user?.workspaceId
  const { features, hasFeature } = useWorkspace()
  const { hasPermission } = useWorkspacePermissions()
  const [, navigate] = useLocation()
  const { dateRange, customDates } = useDateRange()
  const [section, setSection] = useState<CommerceSection>('social')
  const [orderSectionTabs, setOrderSectionTabs] = useState<Record<OrderChannel, OrderSectionTab>>({ social: 'recent', wholesale: 'recent' })
  const [dataDialogOpen, setDataDialogOpen] = useState(false)
  const [editingDataRecord, setEditingDataRecord] = useState<CommerceOperationRecord | null>(null)
  const [coachDialogOpen, setCoachDialogOpen] = useState(false)

  const products = useProducts(workspaceId, { enabled: Boolean(workspaceId && hasFeature('products')) })
  const storages = useStorages(workspaceId && hasFeature('products') ? workspaceId : undefined)
  const priceBooks = usePriceBooks(workspaceId, { enabled: Boolean(workspaceId && hasFeature('products')) })
  const priceBookItems = usePriceBookItems(workspaceId, { enabled: Boolean(workspaceId && hasFeature('products')) })
  const records = useLiveQuery(
    () => workspaceId
      ? db.commerce_operations_records.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? EMPTY_COMMERCE_RECORDS
  const salesOrders = useLiveQuery(
    () => workspaceId && hasFeature('orders')
      ? db.sales_orders.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId, features.orders],
  ) ?? EMPTY_SALES_ORDERS
  const businessPartners = useLiveQuery(
    () => workspaceId && hasFeature('agents')
      ? db.business_partners.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId, features.agents],
  ) ?? []
  const agentsQuery = useLiveQuery(
    () => workspaceId && hasFeature('agents')
      ? db.agents.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId, features.agents],
  )
  const agents = agentsQuery ?? []
  const commissionEntries = useLiveQuery(
    () => workspaceId && hasFeature('sales_agent_commissions')
      ? db.agent_commission_entries.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId, features.sales_agent_commissions],
  ) ?? []

  const freshnessTables = useMemo(() => [
    'commerce_operations_records',
    ...(hasFeature('products') ? ['products', 'inventory', 'storages', 'price_books', 'price_book_items'] : []),
    ...(hasFeature('orders') ? ['sales_orders'] : []),
    ...(hasFeature('agents') ? ['agents'] : []),
    ...(hasFeature('agents') || hasFeature('crm') ? ['business_partners'] : []),
    ...(hasFeature('sales_agent_commissions') ? ['agent_commission_entries'] : []),
  ], [hasFeature])

  useEffect(() => {
    if (!workspaceId || !isOnline(workspaceId)) return
    const refreshes: Promise<unknown>[] = [refreshCommerceOperationRecords(workspaceId)]
    if (hasFeature('products')) refreshes.push(import('@/local-db/hooks').then(({ fetchTableFromSupabase }) => fetchTableFromSupabase('inventory', db.inventory, workspaceId)))
    if (hasFeature('orders')) refreshes.push(import('@/local-db/hooks').then(({ fetchTableFromSupabase }) => fetchTableFromSupabase('sales_orders', db.sales_orders, workspaceId)))
    if (hasFeature('agents')) refreshes.push(import('@/local-db/hooks').then(({ fetchTableFromSupabase }) => fetchTableFromSupabase('agents', db.agents, workspaceId)))
    if (hasFeature('agents') || hasFeature('crm')) refreshes.push(import('@/local-db/hooks').then(({ fetchTableFromSupabase }) => fetchTableFromSupabase('business_partners', db.business_partners, workspaceId)))
    if (hasFeature('sales_agent_commissions')) refreshes.push(import('@/local-db/hooks').then(({ fetchTableFromSupabase }) => fetchTableFromSupabase('agent_commission_entries', db.agent_commission_entries, workspaceId)))
    void Promise.allSettled(refreshes)
  }, [workspaceId, hasFeature, features.agents, features.crm, features.orders, features.products, features.sales_agent_commissions])

  const bounds = useMemo(() => rangeBounds(dateRange, customDates), [customDates, dateRange])
  const orderDetailRecords = useMemo(
    () => records.filter((record) => record.recordType === 'order_details' && inSelectedRange(record.recordDate, bounds)).sort((a, b) => b.recordDate.localeCompare(a.recordDate)),
    [bounds, records],
  )
  const dataRecords = useMemo(
    () => records.filter((record) => DATA_KIND_OPTIONS.includes(record.recordType as DataRecordKind) && inSelectedRange(record.recordDate, bounds)).sort((a, b) => b.recordDate.localeCompare(a.recordDate)),
    [bounds, records],
  )
  const coachRecords = useMemo(
    () => records.filter((record) => record.recordType === 'coach_profile' && !record.isDeleted).sort((a, b) => a.title.localeCompare(b.title)),
    [records],
  )
  const orderMap = useMemo(() => new Map(salesOrders.map((order) => [order.id, order])), [salesOrders])
  const socialOrders = orderDetailRecords.filter((record) => record.payload.channel === 'social')
  const wholesaleOrders = orderDetailRecords.filter((record) => record.payload.channel === 'wholesale')
  const canCreateOrders = hasFeature('orders') && hasFeature('products') && hasFeature('crm') && hasPermission('orders.saleOrdersAccess')
  const canManageRecords = user?.role === 'admin' || user?.role === 'staff'
  const canUseCoaches = hasFeature('agents')
  const canViewCommissions = hasFeature('sales_agent_commissions')

  return (
    <div className="w-full space-y-6 pb-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold sm:text-3xl"><ShoppingBag className="h-7 w-7 text-primary" />{t('commerceOperations.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('commerceOperations.subtitle')}</p>
        </div>
        <ModulePageFreshness className="shrink-0" tableNames={freshnessTables} />
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Button variant={section === 'social' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setSection('social')}><Instagram className="h-4 w-4" />{t('commerceOperations.tabs.social')}</Button>
        <Button variant={section === 'wholesale' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setSection('wholesale')}><Store className="h-4 w-4" />{t('commerceOperations.tabs.wholesale')}</Button>
        <Button variant={section === 'data' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setSection('data')}><FileBarChart2 className="h-4 w-4" />{t('commerceOperations.tabs.data')}</Button>
        <Button variant={section === 'coaches' ? 'default' : 'outline'} className="justify-start gap-2" onClick={() => setSection('coaches')}><UsersRound className="h-4 w-4" />{t('commerceOperations.tabs.coaches')}</Button>
      </div>

      <div hidden={section !== 'social'}>
        <OrdersSection
          channel="social"
          records={socialOrders}
          orderMap={orderMap}
          canCreate={canCreateOrders}
          activeTab={orderSectionTabs.social}
          onTabChange={(tab) => setOrderSectionTabs((current) => ({ ...current, social: tab }))}
          onOpenOrder={(id) => navigate(`/orders/${id}`)}
          t={t}
          currencyPreference={features.iqd_display_preference}
          orderForm={(
            <OrderIntakeForm
              channel="social"
              active={orderSectionTabs.social === 'newOrder'}
              workspaceId={workspaceId}
              defaultCurrency={features.default_currency}
              userId={user?.id}
              userName={user?.name || ''}
              userRole={user?.role}
              products={products}
              storages={storages}
              priceBooks={priceBooks}
              priceBookItems={priceBookItems}
              agents={agents}
              agentsLoaded={agentsQuery !== undefined}
              businessPartners={businessPartners}
              available={canCreateOrders}
              maxDiscountPercent={features.max_discount_percent}
              iqdPreference={features.iqd_display_preference}
              onSaved={() => { if (workspaceId) void refreshCommerceOperationRecords(workspaceId) }}
              t={t}
            />
          )}
        />
      </div>
      <div hidden={section !== 'wholesale'}>
        <OrdersSection
          channel="wholesale"
          records={wholesaleOrders}
          orderMap={orderMap}
          canCreate={canCreateOrders}
          activeTab={orderSectionTabs.wholesale}
          onTabChange={(tab) => setOrderSectionTabs((current) => ({ ...current, wholesale: tab }))}
          onOpenOrder={(id) => navigate(`/orders/${id}`)}
          t={t}
          currencyPreference={features.iqd_display_preference}
          orderForm={(
            <OrderIntakeForm
              channel="wholesale"
              active={orderSectionTabs.wholesale === 'newOrder'}
              workspaceId={workspaceId}
              defaultCurrency={features.default_currency}
              userId={user?.id}
              userName={user?.name || ''}
              userRole={user?.role}
              products={products}
              storages={storages}
              priceBooks={priceBooks}
              priceBookItems={priceBookItems}
              agents={agents}
              agentsLoaded={agentsQuery !== undefined}
              businessPartners={businessPartners}
              available={canCreateOrders}
              maxDiscountPercent={features.max_discount_percent}
              iqdPreference={features.iqd_display_preference}
              onSaved={() => { if (workspaceId) void refreshCommerceOperationRecords(workspaceId) }}
              t={t}
            />
          )}
        />
      </div>
      {section === 'data' ? (
        <DataCenterSection
          records={dataRecords}
          products={products}
          t={t}
          currencyPreference={features.iqd_display_preference}
          canManage={canManageRecords}
          onCreate={() => { setEditingDataRecord(null); setDataDialogOpen(true) }}
          onEdit={(record) => { setEditingDataRecord(record); setDataDialogOpen(true) }}
          onOpenInventory={() => navigate('/stock-adjustments')}
        />
      ) : null}
      {section === 'coaches' ? (
        <CoachesSection
          records={coachRecords}
          agents={agents}
          partners={businessPartners}
          commissions={commissionEntries}
          canUseCoaches={canUseCoaches}
          canViewCommissions={canViewCommissions}
          canManage={canManageRecords}
          onAdd={() => setCoachDialogOpen(true)}
          onOpenAgents={() => navigate('/agents')}
          onOpenCommissions={() => navigate('/agents/commissions')}
          t={t}
          currencyPreference={features.iqd_display_preference}
        />
      ) : null}

      <DataRecordDialog
        open={dataDialogOpen}
        onOpenChange={(next) => { setDataDialogOpen(next); if (!next) setEditingDataRecord(null) }}
        record={editingDataRecord}
        workspaceId={workspaceId}
        userId={user?.id}
        iqdPreference={features.iqd_display_preference}
        canManage={canManageRecords}
        onSaved={() => { if (workspaceId) void refreshCommerceOperationRecords(workspaceId) }}
        t={t}
      />
      <CoachProfileDialog
        open={coachDialogOpen}
        onOpenChange={setCoachDialogOpen}
        workspaceId={workspaceId}
        userId={user?.id}
        existing={coachRecords}
        canManage={canManageRecords}
        onSaved={() => { if (workspaceId) void refreshCommerceOperationRecords(workspaceId) }}
        t={t}
      />
    </div>
  )
}

function OrdersSection({
  channel, records, orderMap, canCreate, activeTab, onTabChange, onOpenOrder, orderForm, t, currencyPreference,
}: {
  channel: OrderChannel
  records: CommerceOperationRecord[]
  orderMap: Map<string, SalesOrder>
  canCreate: boolean
  activeTab: OrderSectionTab
  onTabChange: (tab: OrderSectionTab) => void
  onOpenOrder: (id: string) => void
  orderForm: ReactNode
  t: (key: string, options?: Record<string, unknown>) => string
  currencyPreference: 'IQD' | 'د.ع'
}) {
  const [, navigate] = useLocation()
  const openCount = records.filter((record) => {
    const order = record.relatedOrderId ? orderMap.get(record.relatedOrderId) : undefined
    return !order || !order.isPaid
  }).length
  const orderValues = records.map((record) => {
    const order = record.relatedOrderId ? orderMap.get(record.relatedOrderId) : undefined
    return {
      amount: Number(record.payload.total ?? order?.total ?? 0),
      currency: ((record.payload.currency as CurrencyCode) || order?.currency || 'usd') as CurrencyCode,
    }
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="flex items-center gap-2 text-xl font-semibold">{channel === 'social' ? <Instagram className="h-5 w-5 text-primary" /> : <Store className="h-5 w-5 text-primary" />}{t(channel === 'social' ? 'commerceOperations.social.title' : 'commerceOperations.wholesale.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('commerceOperations.orders.unpaidHint')}</p></div>
        <Button variant="outline" className="gap-2" onClick={() => navigate('/products')}><Package className="h-4 w-4" />{t('commerceOperations.actions.products')}</Button>
      </div>
      {!canCreate ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">{t('commerceOperations.orders.prerequisite')}</div> : null}
      <div className="flex gap-2 border-b" role="tablist" aria-label={t(channel === 'social' ? 'commerceOperations.social.title' : 'commerceOperations.wholesale.title')}>
        <Button type="button" id={`${channel}-recent-tab`} role="tab" aria-controls={`${channel}-recent-panel`} aria-selected={activeTab === 'recent'} variant={activeTab === 'recent' ? 'default' : 'ghost'} className="-mb-px gap-2 rounded-b-none" onClick={() => onTabChange('recent')}><Activity className="h-4 w-4" />{t('commerceOperations.orders.recent')}</Button>
        <Button type="button" id={`${channel}-new-order-tab`} role="tab" aria-controls={`${channel}-new-order-panel`} aria-selected={activeTab === 'newOrder'} variant={activeTab === 'newOrder' ? 'default' : 'ghost'} className="-mb-px gap-2 rounded-b-none" onClick={() => onTabChange('newOrder')}><Plus className="h-4 w-4" />{t('commerceOperations.actions.newOrder')}</Button>
      </div>
      <div id={`${channel}-recent-panel`} role="tabpanel" aria-labelledby={`${channel}-recent-tab`} tabIndex={0} hidden={activeTab !== 'recent'} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard title={t('commerceOperations.metrics.intakeOrders')} value={records.length} icon={ClipboardList} />
          <MetricCard title={t('commerceOperations.metrics.waitingCollection')} value={openCount} icon={Wallet} />
          <MetricCard title={t('commerceOperations.metrics.orderValue')} value={currencySummary(orderValues, currencyPreference)} icon={TrendingUp} />
        </div>
        <DateRangeFilters label={t('commerceOperations.filters.orderDate')} />
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3"><CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5" />{t('commerceOperations.orders.recent')}</CardTitle><Badge variant="secondary">{records.length}</Badge></CardHeader>
          <CardContent>
            {records.length === 0 ? <EmptyState icon={Search} title={t('commerceOperations.orders.emptyTitle')} body={t('commerceOperations.orders.emptyBody')} /> : (
              <div className="space-y-3">
                {records.map((record) => {
                  const order = record.relatedOrderId ? orderMap.get(record.relatedOrderId) : undefined
                  const payload = record.payload
                  const currency = (payload.currency as CurrencyCode) || order?.currency || 'usd'
                  return (
                    <div key={record.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{record.title}</p><Badge variant="outline">{t(`commerceOperations.platforms.${String(payload.platform || 'other')}`)}</Badge><Badge variant={order?.isPaid ? 'default' : 'secondary'}>{t(order?.isPaid ? 'commerceOperations.orders.paid' : 'commerceOperations.orders.unpaid')}</Badge></div>
                        <p className="truncate text-sm text-muted-foreground">{String(payload.buyerName || '')} · {String(payload.buyerPhone || '')}{payload.city ? ` · ${String(payload.city)}` : ''}</p>
                        <p className="text-xs text-muted-foreground">{new Date(record.recordDate).toLocaleString()} · {String(payload.seller || t('commerceOperations.orders.sellerUnavailable'))}</p>
                      </div>
                      <div className="flex items-center justify-between gap-3 sm:justify-end">
                        <div className="text-end"><p className="font-bold">{amountLabel(Number(payload.total || order?.total || 0), currency, currencyPreference)}</p><p className="text-xs text-muted-foreground">{String(payload.orderNumber || order?.orderNumber || '')}</p></div>
                        {record.relatedOrderId && order ? <Button variant="outline" size="sm" className="gap-2" onClick={() => onOpenOrder(record.relatedOrderId!)}>{t('commerceOperations.actions.openOrder')}<ArrowUpRight className="h-4 w-4" /></Button> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <div id={`${channel}-new-order-panel`} role="tabpanel" aria-labelledby={`${channel}-new-order-tab`} tabIndex={0} hidden={activeTab !== 'newOrder'}>{orderForm}</div>
    </div>
  )
}

function DataCenterSection({ records, products, t, currencyPreference, canManage, onCreate, onEdit, onOpenInventory }: {
  records: CommerceOperationRecord[]
  products: Product[]
  t: (key: string, options?: Record<string, unknown>) => string
  currencyPreference: 'IQD' | 'د.ع'
  canManage: boolean
  onCreate: () => void
  onEdit: (record: CommerceOperationRecord) => void
  onOpenInventory: () => void
}) {
  const adSpendRows = records.flatMap((record) => {
    if (record.recordType === 'ad_spend') return [{ amount: Number(record.payload.amount || 0), currency: (record.payload.currency as CurrencyCode) || 'usd' }]
    if (record.recordType === 'dm_funnel' && Number(record.payload.adSpend || 0) > 0) return [{ amount: Number(record.payload.adSpend), currency: (record.payload.currency as CurrencyCode) || 'usd' }]
    return []
  })
  const dms = records.filter((record) => record.recordType === 'dm_funnel').reduce((sum, record) => sum + Number(record.payload.dms || 0), 0)
  const completedSales = records.filter((record) => record.recordType === 'dm_funnel').reduce((sum, record) => sum + Number(record.payload.completedSales || 0), 0)
  const lowStockCount = products.filter((product) => !product.isService && product.quantity <= product.minStockLevel).length
  const competitors = records.filter((record) => record.recordType === 'competitor').length

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="flex items-center gap-2 text-xl font-semibold"><FileBarChart2 className="h-5 w-5 text-primary" />{t('commerceOperations.data.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('commerceOperations.data.subtitle')}</p></div>{canManage ? <Button className="gap-2" onClick={onCreate}><Plus className="h-4 w-4" />{t('commerceOperations.actions.addRecord')}</Button> : null}</div>
      <DateRangeFilters label={t('commerceOperations.filters.recordDate')} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title={t('commerceOperations.data.adSpend')} value={currencySummary(adSpendRows, currencyPreference)} icon={Wallet} />
        <MetricCard title={t('commerceOperations.data.directMessages')} value={dms.toLocaleString()} icon={MessageCircle} />
        <MetricCard title={t('commerceOperations.data.completedSales')} value={completedSales.toLocaleString()} icon={Target} hint={t('commerceOperations.data.completionRate', { rate: dms ? `${((completedSales / dms) * 100).toFixed(1)}%` : '0%' })} />
        <MetricCard title={t('commerceOperations.data.lowStock')} value={lowStockCount} icon={Boxes} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)]">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" />{t('commerceOperations.data.records')}</CardTitle></CardHeader>
          <CardContent>
            {records.length === 0 ? <EmptyState icon={FileBarChart2} title={t('commerceOperations.data.emptyTitle')} body={t('commerceOperations.data.emptyBody')} /> : (
              <div className="space-y-3">
                {records.map((record) => (
                    <div key={record.id} className="flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t(`commerceOperations.recordTypes.${record.recordType}`)}</Badge><p className="truncate font-semibold">{record.title}</p></div><p className="mt-1 text-xs text-muted-foreground">{new Date(record.recordDate).toLocaleDateString()}</p></div>
                    <div className="flex items-center justify-between gap-3 sm:justify-end"><div className="text-sm text-muted-foreground">{recordSummary(record, t, currencyPreference)}</div>{canManage ? <Button type="button" variant="outline" size="icon" aria-label={t('commerceOperations.actions.editRecord')} title={t('commerceOperations.actions.editRecord')} onClick={() => onEdit(record)}><Pencil className="h-4 w-4" /></Button> : null}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" />{t('commerceOperations.data.inventoryTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-3"><p className="text-sm text-muted-foreground">{t('commerceOperations.data.inventoryHint')}</p><div className="flex items-center justify-between rounded-lg bg-muted/50 p-3"><span>{t('commerceOperations.data.lowStock')}</span><Badge variant={lowStockCount ? 'destructive' : 'secondary'}>{lowStockCount}</Badge></div><Button variant="outline" className="w-full gap-2" onClick={onOpenInventory}><Boxes className="h-4 w-4" />{t('commerceOperations.actions.openStockAdjustments')}<ArrowUpRight className="ms-auto h-4 w-4" /></Button></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" />{t('commerceOperations.data.competitorSnapshot')}</CardTitle></CardHeader>
            <CardContent className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{t('commerceOperations.data.competitorCount')}</p><Badge variant="secondary">{competitors}</Badge></CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function CoachesSection({ records, agents, partners, commissions, canUseCoaches, canViewCommissions, canManage, onAdd, onOpenAgents, onOpenCommissions, t, currencyPreference }: {
  records: CommerceOperationRecord[]
  agents: Array<{ id: string; businessPartnerId: string; status: string }>
  partners: BusinessPartner[]
  commissions: Array<{ agentId: string; orderId?: string | null; kind: string; status: string; currency: CurrencyCode; amount: number; occurredAt: string }>
  canUseCoaches: boolean
  canViewCommissions: boolean
  canManage: boolean
  onAdd: () => void
  onOpenAgents: () => void
  onOpenCommissions: () => void
  t: (key: string, options?: Record<string, unknown>) => string
  currencyPreference: 'IQD' | 'د.ع'
}) {
  const { dateRange, customDates } = useDateRange()
  const bounds = useMemo(() => rangeBounds(dateRange, customDates), [customDates, dateRange])
  const partnerById = useMemo(() => new Map(partners.map((partner) => [partner.id, partner])), [partners])
  const agentByPartner = useMemo(() => new Map(agents.map((agent) => [agent.businessPartnerId, agent])), [agents])
  const filteredCommissions = useMemo(() => commissions.filter((entry) => inSelectedRange(entry.occurredAt, bounds)), [bounds, commissions])

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="flex items-center gap-2 text-xl font-semibold"><UsersRound className="h-5 w-5 text-primary" />{t('commerceOperations.coaches.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('commerceOperations.coaches.subtitle')}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" className="gap-2" onClick={onOpenAgents}><UserRound className="h-4 w-4" />{t('commerceOperations.actions.openAgents')}</Button>{canUseCoaches && canManage ? <Button className="gap-2" onClick={onAdd}><Plus className="h-4 w-4" />{t('commerceOperations.actions.addCoach')}</Button> : null}</div></div>
      {!canUseCoaches ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">{t('commerceOperations.coaches.agentsRequired')}</div> : null}
      <DateRangeFilters label={t('commerceOperations.filters.commissionDate')} />
      <div className="grid gap-3 sm:grid-cols-3"><MetricCard title={t('commerceOperations.coaches.coachCount')} value={records.length} icon={UsersRound} /><MetricCard title={t('commerceOperations.coaches.activeCoaches')} value={records.filter((record) => record.relatedPartnerId && agentByPartner.get(record.relatedPartnerId)?.status === 'active').length} icon={Check} /><MetricCard title={t('commerceOperations.coaches.commissionEntries')} value={filteredCommissions.length} icon={Wallet} /></div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3"><CardTitle>{t('commerceOperations.coaches.directory')}</CardTitle>{canViewCommissions ? <Button variant="outline" size="sm" className="gap-2" onClick={onOpenCommissions}>{t('commerceOperations.actions.openCommissionLedger')}<ArrowUpRight className="h-4 w-4" /></Button> : null}</CardHeader>
        <CardContent>
          {!records.length ? <EmptyState icon={UsersRound} title={t('commerceOperations.coaches.emptyTitle')} body={t('commerceOperations.coaches.emptyBody')} /> : (
            <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t('commerceOperations.coaches.coach')}</TableHead><TableHead>{t('commerceOperations.fields.city')}</TableHead><TableHead>{t('commerceOperations.coaches.sales')}</TableHead><TableHead>{t('commerceOperations.coaches.commissionsEarned')}</TableHead><TableHead>{t('commerceOperations.coaches.paid')}</TableHead><TableHead>{t('commerceOperations.coaches.status')}</TableHead></TableRow></TableHeader><TableBody>
              {records.map((record) => {
                const partner = record.relatedPartnerId ? partnerById.get(record.relatedPartnerId) : undefined
                const agent = record.relatedPartnerId ? agentByPartner.get(record.relatedPartnerId) : undefined
                const rows = filteredCommissions.filter((entry) => entry.agentId === (record.payload.agentId || agent?.id))
                const earnedRows = rows.filter((entry) => entry.kind === 'accrual' && ['earned', 'approved', 'paid'].includes(entry.status))
                const paidRows = rows.filter((entry) => entry.kind === 'payout' || entry.status === 'paid')
                const orderCount = recordsForCoachSales(record, rows)
                return <TableRow key={record.id}><TableCell className="font-medium"><div>{partner?.partnerName || record.title}</div><div className="text-xs font-normal text-muted-foreground">{String(record.payload.phone || partner?.phone || '')}</div></TableCell><TableCell>{String(record.payload.city || partner?.city || '—')}</TableCell><TableCell>{orderCount}</TableCell><TableCell>{currencySummary(earnedRows.map((row) => ({ amount: row.amount, currency: row.currency })), currencyPreference)}</TableCell><TableCell>{currencySummary(paidRows.map((row) => ({ amount: Math.abs(row.amount), currency: row.currency })), currencyPreference)}</TableCell><TableCell><Badge variant={agent?.status === 'active' ? 'default' : 'secondary'}>{t(`commerceOperations.coaches.statuses.${agent?.status === 'active' ? 'active' : 'inactive'}`)}</Badge></TableCell></TableRow>
              })}
            </TableBody></Table></div>
          )}
          {canUseCoaches && !canViewCommissions ? <p className="mt-4 text-sm text-muted-foreground">{t('commerceOperations.coaches.commissionsUnavailable')}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function recordsForCoachSales(_record: CommerceOperationRecord, commissions: Array<{ kind: string; orderId?: string | null }>) {
  return new Set(commissions.filter((entry) => entry.kind === 'accrual' && entry.orderId).map((entry) => entry.orderId)).size
}

function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed px-4 py-8 text-center"><span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="h-5 w-5" /></span><p className="font-semibold">{title}</p><p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p></div>
}

function recordSummary(record: CommerceOperationRecord, t: (key: string, options?: Record<string, unknown>) => string, preference: 'IQD' | 'د.ع') {
  const data = record.payload
  switch (record.recordType) {
    case 'ad_spend': return amountLabel(Number(data.amount || 0), (data.currency as CurrencyCode) || 'usd', preference)
    case 'dm_funnel': return t('commerceOperations.data.dmSummary', { dms: Number(data.dms || 0).toLocaleString(), sales: Number(data.completedSales || 0).toLocaleString() })
    case 'city_market': return t('commerceOperations.data.citySummary', { pools: Number(data.poolCount || 0).toLocaleString(), swimmers: Number(data.swimmerCount || 0).toLocaleString() })
    case 'competitor': return `${t(`commerceOperations.data.competitorKinds.${String(data.kind || 'online')}`)} · ${String(data.pricePosition || '')}`
    default: return ''
  }
}

function OrderIntakeForm({ active, channel, workspaceId, defaultCurrency, userId, userName, userRole, products, storages, priceBooks, priceBookItems, agents, agentsLoaded, businessPartners, available, maxDiscountPercent, iqdPreference, onSaved, t }: {
  active: boolean
  channel: OrderChannel
  workspaceId?: string
  defaultCurrency: CurrencyCode
  userId?: string
  userName: string
  userRole?: 'admin' | 'staff' | 'viewer'
  products: Product[]
  storages: ReturnType<typeof useStorages>
  priceBooks: ReturnType<typeof usePriceBooks>
  priceBookItems: ReturnType<typeof usePriceBookItems>
  agents: Agent[]
  agentsLoaded: boolean
  businessPartners: BusinessPartner[]
  available: boolean
  maxDiscountPercent: number
  iqdPreference: 'IQD' | 'د.ع'
  onSaved: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const { toast } = useToast()
  const { exchangeData, eurRates, tryRates } = useExchangeRate()
  const [buyerName, setBuyerName] = useState('')
  const [buyerPhone, setBuyerPhone] = useState('')
  const [buyerPartner, setBuyerPartner] = useState<BusinessPartner | null>(null)
  const [createCustomerOpen, setCreateCustomerOpen] = useState(false)
  const [creatingCustomer, setCreatingCustomer] = useState(false)
  const [platform, setPlatform] = useState<(typeof PLATFORM_OPTIONS)[number]>('instagram')
  const [agentId, setAgentId] = useState('')
  const [agentNameSnapshot, setAgentNameSnapshot] = useState('')
  const [socialHandle, setSocialHandle] = useState('')
  const [seller, setSeller] = useState(userName)
  const [city, setCity] = useState('')
  const [otherCity, setOtherCity] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [storageId, setStorageId] = useState('')
  const [priceBookId, setPriceBookId] = useState('')
  const [lines, setLines] = useState<OrderLineDraft[]>([])
  const [browseLineId, setBrowseLineId] = useState<string | null>(null)
  const [deliveryFee, setDeliveryFee] = useState('')
  const [deliveryFeeTouched, setDeliveryFeeTouched] = useState(false)
  const [discount, setDiscount] = useState('')
  const [productsModalOpen, setProductsModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [preparingPayment, setPreparingPayment] = useState(false)
  const [paymentFeeExchangeRates, setPaymentFeeExchangeRates] = useState<ExchangeRateSnapshot[] | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodOption | null>('cash')
  const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
  const [paymentAccountSelectionTouched, setPaymentAccountSelectionTouched] = useState(false)
  const [orderId, setOrderId] = useState(() => generateId())
  const [attempted, setAttempted] = useState(false)
  const [date, setDate] = useState(new Date())
  const paymentAccountsState = usePaymentAccountsState(workspaceId, userId)
  const previewExchangeRates = useMemo(
    () => buildOrderExchangeRatesSnapshot({ exchangeData, eurRates, tryRates }),
    [exchangeData, eurRates, tryRates],
  )
  const storageInventory = useInventory(workspaceId, {
    enabled: active && Boolean(workspaceId && storageId),
    storageId,
  })
  const stockByProductId = useMemo(() => {
    const stock = new Map<string, number>()
    for (const row of storageInventory) {
      stock.set(row.productId, (stock.get(row.productId) || 0) + row.quantity)
    }
    return stock
  }, [storageInventory])
  const isProductAvailable = useCallback(
    (product: Product) => (stockByProductId.get(product.id) || 0) > 0,
    [stockByProductId],
  )

  const chosenPriceBookItem = (product: Product) => channel === 'wholesale' && priceBookId
    ? priceBookItems.find((item) => item.priceBookId === priceBookId && item.productId === product.id)
    : undefined
  const totalCurrency = lines.find((line) => line.product)?.currency
  const lineSubtotal = lines.reduce((sum, line) => sum + (line.product ? (Number(line.quantity.replace(/,/g, '')) || 0) * line.price : 0), 0)
  const fee = parseAmount(deliveryFee) ?? 0
  const deliveryFeeInvalid = (deliveryFeeTouched || Boolean(city)) && parseAmount(deliveryFee) === null
  const discountAmount = parseAmount(discount) ?? 0
  const appliedFeeExchangeRates = paymentDialogOpen && paymentFeeExchangeRates !== null
    ? paymentFeeExchangeRates
    : previewExchangeRates
  const feeConversion = totalCurrency
    ? getAppliedCurrencyConversion(fee, 'iqd', totalCurrency, appliedFeeExchangeRates)
    : null
  const feeInOrderCurrency = fee === 0 ? 0 : feeConversion?.convertedAmount ?? null
  const roundedSubtotal = Math.round(lineSubtotal * 100) / 100
  const discountedSubtotal = Math.round((roundedSubtotal - discountAmount) * 100) / 100
  const total = feeInOrderCurrency === null
    ? null
    : Math.max(0, Math.round((discountedSubtotal + feeInOrderCurrency) * 100) / 100)
  const orderTotalForPayment = total ?? 0
  const selectedCityOption = COMMERCE_CITY_OPTIONS.find((option) => option.value === city)
  const selectedCity = city === 'other'
    ? otherCity.trim()
    : selectedCityOption ? t(selectedCityOption.key) : ''
  const linkedAgents = useMemo(() => agents.flatMap((agent) => {
    const linkedUserId = agent.linkedUserId?.trim()
    if (agent.workspaceId !== workspaceId || agent.isDeleted || !linkedUserId) return []
    const partner = businessPartners.find((candidate) => candidate.id === agent.businessPartnerId && !candidate.isDeleted)
    const label = partner?.partnerName?.trim() || t('commerceOperations.order.agentFallback')
    return [{ id: agent.id, label, zone: agent.zone?.trim() || '', linkedUserId }]
  }), [agents, businessPartners, t, workspaceId])
  const selectedLinkedAgent = linkedAgents.find((agent) => agent.id === agentId)
  const selectedAgentAvailable = !agentId || Boolean(selectedLinkedAgent)
  const discountInvalid = lineSubtotal > 0 && discountAmount / lineSubtotal * 100 > maxDiscountPercent
  const paymentRequired = total !== null && total > 0.000001
  const selectedPaymentAccount = paymentAccount
    ? paymentAccountsState.accounts.find((account) => account.id === paymentAccount.id)
    : null
  const selectedPaymentAccountInvalid = Boolean(
    paymentAccount && paymentAccountsState.isReady && (
      !selectedPaymentAccount
      || !selectedPaymentAccount.isActive
      || (paymentMethod === 'cash' && selectedPaymentAccount.accountType !== 'cash_drawer')
    ),
  )
  const hasApplicableDefaultPaymentAccount = paymentAccountsState.accounts.some((account) => (
    account.isActive
    && account.isDefaultForPaymentSelector
    && (paymentMethod !== 'cash' || account.accountType === 'cash_drawer')
  ))
  const paymentAccountSelectionReady = !paymentRequired || (
    paymentAccountsState.isReady
    && (!hasApplicableDefaultPaymentAccount || Boolean(paymentAccount) || paymentAccountSelectionTouched)
  )
  const canSave = Boolean(
    available && !saving && workspaceId && seller.trim() && buyerName.trim() && buyerPhone.trim()
    && storageId && lines.length && lines.every((line) => line.product && line.currency && Number(line.quantity.replace(/,/g, '')) > 0)
    && (city !== 'other' || otherCity.trim()) && !deliveryFeeInvalid && !discountInvalid && totalCurrency
    && (!agentId || (platform === 'coach' && agentsLoaded && selectedAgentAvailable)),
  )

  useEffect(() => {
    if (!storageId && storages[0]) setStorageId(storages[0].id)
  }, [storageId, storages])

  function resetForm() {
    setBuyerName('')
    setBuyerPhone('')
    setBuyerPartner(null)
    setCreateCustomerOpen(false)
    setPlatform('instagram')
    setAgentId('')
    setAgentNameSnapshot('')
    setSocialHandle('')
    setSeller(userName)
    setCity('')
    setOtherCity('')
    setAddress('')
    setNotes('')
    setStorageId(storages[0]?.id || '')
    setPriceBookId('')
    setLines([])
    setBrowseLineId(null)
    setProductsModalOpen(false)
    setDeliveryFee('')
    setDeliveryFeeTouched(false)
    setDiscount('')
    setPaymentDialogOpen(false)
    setPreparingPayment(false)
    setPaymentFeeExchangeRates(null)
    setPaymentMethod('cash')
    setPaymentAccount(null)
    setPaymentAccountSelectionTouched(false)
    setOrderId(generateId())
    setAttempted(false)
    setDate(new Date())
  }

  async function continueToPayment() {
    setAttempted(true)
    if (!canSave || !workspaceId || !totalCurrency) return
    setPaymentDialogOpen(true)
    if (fee <= 0 || totalCurrency === 'iqd') {
      setPaymentFeeExchangeRates([])
      return
    }

    setPreparingPayment(true)
    try {
      setPaymentFeeExchangeRates(await fetchDeliveryFeeExchangeRates(totalCurrency))
    } catch {
      setPaymentDialogOpen(false)
      toast({ title: t('commerceOperations.toast.orderFailed'), description: t('commerceOperations.toast.deliveryFeeRateFailed'), variant: 'destructive' })
    } finally {
      setPreparingPayment(false)
    }
  }

  function handlePaymentAccountChange(account: PaymentAccount | null) {
    setPaymentAccount(account)
    setPaymentAccountSelectionTouched(true)
  }

  function addLine() {
    setLines((current) => [...current, {
      id: generateId(), product: null, productQuery: '', quantity: '1', price: 0, costPrice: 0,
    }])
  }

  function selectProduct(lineId: string, product: Product) {
    const bookItem = chosenPriceBookItem(product)
    const currency = bookItem?.currency || product.currency
    if (lines.some((line) => line.id !== lineId && line.product && line.currency !== currency)) {
      toast({ title: t('commerceOperations.toast.currencyMismatch'), variant: 'destructive' })
      return
    }
    const costPrice = bookItem?.costPrice ?? (currency === product.currency ? product.costPrice : null)
    if (!product.isService && costPrice == null) {
      toast({ title: t('commerceOperations.toast.costRequired'), description: t('commerceOperations.toast.costRequiredDetail'), variant: 'destructive' })
      return
    }
    setLines((current) => current.map((line) => line.id === lineId ? {
      ...line,
      product,
      productQuery: product.name,
      price: bookItem?.price ?? product.price,
      costPrice: costPrice ?? 0,
      currency,
      priceBookItemId: bookItem?.id,
    } : line))
  }

  function unlinkProduct(lineId: string) {
    setLines((current) => current.map((line) => line.id === lineId ? {
      ...line,
      product: null,
      productQuery: '',
      quantity: '1',
      price: 0,
      costPrice: 0,
      currency: undefined,
      priceBookItemId: undefined,
    } : line))
  }

  function removeLine(lineId: string) {
    setLines((current) => current.filter((line) => line.id !== lineId))
    if (browseLineId === lineId) setBrowseLineId(null)
  }

  async function createAndSelectCustomer(payload: CompactBusinessPartnerFormPayload) {
    if (!workspaceId) return
    setCreatingCustomer(true)
    try {
      const partner = await createBusinessPartner(workspaceId, payload)
      setBuyerPartner(partner)
      setBuyerName(partner.partnerName)
      setBuyerPhone(partner.phone || '')
      setCreateCustomerOpen(false)
      toast({ title: t('customers.messages.addSuccess') })
    } catch {
      toast({
        title: t('common.error'),
        description: t('customers.messages.addError'),
        variant: 'destructive',
      })
    } finally {
      setCreatingCustomer(false)
    }
  }

  async function saveCompletedPaidOrder() {
    if (!canSave || !workspaceId || !totalCurrency || !paymentDialogOpen) return
    if (paymentRequired && (!paymentMethod || !STANDARD_PAYMENT_METHODS.includes(paymentMethod as typeof STANDARD_PAYMENT_METHODS[number]))) return
    if (!paymentAccountSelectionReady || (paymentAccount && (!paymentAccountsState.isReady || !selectedPaymentAccount || selectedPaymentAccountInvalid))) {
      toast({ title: t('commerceOperations.toast.orderFailed'), description: t('commerceOperations.validation.paymentAccountUnavailable'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      let orderCreatorId = userId ?? null
      if (channel === 'social' && platform === 'coach' && agentId) {
        if (!agentsLoaded || !selectedAgentAvailable) {
          toast({ title: t('commerceOperations.toast.orderFailed'), description: t('commerceOperations.validation.agentCreatorInvalid'), variant: 'destructive' })
          return
        }
        try {
          orderCreatorId = await resolveSocialOrderAgentCreator(workspaceId, agentId)
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          const description = message === 'social_order_agent_creator_requires_connection'
            ? t('commerceOperations.validation.agentCreatorConnectionRequired')
            : message === 'social_order_agent_creator_invalid'
              ? t('commerceOperations.validation.agentCreatorInvalid')
              : t('commerceOperations.toast.tryAgain')
          toast({ title: t('commerceOperations.toast.orderFailed'), description, variant: 'destructive' })
          return
        }
      }
      const feeExchangeRates = paymentFeeExchangeRates ?? []

      let partner = buyerPartner
      if (!partner) {
        partner = await createBusinessPartner(workspaceId, {
          partnerName: buyerName.trim(),
          phone: buyerPhone.trim(),
          address: address.trim() || undefined,
          city: selectedCity || undefined,
          defaultCurrency: totalCurrency,
          role: 'customer',
          creditLimit: 0,
        })
      }
      const savedAt = date.toISOString()
      const subtotal = Math.round(lineSubtotal * 100) / 100
      const adjustment = fee > 0 ? createOrderAdjustment({
        id: generateId(), type: 'addition', name: t('commerceOperations.order.deliveryFee'), currency: 'iqd',
        amount: String(fee),
      }, totalCurrency, feeExchangeRates) : null
      if (fee > 0 && !adjustment) {
        toast({ title: t('commerceOperations.toast.orderFailed'), description: t('commerceOperations.toast.deliveryFeeRateFailed'), variant: 'destructive' })
        return
      }
      const orderTotal = Math.max(0, calculateOrderTotalWithAdjustments(
        Math.round((subtotal - discountAmount) * 100) / 100,
        adjustment ? [adjustment] : [],
      ))
      const items: SalesOrderItem[] = lines.flatMap((line) => {
        if (!line.product || !line.currency) return []
        const quantity = Number(line.quantity.replace(/,/g, ''))
        return [{
          id: generateId(), productId: line.product.id, productName: line.product.name,
          productSku: line.product.sku || '', unit: line.product.unit || null, quantity,
          lineTotal: Math.round(quantity * line.price * 100) / 100,
          originalCurrency: line.currency, originalUnitPrice: line.price,
          convertedUnitPrice: line.price, settlementCurrency: line.currency,
          costPrice: line.costPrice, convertedCostPrice: line.costPrice,
          storageId, ...(priceBookId ? { priceBookId, priceBookItemId: line.priceBookItemId } : {}),
        }]
      })
      const order = await createQuickSalesOrder(workspaceId, {
        businessPartnerId: partner.id,
        customerId: partner.id,
        customerName: buyerName.trim(),
        sourceStorageId: storageId,
        items,
        subtotal,
        discount: discountAmount,
        tax: 0,
        total: orderTotal,
        currency: totalCurrency,
        orderAdjustments: adjustment ? [{ ...adjustment, createdAt: savedAt, createdBy: userId ?? null }] : undefined,
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        exchangeRates: fee > 0 ? feeExchangeRates : [],
        status: 'completed',
        actualDeliveryDate: null,
        reservedAt: null,
        isPaid: true,
        paymentStatus: 'paid',
        paidAmount: orderTotal,
        balanceAmount: 0,
        paidAt: paymentRequired ? new Date().toISOString() : null,
        paymentMethod: paymentRequired ? paymentMethod as NonNullable<SalesOrder['paymentMethod']> : 'cash',
        initialPaymentAccountId: paymentRequired ? selectedPaymentAccount?.id ?? null : null,
        initialPaymentAccountNameSnapshot: paymentRequired ? selectedPaymentAccount?.name ?? null : null,
        initialPaymentAmount: 0,
        isInstallmentBased: false,
        installmentCount: 0,
        installmentFrequency: null,
        firstDueDate: null,
        nextDueDate: null,
        shippingAddress: [selectedCity, address.trim()].filter(Boolean).join(', '),
        notes: notes.trim() || undefined,
        sourceChannel: 'manual',
        createdAt: savedAt,
      }, orderCreatorId, { actingUserRole: userRole, orderId })

      let intakeRecordSaved = true
      try {
        await createCommerceOperationRecord(workspaceId, {
          recordType: 'order_details', recordDate: savedAt, title: order.orderNumber,
          relatedOrderId: order.id, relatedPartnerId: partner.id, createdBy: userId ?? null,
          payload: {
            channel, platform: channel === 'social' ? platform : 'other', socialHandle: socialHandle.trim() || null,
            seller: seller.trim(), buyerName: buyerName.trim(), buyerPhone: buyerPhone.trim(),
            city: selectedCity, address: address.trim(), deliveryFee: fee, deliveryFeeCurrency: 'iqd', discount: discountAmount,
            subtotal, total: orderTotal, currency: totalCurrency, orderNumber: order.orderNumber,
            fulfillmentStatus: 'completed', notes: notes.trim() || null,
          },
        })
      } catch {
        intakeRecordSaved = false
      }

      toast({
        title: t('commerceOperations.toast.orderSaved'),
        description: t(intakeRecordSaved ? 'commerceOperations.toast.orderSavedDetail' : 'commerceOperations.toast.intakeRecordFailedDetail'),
        ...(intakeRecordSaved ? {} : { variant: 'destructive' as const }),
      })
      setPaymentDialogOpen(false)
      onSaved()
      resetForm()
    } catch {
      toast({ title: t('commerceOperations.toast.orderFailed'), description: t('commerceOperations.toast.tryAgain'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const selectedBook = priceBooks.find((book) => book.id === priceBookId)
  return (
    <>
    <Card className="overflow-hidden">
      <CardHeader><CardTitle className="flex items-center gap-2"><ShoppingBag className="h-5 w-5 text-primary" />{t(channel === 'social' ? 'commerceOperations.order.socialTitle' : 'commerceOperations.order.wholesaleTitle')}</CardTitle></CardHeader>
      <CardContent className="space-y-5">
          {!available ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">{t('commerceOperations.orders.prerequisite')}</div> : null}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <RequiredLabel>{t('commerceOperations.fields.buyer')}</RequiredLabel>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <PartnerAutocompleteInput value={buyerName} onChange={(value) => { setBuyerName(value); if (buyerPartner) { setBuyerPartner(null); setBuyerPhone('') } }} onSelectPartner={(partner) => { setBuyerPartner(partner); setBuyerName(partner.partnerName); setBuyerPhone(partner.phone || '') }} workspaceId={workspaceId || ''} roles={['customer', 'both', 'online_customer']} placeholder={t('commerceOperations.placeholders.findBuyer')} disabled={saving || !workspaceId} className="min-w-0 flex-1" />
                {channel === 'social' ? (
                  <Button type="button" size="icon" variant="outline" className="h-10 w-10 shrink-0" aria-label={t('customers.addQuickCustomer')} title={t('customers.addQuickCustomer')} onClick={() => setCreateCustomerOpen(true)} disabled={saving || creatingCustomer || !workspaceId}>
                    <Plus className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button type="button" size="icon" variant="outline" aria-label={t('commerceOperations.actions.unlinkBuyer')} title={t('commerceOperations.actions.unlinkBuyer')} disabled={!buyerPartner || saving} onClick={() => { setBuyerPartner(null); setBuyerName(''); setBuyerPhone('') }}><X className="h-4 w-4" /></Button>
                )}
              </div>
              {buyerPartner ? channel === 'social' ? (
                <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <Badge className="gap-1"><Check className="h-3 w-3" />{t('commerceOperations.labels.linked')}</Badge>
                    <p className="mt-1 truncate text-sm font-semibold">{buyerPartner.partnerName}</p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-muted-foreground" disabled={saving} onClick={() => { setBuyerPartner(null); setBuyerName(''); setBuyerPhone('') }}>
                    <Unlink className="h-4 w-4" />
                    {t('commerceOperations.actions.unlinkBuyer')}
                  </Button>
                </div>
              ) : <Badge className="gap-1"><Check className="h-3 w-3" />{t('commerceOperations.labels.linked')}</Badge> : null}
              {attempted && !buyerName.trim() ? <p className="text-xs text-destructive">{t('commerceOperations.validation.buyerRequired')}</p> : null}
            </div>
            <div className="space-y-2"><RequiredLabel htmlFor="commerce-buyer-phone">{t('commerceOperations.fields.phone')}</RequiredLabel><Input id="commerce-buyer-phone" value={buyerPhone} onChange={(event) => setBuyerPhone(event.target.value)} placeholder={t('commerceOperations.placeholders.phone')} disabled={saving} />{attempted && !buyerPhone.trim() ? <p className="text-xs text-destructive">{t('commerceOperations.validation.phoneRequired')}</p> : null}</div>
            <div className="space-y-2"><RequiredLabel htmlFor="commerce-seller">{t('commerceOperations.fields.seller')}</RequiredLabel><Input id="commerce-seller" value={seller} onChange={(event) => setSeller(event.target.value)} placeholder={t('commerceOperations.placeholders.seller')} disabled={saving} />{attempted && !seller.trim() ? <p className="text-xs text-destructive">{t('commerceOperations.validation.sellerRequired')}</p> : null}</div>
            {channel === 'social' ? <div className="space-y-2"><RequiredLabel>{t('commerceOperations.fields.platform')}</RequiredLabel><Select value={platform} onValueChange={(value) => {
              const nextPlatform = value as typeof platform
              setPlatform(nextPlatform)
              if (nextPlatform !== 'coach') {
                setAgentId('')
                setAgentNameSnapshot('')
              }
            }} disabled={saving}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{PLATFORM_OPTIONS.map((option) => <SelectItem key={option} value={option}>{t(`commerceOperations.platforms.${option}`)}</SelectItem>)}</SelectContent></Select></div> : <div className="space-y-2"><Label>{t('commerceOperations.fields.priceBook')}</Label><Select value={priceBookId || 'none'} onValueChange={(value) => setPriceBookId(value === 'none' ? '' : value)} disabled={saving || lines.some((line) => Boolean(line.product))}><SelectTrigger><SelectValue placeholder={t('commerceOperations.placeholders.priceBook')} /></SelectTrigger><SelectContent><SelectItem value="none">{t('commerceOperations.fields.catalogPrices')}</SelectItem>{priceBooks.map((book) => <SelectItem key={book.id} value={book.id}><PriceBookName name={book.name} color={book.color} /></SelectItem>)}</SelectContent></Select>{selectedBook ? <p className="text-xs text-muted-foreground">{t('commerceOperations.order.priceBookHint')}</p> : null}</div>}
            {channel === 'social' && platform === 'coach' ? (
              <div className="space-y-2">
                <Label htmlFor="commerce-agent">{t('commerceOperations.fields.agent')}</Label>
                <Select value={agentId || 'none'} onValueChange={(value) => {
                  if (value === 'none') {
                    setAgentId('')
                    setAgentNameSnapshot('')
                    return
                  }
                  const selected = linkedAgents.find((agent) => agent.id === value)
                  if (!selected) return
                  setAgentId(selected.id)
                  setAgentNameSnapshot(selected.label)
                }} disabled={saving || !agentsLoaded}>
                  <SelectTrigger id="commerce-agent"><SelectValue placeholder={t('commerceOperations.placeholders.agent')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('commerceOperations.order.noAgentAttribution')}</SelectItem>
                    {agentId && !selectedLinkedAgent ? <SelectItem value={agentId} disabled>{agentNameSnapshot || t('commerceOperations.order.agentFallback')} · {t('commerceOperations.order.agentUnavailable')}</SelectItem> : null}
                    {linkedAgents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.zone ? `${agent.label} · ${agent.zone}` : agent.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('commerceOperations.order.agentAttributionHint')}</p>
                {attempted && agentId && (!agentsLoaded || !selectedAgentAvailable) ? <p className="text-xs text-destructive">{t('commerceOperations.validation.agentCreatorInvalid')}</p> : null}
              </div>
            ) : null}
            {channel === 'social' ? <div className="space-y-2"><Label htmlFor="commerce-social-handle">{t('commerceOperations.fields.socialHandle')}</Label><Input id="commerce-social-handle" value={socialHandle} onChange={(event) => setSocialHandle(event.target.value)} placeholder={t('commerceOperations.placeholders.socialHandle')} disabled={saving} /></div> : null}
            <div className="space-y-2">
              <Label>{t('commerceOperations.fields.cityRegion')}</Label>
              <Select value={city || 'unspecified'} onValueChange={(value) => {
                if (value === 'unspecified') {
                  setCity('')
                  setOtherCity('')
                  setDeliveryFee('')
                  setDeliveryFeeTouched(false)
                  return
                }
                setCity(value)
                if (value === 'other') {
                  setOtherCity('')
                  setDeliveryFee('')
                  setDeliveryFeeTouched(true)
                  return
                }
                setOtherCity('')
                const cityOption = COMMERCE_CITY_OPTIONS.find((option) => option.value === value)
                setDeliveryFee(cityOption ? amountInput(String(cityOption.deliveryFeeIqd), true) : '')
                setDeliveryFeeTouched(true)
              }} disabled={saving}>
                <SelectTrigger><SelectValue placeholder={t('commerceOperations.placeholders.city')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unspecified">{t('commerceOperations.placeholders.city')}</SelectItem>
                  {COMMERCE_CITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.key)} ({amountLabel(option.deliveryFeeIqd, 'iqd', iqdPreference)})</SelectItem>)}
                  <SelectItem value="other">{t('commerceOperations.platforms.other')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {city === 'other' ? (
              <div className="space-y-2">
                <RequiredLabel htmlFor="commerce-other-city">{t('commerceOperations.fields.cityRegion')}</RequiredLabel>
                <Input id="commerce-other-city" value={otherCity} onChange={(event) => setOtherCity(event.target.value)} placeholder={t('commerceOperations.placeholders.otherCity')} disabled={saving} />
                {attempted && !otherCity.trim() ? <p className="text-xs text-destructive">{t('commerceOperations.validation.otherCityRequired')}</p> : null}
              </div>
            ) : null}
            <div className="space-y-2"><Label htmlFor="commerce-address">{t('commerceOperations.fields.address')}</Label><Input id="commerce-address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder={t('commerceOperations.placeholders.address')} disabled={saving} /></div>
            <div className="space-y-2"><RequiredLabel>{t('commerceOperations.fields.orderDate')}</RequiredLabel><DateTimePicker date={date} setDate={(next) => next && setDate(next)} mode="date" disabled={saving} placeholder={t('commerceOperations.fields.orderDate')} /></div>
            <div className="space-y-2"><RequiredLabel>{t('commerceOperations.fields.storage')}</RequiredLabel><Select value={storageId} onValueChange={setStorageId} disabled={saving || !storages.length}><SelectTrigger><SelectValue placeholder={t('commerceOperations.placeholders.storage')} /></SelectTrigger><SelectContent>{storages.map((storage) => <SelectItem key={storage.id} value={storage.id}>{storage.name}</SelectItem>)}</SelectContent></Select>{attempted && !storageId ? <p className="text-xs text-destructive">{t('commerceOperations.validation.storageRequired')}</p> : null}</div>
          </div>

          <div className="mt-6 space-y-3 rounded-xl border p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="flex items-center gap-2 font-semibold"><Package className="h-4 w-4 text-primary" /><RequiredLabel>{t('commerceOperations.order.items')}</RequiredLabel></h3>
              <Button type="button" variant="outline" className="gap-2" onClick={addLine} disabled={saving}>
                <Plus className="h-4 w-4" />{t('commerceOperations.actions.addProductLine')}
              </Button>
            </div>
            {lines.length === 0 ? <p className="rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">{t('commerceOperations.order.noItems')}</p> : (
              <div className="space-y-3">
                {lines.map((line, index) => {
                  const quantity = Number(line.quantity.replace(/,/g, '')) || 0
                  return (
                    <div key={line.id} className="space-y-3 rounded-lg border bg-muted/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{t('commerceOperations.order.itemLine', { number: index + 1 })}</p>
                        <Button type="button" size="icon" variant="ghost" aria-label={t('commerceOperations.actions.removeProduct')} title={t('commerceOperations.actions.removeProduct')} disabled={saving} onClick={() => removeLine(line.id)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                        <div className="min-w-0 space-y-2">
                          <RequiredLabel>{t('commerceOperations.fields.product')}</RequiredLabel>
                          <div className="flex min-w-0">
                            <ProductsViewModalTrigger
                              onClick={() => { setBrowseLineId(line.id); setProductsModalOpen(true) }}
                              label={t('commerceOperations.actions.browseProducts')}
                              className="h-10 w-10 shrink-0 rounded-e-none rounded-s-lg border-e-0"
                            />
                            <ProductAutocompleteInput
                              value={line.productQuery}
                              onChange={(value) => setLines((current) => current.map((entry) => entry.id === line.id ? {
                                ...entry, product: null, productQuery: value, quantity: '1', price: 0, costPrice: 0, currency: undefined, priceBookItemId: undefined,
                              } : entry))}
                              onSelectProduct={(product) => selectProduct(line.id, product)}
                              hasSelection={Boolean(line.product)}
                              linkedLabel={t('commerceOperations.labels.linked')}
                              placeholder={t('commerceOperations.placeholders.searchProduct')}
                              disabled={saving || !storageId}
                              storageId={storageId}
                              isProductAvailable={isProductAvailable}
                              className="min-w-0 flex-1"
                              inputClassName={line.product ? 'rounded-none' : 'rounded-s-none'}
                            />
                            {line.product ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-10 w-10 shrink-0 rounded-e-lg rounded-s-none border-s-0"
                                aria-label={t('commerceOperations.actions.unlinkProduct')}
                                title={t('commerceOperations.actions.unlinkProduct')}
                                disabled={saving}
                                onClick={() => unlinkProduct(line.id)}
                              >
                                <Unlink className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                          {attempted && !line.product ? <p className="text-xs text-destructive">{t('commerceOperations.validation.productRequired')}</p> : null}
                        </div>
                        <div className="space-y-2">
                          <RequiredLabel htmlFor={`commerce-line-quantity-${line.id}`}>{t('commerceOperations.fields.quantity')}</RequiredLabel>
                          <Input id={`commerce-line-quantity-${line.id}`} aria-label={t('commerceOperations.fields.quantity')} inputMode="numeric" value={line.quantity} placeholder="0" onChange={(event) => setLines((current) => current.map((entry) => entry.id === line.id ? { ...entry, quantity: amountInput(event.target.value, true) } : entry))} disabled={saving || !line.product} className="text-end" />
                        </div>
                      </div>
                      {line.product && line.currency ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm">
                          <p className="min-w-0 truncate text-xs text-muted-foreground">{line.product.sku || t('commerceOperations.order.noSku')} · {amountLabel(line.price, line.currency, iqdPreference)} {t('commerceOperations.order.each')}</p>
                          <span className="font-semibold">{amountLabel(line.price * quantity, line.currency, iqdPreference)}</span>
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
            {attempted && !lines.length ? <p className="text-xs text-destructive">{t('commerceOperations.validation.productRequired')}</p> : null}
            {totalCurrency ? <p className="text-xs text-muted-foreground">{t('commerceOperations.order.currencyNote', { currency: totalCurrency.toUpperCase() })}</p> : null}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              {deliveryFeeTouched || city
                ? <RequiredLabel htmlFor="commerce-delivery-fee">{t('commerceOperations.order.deliveryFee')}</RequiredLabel>
                : <Label htmlFor="commerce-delivery-fee">{t('commerceOperations.order.deliveryFee')}</Label>}
              <Input id="commerce-delivery-fee" inputMode="numeric" value={deliveryFee} placeholder="0" onChange={(event) => { setDeliveryFeeTouched(true); setDeliveryFee(amountInput(event.target.value, true)) }} disabled={saving} />
              {attempted && deliveryFeeInvalid ? <p className="text-xs text-destructive">{t('commerceOperations.validation.amountRequired')}</p> : null}
              <p className="text-xs text-muted-foreground">{t('commerceOperations.order.deliveryFeeHint')}</p>
            </div>
            <div className="space-y-2"><Label htmlFor="commerce-discount">{t('commerceOperations.order.discount')}</Label><Input id="commerce-discount" inputMode="decimal" value={discount} placeholder="0" onChange={(event) => setDiscount(amountInput(event.target.value))} disabled={saving} />{discountInvalid ? <p className="text-xs text-destructive">{t('commerceOperations.validation.discountLimit', { percent: maxDiscountPercent })}</p> : null}</div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="commerce-order-notes">{t('commerceOperations.fields.notes')}</Label><Textarea id="commerce-order-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={saving} /></div>
          </div>
          <div className="mt-4 rounded-xl bg-primary/5 p-4"><div className="flex justify-between gap-3 text-sm"><span>{t('commerceOperations.order.subtotal')}</span><span>{totalCurrency ? amountLabel(lineSubtotal, totalCurrency, iqdPreference) : '—'}</span></div><div className="mt-2 flex justify-between gap-3 text-sm"><span>{t('commerceOperations.order.deliveryFee')}</span><span>{amountLabel(fee, 'iqd', iqdPreference)}</span></div><div className="mt-2 flex justify-between gap-3 text-sm"><span>{t('commerceOperations.order.discount')}</span><span>{totalCurrency ? amountLabel(discountAmount, totalCurrency, iqdPreference) : '—'}</span></div><div className="mt-3 flex justify-between gap-3 border-t pt-3 text-lg font-bold"><span>{t('commerceOperations.order.total')}</span><span>{totalCurrency && total !== null ? amountLabel(total, totalCurrency, iqdPreference) : '—'}</span></div></div>
          <p className="mt-3 text-xs text-muted-foreground">{t('commerceOperations.order.paymentAtIntakeHint')}</p>
        <div className="flex justify-end border-t pt-4">
          <Button type="button" className="gap-2" disabled={!canSave || saving || preparingPayment || paymentDialogOpen} onClick={() => void continueToPayment()}>
            {preparingPayment ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
            {preparingPayment ? t('commerceOperations.actions.preparingPayment') : t('commerceOperations.actions.continueToPayment')}
          </Button>
        </div>
      </CardContent>
    </Card>
      <ProductsViewModal
        key={storageId}
        open={productsModalOpen}
        onOpenChange={(nextOpen) => { setProductsModalOpen(nextOpen); if (!nextOpen) setBrowseLineId(null) }}
        products={products}
        storages={storages}
        showStorageSelector={false}
        initialStorageId={storageId}
        filterProducts={(availableProducts) => availableProducts.filter(isProductAvailable)}
        getProductMeta={(product) => t('orders.form.availableQuantity', {
          quantity: stockByProductId.get(product.id) || 0,
          defaultValue: `Available: ${stockByProductId.get(product.id) || 0}`,
        })}
        onSelectProduct={(product) => { if (browseLineId) selectProduct(browseLineId, product) }}
        labels={{
          title: t('commerceOperations.actions.browseProducts'),
          description: t('commerceOperations.order.productBrowseHint'),
          searchLabel: t('commerceOperations.placeholders.searchProduct'),
          searchPlaceholder: t('commerceOperations.placeholders.searchProduct'),
          storageLabel: t('commerceOperations.fields.storage'),
          storagePlaceholder: t('commerceOperations.placeholders.storage'),
          noProductsLabel: t('inventoryTransfer.noProductsInSource'),
        }}
      />
      {channel === 'social' ? (
        <CompactBusinessPartnerFormDialog
          isOpen={createCustomerOpen}
          onOpenChange={setCreateCustomerOpen}
          workspaceId={workspaceId}
          defaultCurrency={defaultCurrency}
          role="customer"
          title={t('customers.addQuickCustomer')}
          submitLabel={t('common.create')}
          isSaving={creatingCustomer}
          onSubmit={createAndSelectCustomer}
        />
      ) : null}
    <AppDialog open={paymentDialogOpen} onOpenChange={(next) => { if (!saving && !preparingPayment) setPaymentDialogOpen(next) }}>
      <AppDialogContent className="max-w-lg" onPointerDownOutside={(event) => (saving || preparingPayment) && event.preventDefault()} onEscapeKeyDown={(event) => (saving || preparingPayment) && event.preventDefault()}>
        <AppDialogHeader><AppDialogTitle className="flex items-center gap-2">{paymentRequired ? <Wallet className="h-5 w-5 text-primary" /> : <ShoppingBag className="h-5 w-5 text-primary" />}{t(paymentRequired ? 'commerceOperations.order.paymentTitle' : 'orders.status.completed')}</AppDialogTitle></AppDialogHeader>
        <AppDialogBody className="space-y-4" aria-busy={preparingPayment}>
          {preparingPayment ? (
            <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('commerceOperations.actions.preparingPayment')}</div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t(paymentRequired ? 'commerceOperations.order.paymentDescription' : 'commerceOperations.order.zeroTotalDescription')}</p>
              <div className="rounded-xl border bg-muted/30 p-4">
                <p className="text-sm text-muted-foreground">{t(paymentRequired ? 'commerceOperations.order.amountReceived' : 'commerceOperations.order.total')}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{totalCurrency ? amountLabel(orderTotalForPayment, totalCurrency, iqdPreference) : '—'}</p>
              </div>
              {paymentRequired ? (
                <>
                  <div className="space-y-2">
                    <RequiredLabel>{t('pos.paymentMethod')}</RequiredLabel>
                    <PaymentMethodSelector
                      value={paymentMethod}
                      onValueChange={setPaymentMethod}
                      methods={STANDARD_PAYMENT_METHODS}
                      allowNone
                      noneLabel={t('pos.quickOrder.selectPaymentMethod')}
                      workspaceId={workspaceId}
                      disabled={saving}
                      onLinkedPaymentAccountSelect={handlePaymentAccountChange}
                    />
                  </div>
                  <PaymentAccountSelector
                    workspaceId={workspaceId}
                    value={paymentAccount?.id ?? null}
                    onValueChange={handlePaymentAccountChange}
                    disabled={saving}
                    cashDrawerOnly={paymentMethod === 'cash'}
                  />
                  {selectedPaymentAccountInvalid ? <p className="text-xs text-destructive">{t('commerceOperations.validation.paymentAccountUnavailable')}</p> : null}
                </>
              ) : null}
            </>
          )}
        </AppDialogBody>
        <AppDialogFooter>
          <Button type="button" variant="outline" disabled={saving || preparingPayment} onClick={() => setPaymentDialogOpen(false)}>{t('commerceOperations.actions.backToOrder')}</Button>
          <Button
            type="button"
            disabled={saving || preparingPayment || !canSave || (paymentRequired && (!paymentMethod || !STANDARD_PAYMENT_METHODS.includes(paymentMethod as typeof STANDARD_PAYMENT_METHODS[number]))) || !paymentAccountSelectionReady || (Boolean(paymentAccount) && (!paymentAccountsState.isReady || selectedPaymentAccountInvalid))}
            onClick={() => void saveCompletedPaidOrder()}
          >
            {saving ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Check className="me-2 h-4 w-4" />}
            {saving ? t('commerceOperations.actions.saving') : t(paymentRequired ? 'commerceOperations.actions.confirmPaymentAndComplete' : 'commerceOperations.actions.completeOrder')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
    </>
  )
}

function DataRecordDialog({ open, onOpenChange, record, workspaceId, userId, iqdPreference, canManage, onSaved, t }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  record: CommerceOperationRecord | null
  workspaceId?: string
  userId?: string
  iqdPreference: 'IQD' | 'د.ع'
  canManage: boolean
  onSaved: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const { toast } = useToast()
  const [kind, setKind] = useState<DataRecordKind>('ad_spend')
  const [date, setDate] = useState(new Date())
  const [platform, setPlatform] = useState<(typeof PLATFORM_OPTIONS)[number]>('instagram')
  const [currency, setCurrency] = useState<CurrencyCode>('usd')
  const [amount, setAmount] = useState('')
  const [language, setLanguage] = useState('ku')
  const [reach, setReach] = useState('')
  const [dms, setDms] = useState('')
  const [completedSales, setCompletedSales] = useState('')
  const [city, setCity] = useState('')
  const [poolCount, setPoolCount] = useState('')
  const [swimmerCount, setSwimmerCount] = useState('')
  const [competitorName, setCompetitorName] = useState('')
  const [competitorKind, setCompetitorKind] = useState<'online' | 'physical'>('online')
  const [followers, setFollowers] = useState('')
  const [pricePosition, setPricePosition] = useState('mid')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempted, setAttempted] = useState(false)

  useEffect(() => {
    if (!open) return
    if (!record) {
      setKind('ad_spend'); setDate(new Date()); setPlatform('instagram'); setCurrency('usd'); setAmount(''); setLanguage('ku'); setReach(''); setDms(''); setCompletedSales(''); setCity(''); setPoolCount(''); setSwimmerCount(''); setCompetitorName(''); setCompetitorKind('online'); setFollowers(''); setPricePosition('mid'); setNotes(''); setSaving(false); setAttempted(false)
      return
    }
    const payload = record.payload
    const numericText = (value: unknown) => value === null || value === undefined ? '' : amountInput(String(value), true)
    setKind(record.recordType as DataRecordKind)
    setDate(new Date(record.recordDate))
    setPlatform(PLATFORM_OPTIONS.includes(payload.platform as (typeof PLATFORM_OPTIONS)[number]) ? payload.platform as (typeof PLATFORM_OPTIONS)[number] : 'other')
    setCurrency((payload.currency as CurrencyCode) || 'usd')
    const savedAmount = payload.amount ?? payload.adSpend
    setAmount(savedAmount === null || savedAmount === undefined ? '' : amountInput(String(savedAmount)))
    setLanguage(String(payload.language || 'ku'))
    setReach(numericText(payload.reach)); setDms(numericText(payload.dms)); setCompletedSales(numericText(payload.completedSales))
    setCity(String(payload.city || '')); setPoolCount(numericText(payload.poolCount)); setSwimmerCount(numericText(payload.swimmerCount))
    setCompetitorName(String(payload.competitorName || record.title)); setCompetitorKind(payload.kind === 'physical' ? 'physical' : 'online')
    setFollowers(numericText(payload.followers)); setPricePosition(String(payload.pricePosition || 'mid')); setNotes(String(payload.notes || payload.branding || ''))
    setSaving(false); setAttempted(false)
  }, [open, record])

  const textRequired = kind === 'city_market' ? city.trim() : kind === 'competitor' ? competitorName.trim() : true
  const numericFields = kind === 'ad_spend' ? [amount] : kind === 'dm_funnel' ? [reach, dms, completedSales, amount] : kind === 'city_market' ? [poolCount, swimmerCount] : []
  const numbersValid = numericFields.every((value) => parseAmount(value) !== null)
  const valid = Boolean(canManage && workspaceId && textRequired && numbersValid && !saving)
  const close = (next: boolean) => { if (saving && !next) return; onOpenChange(next) }

  async function save() {
    setAttempted(true)
    if (!valid || !workspaceId) return
    setSaving(true)
    try {
      const payload: Record<string, unknown> = { notes: notes.trim() || null }
      let title = ''
      if (kind === 'ad_spend') {
        title = t(`commerceOperations.platforms.${platform}`)
        Object.assign(payload, { platform, amount: parseAmount(amount), currency })
      } else if (kind === 'dm_funnel') {
        title = t('commerceOperations.data.dmTitle', { platform: t(`commerceOperations.platforms.${platform}`), date: date.toLocaleDateString() })
        Object.assign(payload, { platform, language, reach: parseAmount(reach), dms: parseAmount(dms), completedSales: parseAmount(completedSales), adSpend: parseAmount(amount), currency })
      } else if (kind === 'city_market') {
        title = city.trim()
        Object.assign(payload, { city: city.trim(), poolCount: parseAmount(poolCount), swimmerCount: parseAmount(swimmerCount) })
      } else {
        title = competitorName.trim()
        Object.assign(payload, { competitorName: title, kind: competitorKind, platform: competitorKind === 'online' ? platform : null, followers: parseAmount(followers), pricePosition, branding: notes.trim() || null })
      }
      if (record) {
        await updateCommerceOperationRecord(workspaceId, record.id, { recordDate: date.toISOString(), title, payload })
      } else {
        await createCommerceOperationRecord(workspaceId, {
          recordType: kind, recordDate: date.toISOString(), title, payload, createdBy: userId ?? null,
        })
      }
      toast({ title: t('commerceOperations.toast.recordSaved') })
      onSaved(); close(false)
    } catch {
      toast({ title: t('commerceOperations.toast.recordFailed'), description: t('commerceOperations.toast.tryAgain'), variant: 'destructive' })
    } finally { setSaving(false) }
  }

  return (
    <AppDialog open={open} onOpenChange={close}>
      <AppDialogContent className="max-w-2xl" onPointerDownOutside={(event) => saving && event.preventDefault()} onEscapeKeyDown={(event) => saving && event.preventDefault()}>
        <AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><FileBarChart2 className="h-5 w-5 text-primary" />{t(record ? 'commerceOperations.data.editRecord' : 'commerceOperations.data.addRecord')}</AppDialogTitle></AppDialogHeader>
        <AppDialogBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2"><RequiredLabel>{t('commerceOperations.data.recordType')}</RequiredLabel><Select value={kind} onValueChange={(value) => setKind(value as DataRecordKind)} disabled={saving || Boolean(record)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{DATA_KIND_OPTIONS.map((option) => <SelectItem key={option} value={option}>{t(`commerceOperations.recordTypes.${option}`)}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><RequiredLabel>{t('commerceOperations.fields.date')}</RequiredLabel><DateTimePicker date={date} setDate={(next) => next && setDate(next)} mode="date" disabled={saving} placeholder={t('commerceOperations.fields.date')} /></div>
            {kind === 'ad_spend' ? <>
              <div className="space-y-2"><RequiredLabel>{t('commerceOperations.fields.platform')}</RequiredLabel><PlatformSelect value={platform} onChange={setPlatform} disabled={saving} t={t} /></div>
              <div className="space-y-2"><RequiredLabel htmlFor="commerce-ad-amount">{t('commerceOperations.data.amount')}</RequiredLabel><Input id="commerce-ad-amount" inputMode="decimal" value={amount} placeholder="0" onChange={(event) => setAmount(amountInput(event.target.value))} disabled={saving} />{attempted && parseAmount(amount) === null ? <p className="text-xs text-destructive">{t('commerceOperations.validation.amountRequired')}</p> : null}</div>
              <CurrencySelector value={currency} onChange={setCurrency} label={`${t('commerceOperations.fields.currency')} *`} iqdDisplayPreference={iqdPreference} disabled={saving} />
            </> : null}
            {kind === 'dm_funnel' ? <>
              <div className="space-y-2"><RequiredLabel>{t('commerceOperations.fields.platform')}</RequiredLabel><PlatformSelect value={platform} onChange={setPlatform} disabled={saving} t={t} /></div>
              <div className="space-y-2"><RequiredLabel>{t('commerceOperations.data.language')}</RequiredLabel><Select value={language} onValueChange={setLanguage} disabled={saving}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ku">{t('commerceOperations.languages.ku')}</SelectItem><SelectItem value="ar">{t('commerceOperations.languages.ar')}</SelectItem><SelectItem value="en">{t('commerceOperations.languages.en')}</SelectItem></SelectContent></Select></div>
              {[['reach', reach, setReach], ['dms', dms, setDms], ['completedSales', completedSales, setCompletedSales], ['adSpend', amount, setAmount]].map(([field, value, setValue]) => <div className="space-y-2" key={String(field)}><RequiredLabel htmlFor={`commerce-${String(field)}`}>{t(`commerceOperations.data.${String(field)}`)}</RequiredLabel><Input id={`commerce-${String(field)}`} inputMode="decimal" value={String(value)} placeholder="0" onChange={(event) => (setValue as (next: string) => void)(amountInput(event.target.value, field !== 'adSpend'))} disabled={saving} />{attempted && parseAmount(String(value)) === null ? <p className="text-xs text-destructive">{t('commerceOperations.validation.amountRequired')}</p> : null}</div>)}
              <CurrencySelector value={currency} onChange={setCurrency} label={`${t('commerceOperations.fields.currency')} *`} iqdDisplayPreference={iqdPreference} disabled={saving} />
            </> : null}
            {kind === 'city_market' ? <>
              <div className="space-y-2 sm:col-span-2"><RequiredLabel htmlFor="commerce-market-city">{t('commerceOperations.fields.city')}</RequiredLabel><Input id="commerce-market-city" value={city} onChange={(event) => setCity(event.target.value)} disabled={saving} />{attempted && !city.trim() ? <p className="text-xs text-destructive">{t('commerceOperations.validation.cityRequired')}</p> : null}</div>
              <div className="space-y-2"><RequiredLabel htmlFor="commerce-pools">{t('commerceOperations.data.poolCount')}</RequiredLabel><Input id="commerce-pools" inputMode="numeric" value={poolCount} placeholder="0" onChange={(event) => setPoolCount(amountInput(event.target.value, true))} disabled={saving} /></div>
              <div className="space-y-2"><RequiredLabel htmlFor="commerce-swimmers">{t('commerceOperations.data.swimmerCount')}</RequiredLabel><Input id="commerce-swimmers" inputMode="numeric" value={swimmerCount} placeholder="0" onChange={(event) => setSwimmerCount(amountInput(event.target.value, true))} disabled={saving} /></div>
            </> : null}
            {kind === 'competitor' ? <>
              <div className="space-y-2 sm:col-span-2"><RequiredLabel htmlFor="commerce-competitor-name">{t('commerceOperations.data.competitorName')}</RequiredLabel><Input id="commerce-competitor-name" value={competitorName} onChange={(event) => setCompetitorName(event.target.value)} disabled={saving} />{attempted && !competitorName.trim() ? <p className="text-xs text-destructive">{t('commerceOperations.validation.nameRequired')}</p> : null}</div>
              <div className="space-y-2"><RequiredLabel>{t('commerceOperations.data.competitorKind')}</RequiredLabel><Select value={competitorKind} onValueChange={(value) => setCompetitorKind(value as typeof competitorKind)} disabled={saving}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="online">{t('commerceOperations.data.competitorKinds.online')}</SelectItem><SelectItem value="physical">{t('commerceOperations.data.competitorKinds.physical')}</SelectItem></SelectContent></Select></div>
              {competitorKind === 'online' ? <div className="space-y-2"><RequiredLabel>{t('commerceOperations.fields.platform')}</RequiredLabel><PlatformSelect value={platform} onChange={setPlatform} disabled={saving} t={t} /></div> : null}
              <div className="space-y-2"><Label htmlFor="commerce-followers">{t('commerceOperations.data.followers')}</Label><Input id="commerce-followers" inputMode="numeric" value={followers} placeholder="0" onChange={(event) => setFollowers(amountInput(event.target.value, true))} disabled={saving} /></div>
              <div className="space-y-2"><RequiredLabel>{t('commerceOperations.data.pricePosition')}</RequiredLabel><Select value={pricePosition} onValueChange={setPricePosition} disabled={saving}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">{t('commerceOperations.data.pricePositions.low')}</SelectItem><SelectItem value="mid">{t('commerceOperations.data.pricePositions.mid')}</SelectItem><SelectItem value="high">{t('commerceOperations.data.pricePositions.high')}</SelectItem></SelectContent></Select></div>
            </> : null}
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="commerce-record-notes">{t(kind === 'competitor' ? 'commerceOperations.data.brandingNotes' : 'commerceOperations.fields.notes')}</Label><Textarea id="commerce-record-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={saving} /></div>
          </div>
          {attempted && !numbersValid ? <p className="mt-3 text-xs text-destructive">{t('commerceOperations.validation.amountRequired')}</p> : null}
        </AppDialogBody>
        <AppDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>{t('common.cancel')}</Button><Button type="button" disabled={!valid} onClick={() => void save()}>{saving ? t('commerceOperations.actions.saving') : t(record ? 'commerceOperations.actions.updateRecord' : 'commerceOperations.actions.saveRecord')}</Button></AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}

function PlatformSelect({ value, onChange, disabled, t }: { value: (typeof PLATFORM_OPTIONS)[number]; onChange: (value: (typeof PLATFORM_OPTIONS)[number]) => void; disabled: boolean; t: (key: string) => string }) {
  return <Select value={value} onValueChange={(next) => onChange(next as typeof value)} disabled={disabled}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{PLATFORM_OPTIONS.map((option) => <SelectItem key={option} value={option}>{t(`commerceOperations.platforms.${option}`)}</SelectItem>)}</SelectContent></Select>
}

function CoachProfileDialog({ open, onOpenChange, workspaceId, userId, existing, canManage, onSaved, t }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  userId?: string
  existing: CommerceOperationRecord[]
  canManage: boolean
  onSaved: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const { toast } = useToast()
  const [coach, setCoach] = useState<BusinessPartner | null>(null)
  const [coachName, setCoachName] = useState('')
  const [city, setCity] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const alreadyLinked = (partnerId?: string | null) => Boolean(partnerId && existing.some((record) => record.relatedPartnerId === partnerId))

  useEffect(() => {
    if (!open) return
    setCoach(null); setCoachName(''); setCity(''); setPhone(''); setNotes(''); setSaving(false); setAttempted(false)
  }, [open])
  const close = (next: boolean) => { if (saving && !next) return; onOpenChange(next) }
  const valid = Boolean(canManage && workspaceId && coach && !alreadyLinked(coach.id) && !saving)

  async function save() {
    setAttempted(true)
    if (!valid || !workspaceId || !coach) return
    setSaving(true)
    try {
      await createCommerceOperationRecord(workspaceId, {
        recordType: 'coach_profile', recordDate: new Date().toISOString(), title: coach.partnerName,
        relatedPartnerId: coach.id, createdBy: userId ?? null,
        payload: { agentId: coach.agentFacetId || null, partnerId: coach.id, name: coach.partnerName, phone: phone.trim() || coach.phone || null, city: city.trim() || coach.city || null, notes: notes.trim() || null },
      })
      toast({ title: t('commerceOperations.toast.coachSaved') })
      onSaved(); close(false)
    } catch {
      toast({ title: t('commerceOperations.toast.coachFailed'), description: t('commerceOperations.toast.tryAgain'), variant: 'destructive' })
    } finally { setSaving(false) }
  }

  return (
    <AppDialog open={open} onOpenChange={close}>
      <AppDialogContent className="max-w-xl" onPointerDownOutside={(event) => saving && event.preventDefault()} onEscapeKeyDown={(event) => saving && event.preventDefault()}>
        <AppDialogHeader><AppDialogTitle className="flex items-center gap-2"><UsersRound className="h-5 w-5 text-primary" />{t('commerceOperations.coaches.addTitle')}</AppDialogTitle></AppDialogHeader>
        <AppDialogBody><div className="space-y-4">
          <div className="space-y-2"><RequiredLabel>{t('commerceOperations.coaches.coach')}</RequiredLabel><div className="flex gap-2"><PartnerAutocompleteInput value={coachName} onChange={(value) => { setCoachName(value); setCoach(null) }} onSelectPartner={(partner) => { setCoach(partner); setCoachName(partner.partnerName); setPhone(partner.phone || ''); setCity(partner.city || '') }} workspaceId={workspaceId || ''} roles={['agent']} includeAgentRoles placeholder={t('commerceOperations.coaches.chooseAgent')} disabled={saving} className="min-w-0 flex-1" /><Button type="button" size="icon" variant="outline" aria-label={t('commerceOperations.actions.unlinkCoach')} disabled={!coach || saving} onClick={() => { setCoach(null); setCoachName(''); setPhone(''); setCity('') }}><X className="h-4 w-4" /></Button></div>{coach ? <Badge className="gap-1"><Check className="h-3 w-3" />{t('commerceOperations.labels.linked')}</Badge> : null}{attempted && !coach ? <p className="text-xs text-destructive">{t('commerceOperations.validation.coachRequired')}</p> : null}{coach && alreadyLinked(coach.id) ? <p className="text-xs text-destructive">{t('commerceOperations.validation.coachExists')}</p> : null}</div>
          <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="commerce-coach-phone">{t('commerceOperations.fields.phone')}</Label><Input id="commerce-coach-phone" value={phone} onChange={(event) => setPhone(event.target.value)} disabled={saving} /></div><div className="space-y-2"><Label htmlFor="commerce-coach-city">{t('commerceOperations.fields.city')}</Label><Input id="commerce-coach-city" value={city} onChange={(event) => setCity(event.target.value)} disabled={saving} /></div><div className="space-y-2 sm:col-span-2"><Label htmlFor="commerce-coach-notes">{t('commerceOperations.fields.notes')}</Label><Textarea id="commerce-coach-notes" value={notes} onChange={(event) => setNotes(event.target.value)} disabled={saving} /></div></div>
          <p className="text-xs text-muted-foreground">{t('commerceOperations.coaches.commissionSetupHint')}</p>
        </div></AppDialogBody>
        <AppDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => close(false)}>{t('common.cancel')}</Button><Button type="button" disabled={!valid} onClick={() => void save()}>{saving ? t('commerceOperations.actions.saving') : t('commerceOperations.actions.saveCoach')}</Button></AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}

