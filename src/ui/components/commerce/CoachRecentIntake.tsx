import { Activity, ArrowUpRight, ClipboardList, Loader2, TrendingUp, Wallet, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'

import { useDateRange } from '@/context/DateRangeContext'
import { usePaginationBounds, usePaginationState } from '@/hooks/usePaginationState'
import { useCoachRecentIntake } from '@/local-db/coachData'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { formatCurrency } from '@/lib/utils'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { AppPagination, Badge, Button, Card, CardContent, CardHeader, CardTitle, DateRangeFilters } from '@/ui/components'
import { OrderStatusBadge } from '@/ui/components/orders/OrderStatusBadge'

const PAGE_SIZE_OPTIONS = [5, 10, 20]
const PAGE_SIZE_STORAGE_KEY = 'coach_data_recent_intake_page_size'

function readPageSize() {
  if (typeof window === 'undefined') return 10
  const stored = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY))
  return PAGE_SIZE_OPTIONS.includes(stored) ? stored : 10
}

function savePageSize(pageSize: number) {
  if (typeof window !== 'undefined' && PAGE_SIZE_OPTIONS.includes(pageSize)) {
    window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(pageSize))
  }
}

export function CoachRecentIntake({
  workspaceId,
  viewerId,
  coachUserId,
  canOpenOrder,
}: {
  workspaceId: string
  viewerId: string
  coachUserId: string
  canOpenOrder: boolean
}) {
  const { t, i18n } = useTranslation()
  const [, navigate] = useLocation()
  const { features } = useWorkspace()
  const { dateRange, customDates, dateFilterDayBoundary } = useDateRange()
  const dateBounds = getDateRangeBounds(dateRange, customDates, new Date(), dateFilterDayBoundary)
  const createdFrom = dateBounds.start?.toISOString()
  const createdBefore = dateBounds.end?.toISOString()
  const pagination = usePaginationState({
    initialPageSize: readPageSize(),
    resetOn: [workspaceId, coachUserId, createdFrom, createdBefore],
    onPageSizeChange: savePageSize,
  })
  const page = useCoachRecentIntake({
    workspaceId,
    viewerId,
    coachUserId,
    page: pagination.currentPage,
    pageSize: pagination.pageSize,
    createdFrom,
    createdBefore,
    enabled: Boolean(workspaceId && viewerId && coachUserId),
  })
  const bounds = usePaginationBounds({
    currentPage: pagination.currentPage,
    setCurrentPage: pagination.setCurrentPage,
    totalCount: page.data?.totalCount,
    pageSize: pagination.pageSize,
    isLoading: page.isLoading,
    error: page.error,
  })
  const totals = page.data?.totalsByCurrency ?? []
  const orderValue = totals.length
    ? totals.map(({ currency, total }) => formatCurrency(total, currency, features.iqd_display_preference)).join(' · ')
    : formatCurrency(0, 'iqd', features.iqd_display_preference)

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard
          title={t('commerceOperations.metrics.intakeOrders')}
          value={(page.data?.totalCount ?? 0).toLocaleString(i18n.resolvedLanguage || i18n.language)}
          icon={ClipboardList}
        />
        <MetricCard
          title={t('commerceOperations.metrics.waitingCollection')}
          value={(page.data?.unpaidCount ?? 0).toLocaleString(i18n.resolvedLanguage || i18n.language)}
          icon={Wallet}
        />
        <MetricCard title={t('commerceOperations.metrics.orderValue')} value={orderValue} icon={TrendingUp} />
      </div>

      <DateRangeFilters label={t('commerceOperations.filters.orderDate')} />

      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            {t('commerceOperations.orders.recent')}
          </CardTitle>
          <Badge variant="secondary">{(page.data?.totalCount ?? 0).toLocaleString(i18n.resolvedLanguage || i18n.language)}</Badge>
          <AppPagination
            currentPage={bounds.currentPage}
            pageCount={bounds.pageCount}
            totalCount={page.data?.totalCount ?? 0}
            pageSize={pagination.pageSize}
            onPageChange={pagination.setCurrentPage}
            onPageSizeChange={pagination.setPageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        </CardHeader>
        <CardContent>
          {page.isLoading ? (
            <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t('commerceOperations.coachData.loading')}
            </div>
          ) : page.error ? (
            <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              {t('commerceOperations.coachData.loadFailed')}
            </p>
          ) : page.data?.items.length ? (
            <div className="space-y-3">
              {page.data.items.map((order) => (
                <div key={order.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{order.orderNumber}</p>
                      <OrderStatusBadge status={order.status} label={t(`orders.status.${order.status}`, { defaultValue: order.status })} />
                      <Badge variant={order.isPaid ? 'default' : 'secondary'}>
                        {t(order.isPaid ? 'commerceOperations.orders.paid' : 'commerceOperations.orders.unpaid')}
                      </Badge>
                    </div>
                    {order.customerName ? <p className="truncate text-sm text-muted-foreground">{order.customerName}</p> : null}
                    {order.createdAt ? (
                      <p className="text-xs text-muted-foreground">
                        {new Date(order.createdAt).toLocaleString(i18n.resolvedLanguage || i18n.language)}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <p className="text-end font-bold">{formatCurrency(order.total, order.currency, features.iqd_display_preference)}</p>
                    {canOpenOrder ? (
                      <Button variant="outline" size="sm" className="gap-2" onClick={() => navigate(`/orders/${order.id}`)}>
                        {t('commerceOperations.actions.openOrder')}
                        <ArrowUpRight className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 text-center">
              <ClipboardList className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">{t('commerceOperations.coachData.recentIntakeEmptyTitle')}</p>
              <p className="max-w-xl text-sm text-muted-foreground">{t('commerceOperations.coachData.recentIntakeEmptyBody')}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MetricCard({ title, value, icon: Icon }: { title: string; value: string; icon: LucideIcon }) {
  return (
    <Card>
      <CardContent className="flex min-w-0 items-start gap-3 p-4 sm:p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-1 break-words text-lg font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}
