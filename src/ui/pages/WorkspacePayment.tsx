import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  Database,
  FileClock,
  Gauge,
  HardDrive,
  LockKeyhole,
  RefreshCw,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  WalletCards,
} from 'lucide-react'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { isDateInDateRange } from '@/lib/dateRangeFilters'
import {
  getWorkspaceBillingMode,
  getWorkspacePaymentAlertKind,
  getWorkspacePaymentExpiryDate,
  formatWorkspacePaymentDecimal,
  openWorkspacePaymentDialog,
  openWorkspacePaymentStatusDialog,
  WORKSPACE_PAYMENT_UPDATED_EVENT,
  type WorkspacePaymentTransaction,
} from '@/lib/workspacePayments'
import { buildWorkspaceUsageInsights } from '@/lib/workspaceUsageHistory'
import {
  useWorkspacePaymentOverview,
  WORKSPACE_PAYMENT_FRESHNESS_TABLES,
} from '@/local-db/workspacePayment'
import { useWorkspace } from '@/workspace'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { Button } from '@/ui/components/button'
import { WorkspacePaygLimitDialog } from '@/ui/components/WorkspacePaygLimitDialog'

function formatBytes(value: number | null | undefined, locale: string) {
  const bytes = Number(value ?? 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)))
  const amount = bytes / (1000 ** unitIndex)
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2,
  }).format(amount)} ${units[unitIndex]}`
}

function formatDate(value: string | null | undefined, locale: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

function formatTimestamp(value: string | null | undefined, locale: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function MetricCard({ icon, label, value, detail, tone = 'primary' }: {
  icon: ReactNode
  label: string
  value: string
  detail?: string
  tone?: 'primary' | 'amber' | 'sky' | 'emerald' | 'violet'
}) {
  const toneClassName = {
    primary: 'bg-primary/10 text-primary',
    amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    sky: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    violet: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  }[tone]

  return (
    <article className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted-foreground">{label}</p>
          <p className="mt-2 break-words text-xl font-black tabular-nums tracking-tight text-foreground">{value}</p>
        </div>
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${toneClassName}`}>
          {icon}
        </span>
      </div>
      {detail ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p> : null}
    </article>
  )
}

function SectionHeading({ icon, title, action }: {
  icon: ReactNode
  title: string
  action?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-base font-bold text-foreground">
        <span className="text-primary">{icon}</span>
        {title}
      </h2>
      {action}
    </div>
  )
}

function UsageMetric({ label, used, limit, percent, icon }: {
  label: string
  used: string
  limit: string
  percent: number | null
  icon: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="rounded-xl border border-border/60 bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <span className="text-muted-foreground">{icon}</span>
          <span className="truncate">{label}</span>
        </p>
        {percent !== null ? (
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-bold tabular-nums text-primary">
            {Math.round(percent)}%
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-sm font-bold tabular-nums text-foreground">
        {t('workspaceUsage.usedOfLimit', { used, limit })}
      </p>
      {percent !== null ? (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted ring-1 ring-border/50">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

function getTransactionStatusClass(status: WorkspacePaymentTransaction['status']) {
  switch (status) {
    case 'approved': return 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
    case 'rejected': return 'bg-rose-500/10 text-rose-800 dark:text-rose-200'
    case 'pending': return 'bg-amber-500/10 text-amber-800 dark:text-amber-200'
    case 'expired': return 'bg-muted text-muted-foreground'
    default: return 'bg-muted text-muted-foreground'
  }
}

export function WorkspacePayment() {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { dateRange, customDates, dateFilterDayBoundary } = useDateRange()
  const {
    features,
    isDemoMode,
    isLocked,
    workspaceName,
    refreshPaymentSummary,
    refreshPaygSummary,
  } = useWorkspace()
  const [paygLimitDialogOpen, setPaygLimitDialogOpen] = useState(false)
  const workspaceId = user?.workspaceId ?? ''
  const query = useWorkspacePaymentOverview({
    workspaceId,
    userId: user?.id ?? '',
    role: user?.role ?? '',
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const refreshWorkspaceContext = () => {
      void Promise.allSettled([refreshPaymentSummary(), refreshPaygSummary()])
    }
    window.addEventListener(WORKSPACE_PAYMENT_UPDATED_EVENT, refreshWorkspaceContext)
    return () => window.removeEventListener(WORKSPACE_PAYMENT_UPDATED_EVENT, refreshWorkspaceContext)
  }, [refreshPaymentSummary, refreshPaygSummary])

  const refreshBillingOverview = async () => {
    await Promise.allSettled([
      query.refetch(),
      refreshPaymentSummary(),
      refreshPaygSummary(),
    ])
  }
  const locale = i18n.resolvedLanguage || i18n.language || 'en'
  const overview = query.data
  const summary = overview?.paymentSummary
  const configuration = summary?.configuration
  const payg = overview?.paygSummary
  const usage = overview?.usageStatus
  const usageInsights = usage?.has_limits
    ? buildWorkspaceUsageInsights(usage, overview?.usageHistory ?? null)
    : null
  const billingMode = summary
    ? getWorkspaceBillingMode(summary, features.has_usage_limits, Boolean(payg?.enabled))
    : features.billing_mode ?? 'subscription'
  const renewalDueAt = summary
    ? getWorkspacePaymentExpiryDate({ renewalDueAt: features.renewal_due_at, summary })
    : features.renewal_due_at
  const paymentAlert = getWorkspacePaymentAlertKind(summary)
  const paymentNeedsAttention = Boolean(paymentAlert || payg?.paygLimitState?.locked)
  const isAccessLocked = Boolean(isLocked || paymentNeedsAttention)
  const currencyLabel = features.iqd_display_preference === 'د.ع' ? 'د.ع' : 'IQD'
  const pendingTransaction = summary?.pendingTransaction ?? null
  const canSubmitPayment = Boolean(
    !summary?.hasWorkspacePendingTransaction
      && !pendingTransaction
      && (summary?.eligibility.paymentEnabled
        || (payg?.enabled && payg.canSubmitPayment && payg.cycleStatus === 'awaiting_payment'))
  )
  const transactions = useMemo(() => {
    const uniqueTransactions = new Map<string, WorkspacePaymentTransaction>()
    for (const transaction of [...(summary?.transactions ?? []), ...(payg?.paymentHistory ?? [])]) {
      uniqueTransactions.set(transaction.id, transaction)
    }
    return [...uniqueTransactions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }, [payg?.paymentHistory, summary?.transactions])
  const filteredTransactions = useMemo(
    () => transactions.filter((transaction) => isDateInDateRange(transaction.createdAt, dateRange, customDates)),
    [customDates, dateFilterDayBoundary, dateRange, transactions],
  )
  const filteredPaygCycles = useMemo(
    () => (payg?.history ?? []).filter((cycle) => isDateInDateRange(cycle.periodStartedAt, dateRange, customDates)),
    [customDates, dateFilterDayBoundary, dateRange, payg?.history],
  )
  const usageLimit = usage?.monthly_data_transfer_limit_bytes ?? null
  const chargedUsageBytes = Number(usage?.charged_usage_bytes ?? 0)
  const usagePercent = usageLimit === null
    ? null
    : usageLimit <= 0
      ? chargedUsageBytes > 0 ? 100 : 0
      : Math.min(100, Math.max(0, chargedUsageBytes / usageLimit * 100))
  const storageLimit = usage?.storage_unit_limit ?? null
  const storageUnits = Number(usage?.storage_units ?? 0)
  const storagePercent = storageLimit === null
    ? null
    : storageLimit <= 0
      ? storageUnits > 0 ? 100 : 0
      : Math.min(100, Math.max(0, storageUnits / storageLimit * 100))

  const billingAmount = payg?.enabled
    ? `${formatWorkspacePaymentDecimal(payg.amountIqd, locale, 0)} ${currencyLabel}`
    : configuration?.billingInterval === 'prepaid_term'
      ? `${formatWorkspacePaymentDecimal(configuration.prepaidAmount, locale, 0)} ${currencyLabel}`
      : configuration
        ? `${formatWorkspacePaymentDecimal(configuration.subscriptionAmount, locale, 0)} ${currencyLabel}`
        : '—'
  const billingAmountLabel = payg?.enabled
    ? payg.cycleStatus === 'awaiting_payment'
      ? t('workspaceUsage.payg.amountDue')
      : t('workspaceUsage.payg.accruedCharge')
    : configuration?.billingInterval === 'prepaid_term'
      ? t('workspacePayments.prepaidTerm.amountPaid')
      : t('workspacePaymentPage.subscriptionAmount')
  const allowanceValue = configuration
    ? configuration.billingInterval === 'prepaid_term'
      ? `${formatWorkspacePaymentDecimal(
        configuration.prepaidAllowanceMode === 'term_pool'
          ? configuration.termAllowanceGb
          : configuration.monthlyAllowanceGb,
        locale,
        2,
      )} GB`
      : configuration.usageEnabled
        ? `${formatWorkspacePaymentDecimal(configuration.gbPerPayment, locale, 2)} GB`
        : `${formatWorkspacePaymentDecimal(configuration.monthlyAllowanceGb, locale, 2)} GB`
    : '—'

  return (
    <div className="min-h-full w-full space-y-6 p-4 pb-10 sm:p-6 lg:p-8">
      <header className="flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <WalletCards className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-black tracking-tight text-foreground sm:text-3xl">
              {t('workspacePaymentPage.title')}
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              {t('workspacePaymentPage.subtitle', { workspace: summary?.workspaceName || workspaceName || '' })}
              <ModulePageFreshness
                className="ms-2"
                tableNames={WORKSPACE_PAYMENT_FRESHNESS_TABLES}
                source="supabase"
              />
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refreshBillingOverview()}
          disabled={query.isFetching || isDemoMode}
          className="shrink-0"
        >
          <RefreshCw className={`me-2 h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
          {t('common.refresh', { defaultValue: 'Refresh' })}
        </Button>
      </header>

      {isDemoMode ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{t('workspacePaymentPage.demoUnavailable')}</p>
        </div>
      ) : null}

      {!overview && query.isLoading ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-border/60 bg-card/70 text-muted-foreground">
          <RefreshCw className="h-7 w-7 animate-spin text-primary" />
          <p className="text-sm font-medium">{t('workspacePaymentPage.loading')}</p>
        </div>
      ) : null}

      {!overview && query.isError ? (
        <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/[0.035] p-6 text-center">
          <AlertTriangle className="h-8 w-8 text-destructive" />
          <p className="max-w-md text-sm text-muted-foreground">{t('workspacePaymentPage.loadError')}</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={`me-2 h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
            {t('workspacePaymentPage.retry')}
          </Button>
        </div>
      ) : null}

      {overview && summary ? (
        <>
          {query.isError ? (
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] p-3 text-sm text-amber-900 dark:text-amber-100">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('workspacePaymentPage.refreshError')}
            </div>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={isAccessLocked ? <LockKeyhole className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
              label={t('workspacePaymentPage.accountStatus')}
              value={isAccessLocked ? t('workspacePayments.accessLocked') : t('workspacePayments.active')}
              detail={paymentNeedsAttention
                ? t('workspacePaymentPage.actionNeeded')
                : isAccessLocked
                  ? t('workspacePaymentPage.accessRestricted')
                  : t('workspacePaymentPage.accountStatusDetail')}
              tone={isAccessLocked ? 'amber' : 'emerald'}
            />
            <MetricCard
              icon={<CreditCard className="h-5 w-5" />}
              label={t('workspacePayments.billingModeLabel')}
              value={t(`workspacePayments.billingModes.${billingMode}`)}
              detail={summary.billingWorkspaceId !== workspaceId
                ? t('workspacePaymentPage.inheritedBilling')
                : t('workspacePaymentPage.workspaceBilling')}
              tone="sky"
            />
            <MetricCard
              icon={<CircleDollarSign className="h-5 w-5" />}
              label={billingAmountLabel}
              value={billingAmount}
              detail={payg?.enabled
                ? t(`workspaceUsage.payg.statuses.${payg.cycleStatus ?? 'open'}`)
                : configuration?.billingInterval === 'prepaid_term'
                  ? t('workspacePaymentPage.prepaidTermAmountDetail')
                  : t('workspacePaymentPage.subscriptionAmountDetail')}
              tone="amber"
            />
            <MetricCard
              icon={<CalendarClock className="h-5 w-5" />}
              label={t('workspacePaymentPage.nextBillingDate')}
              value={renewalDueAt ? formatDate(renewalDueAt, locale) : t('workspacePayments.lifetime')}
              detail={t('workspacePaymentPage.nextBillingDateDetail')}
              tone="violet"
            />
          </section>

          {pendingTransaction ? (
            <section className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div className="flex items-start gap-3">
                <FileClock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
                <div>
                  <p className="font-bold text-foreground">{t('workspacePaymentPage.pendingPayment')}</p>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {t('workspacePaymentPage.pendingPaymentDetail', {
                      amount: `${formatWorkspacePaymentDecimal(pendingTransaction.amount, locale, 0)} ${pendingTransaction.currency}`,
                      date: formatTimestamp(pendingTransaction.createdAt, locale),
                    })}
                  </p>
                </div>
              </div>
              <Button type="button" variant="outline" onClick={openWorkspacePaymentStatusDialog}>
                <ReceiptText className="me-2 h-4 w-4" />
                {t('workspacePayments.viewPaymentStatus')}
              </Button>
            </section>
          ) : null}

          <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
            <SectionHeading icon={<CreditCard className="h-5 w-5" />} title={t('workspacePaymentPage.billingOverview')} />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                icon={<WalletCards className="h-4 w-4" />}
                label={t('workspacePaymentPage.allowance')}
                value={allowanceValue}
                detail={configuration?.prepaidAllowanceMode === 'term_pool'
                  ? t('workspacePayments.prepaidTerm.termPoolNoMonthlyReset')
                  : configuration?.billingInterval === 'prepaid_term'
                    ? t('workspacePayments.prepaidTerm.noRollover')
                    : t('workspacePaymentPage.allowanceDetail')}
              />
              <MetricCard
                icon={<CalendarDays className="h-4 w-4" />}
                label={t('workspacePaymentPage.billingCycle')}
                value={configuration?.billingInterval === 'prepaid_term'
                  ? t('workspacePayments.billingModes.prepaidTerm')
                  : t('workspacePaymentPage.monthlyCycle')}
                detail={configuration?.billingInterval === 'prepaid_term'
                  ? t('workspacePayments.prepaidTerm.startedAt') + ': ' + formatDate(configuration.prepaidTermStartedAt, locale)
                  : t('workspacePaymentPage.monthlyCycleDetail')}
                tone="sky"
              />
              <MetricCard
                icon={<Database className="h-4 w-4" />}
                label={t('workspacePaymentPage.rollover')}
                value={configuration?.rolloverEnabled ? t('workspacePaymentPage.enabled') : t('workspacePaymentPage.disabled')}
                detail={t('workspacePaymentPage.rolloverDetail')}
                tone="violet"
              />
              <MetricCard
                icon={<CheckCircle2 className="h-4 w-4" />}
                label={t('workspacePaymentPage.paymentSubmissions')}
                value={summary.eligibility.paymentEnabled
                  ? t('workspacePaymentPage.enabled')
                  : t('workspacePaymentPage.disabled')}
                detail={summary.eligibility.paymentEnabled
                  ? t('workspacePaymentPage.paymentEnabledDetail')
                  : t('workspacePaymentPage.paymentDisabledDetail')}
                tone={summary.eligibility.paymentEnabled ? 'emerald' : 'amber'}
              />
            </div>
            {summary.pendingExtraDays ? (
              <p className="mt-4 flex items-start gap-2 rounded-xl bg-primary/[0.06] p-3 text-sm text-foreground">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                {t('workspacePaymentPage.extraDaysActive', { count: summary.pendingExtraDays.extraDays })}
              </p>
            ) : null}
            {configuration?.billingInterval === 'prepaid_term' ? (
              <dl className="mt-4 grid gap-3 rounded-xl border border-border/60 bg-background p-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('workspacePayments.prepaidTerm.monthlyPrice')}</dt>
                  <dd className="mt-1 font-bold tabular-nums">{formatWorkspacePaymentDecimal(configuration.monthlyListPrice, locale, 0)} {currencyLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('workspacePayments.prepaidTerm.cycles')}</dt>
                  <dd className="mt-1 font-bold tabular-nums">{configuration.prepaidCycles ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('workspacePayments.prepaidTerm.startedAt')}</dt>
                  <dd className="mt-1 font-bold">{formatDate(configuration.prepaidTermStartedAt, locale)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('workspacePayments.prepaidTerm.paidThrough')}</dt>
                  <dd className="mt-1 font-bold">{formatDate(configuration.renewalDueAt, locale)}</dd>
                </div>
              </dl>
            ) : null}
            {payg?.pendingBillingTermination ? (
              <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] p-3 text-sm text-amber-900 dark:text-amber-100">
                {t('workspacePayments.pendingBillingTerminationDescription')}
              </p>
            ) : payg?.pendingBillingMode ? (
              <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] p-3 text-sm text-amber-900 dark:text-amber-100">
                {t('workspacePayments.pendingBillingChangeDescription', {
                  mode: t(payg.pendingBillingMode === 'prepaid_usage'
                    ? 'workspacePayments.billingModes.usage'
                    : 'workspacePayments.billingModes.subscription'),
                })}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {canSubmitPayment ? (
                <Button type="button" onClick={openWorkspacePaymentDialog}>
                  <CircleDollarSign className="me-2 h-4 w-4" />
                  {payg?.enabled
                    ? t('workspaceUsage.payg.submitPayment')
                    : billingMode === 'usage'
                      ? t('workspacePayments.renewUsageCredit')
                      : t('workspacePayments.renewSubscription')}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={openWorkspacePaymentStatusDialog}>
                <ReceiptText className="me-2 h-4 w-4" />
                {t('workspacePayments.viewPaymentStatus')}
              </Button>
              {payg?.enabled ? (
                <Button type="button" variant="outline" onClick={() => setPaygLimitDialogOpen(true)}>
                  <SlidersHorizontal className="me-2 h-4 w-4" />
                  {t('workspaceUsage.payg.limit.openButton')}
                </Button>
              ) : null}
            </div>
          </section>

          <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
            <SectionHeading icon={<Activity className="h-5 w-5" />} title={t('workspacePaymentPage.usageOverview')} />
            {usage?.has_limits ? (
              <>
                <div className="grid gap-3 lg:grid-cols-2">
                  <UsageMetric
                    icon={<HardDrive className="h-4 w-4" />}
                    label={t('workspaceUsage.storage')}
                    used={new Intl.NumberFormat(locale).format(usage.storage_units)}
                    limit={usage.storage_unit_limit === null
                      ? t('workspaceUsage.unlimited')
                      : new Intl.NumberFormat(locale).format(usage.storage_unit_limit)}
                    percent={storagePercent}
                  />
                  <UsageMetric
                    icon={<Activity className="h-4 w-4" />}
                    label={t('workspaceUsage.chargedUsage')}
                    used={formatBytes(usage.charged_usage_bytes, locale)}
                    limit={usageLimit === null ? t('workspaceUsage.unlimited') : formatBytes(usageLimit, locale)}
                    percent={usagePercent}
                  />
                </div>
                {usageInsights ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <MetricCard
                      icon={<Activity className="h-4 w-4" />}
                      label={t('workspaceUsage.averageDailyCharged')}
                      value={formatBytes(usageInsights.averageDailyChargedUsageBytes, locale)}
                      detail={t('workspaceUsage.elapsedDaysValue', { count: usageInsights.daysElapsed })}
                      tone="sky"
                    />
                    <MetricCard
                      icon={<Gauge className="h-4 w-4" />}
                      label={t('workspaceUsage.projectedChargedUsage')}
                      value={formatBytes(usageInsights.projectedChargedUsageBytes, locale)}
                      detail={t('workspaceUsage.projectionHint')}
                      tone="violet"
                    />
                    <MetricCard
                      icon={<Database className="h-4 w-4" />}
                      label={t('workspacePaymentPage.remainingUsage')}
                      value={usageInsights.remainingChargedUsageBytes === null
                        ? t('workspaceUsage.unlimited')
                        : formatBytes(usageInsights.remainingChargedUsageBytes, locale)}
                      detail={t('workspacePaymentPage.remainingUsageDetail')}
                      tone="emerald"
                    />
                    <MetricCard
                      icon={<CalendarDays className="h-4 w-4" />}
                      label={t('workspaceUsage.periodDetails')}
                      value={formatDate(usageInsights.nextPeriodStart, locale)}
                      detail={t('workspaceUsage.nextReset')}
                      tone="amber"
                    />
                  </div>
                ) : null}
                {usageInsights?.chartData.length ? (
                  <div className="mt-4 rounded-xl border border-border/60 bg-background p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                        <Activity className="h-4 w-4 text-primary" />
                        {t('workspaceUsage.consumptionTitle')}
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {t('workspaceUsage.lastUpdated')}: {formatTimestamp(usageInsights.lastUpdatedAt, locale)}
                      </span>
                    </div>
                    <div
                      className="flex h-24 items-end gap-1"
                      role="img"
                      aria-label={t('workspacePaymentPage.usageHistoryAccessible')}
                    >
                      {usageInsights.chartData.map((point) => {
                        const peak = Math.max(1, usageInsights.peakDailyChargedUsageBytes)
                        const height = Math.max(3, point.chargedUsageBytes / peak * 100)
                        return (
                          <div
                            key={point.date}
                            className="min-w-0 flex-1 rounded-t-sm bg-amber-500/80"
                            style={{ height: `${height}%` }}
                            title={`${formatDate(point.date, locale)} · ${formatBytes(point.chargedUsageBytes, locale)}`}
                          />
                        )
                      })}
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                      <span>{formatDate(usageInsights.chartData[0]?.date, locale)}</span>
                      <span>{formatDate(usageInsights.chartData.at(-1)?.date, locale)}</span>
                    </div>
                  </div>
                ) : null}
                <dl className="mt-4 grid gap-3 rounded-xl bg-muted/25 p-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('workspaceUsage.periodStart')}</dt>
                    <dd className="mt-1 font-semibold">{formatDate(usage.transfer_period_start, locale)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('workspaceUsage.localTrackingStarted')}</dt>
                    <dd className="mt-1 font-semibold">{formatTimestamp(usageInsights?.trackedFrom, locale)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('workspaceUsage.lastUpdated')}</dt>
                    <dd className="mt-1 font-semibold">{formatTimestamp(usageInsights?.lastUpdatedAt, locale)}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="rounded-xl bg-muted/35 p-4 text-sm text-muted-foreground">
                {t('workspacePaymentPage.noUsageLimits')}
              </p>
            )}
          </section>

          {payg?.enabled ? (
            <section className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.04] p-4 shadow-sm sm:p-5">
              <SectionHeading
                icon={<CircleDollarSign className="h-5 w-5" />}
                title={t('workspaceUsage.payg.modalTitle')}
                action={payg.paygLimitState?.hasLimit && payg.paygLimitState.limit ? (
                  <span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-100">
                    {t('workspacePaymentPage.paygLimit', {
                      value: formatWorkspacePaymentDecimal(payg.paygLimitState.limit.threshold, locale, 2),
                      unit: payg.paygLimitState.limit.metric === 'accrued_charge' ? currencyLabel : 'GB',
                    })}
                  </span>
                ) : null}
              />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  icon={<Activity className="h-4 w-4" />}
                  label={t('workspaceUsage.payg.chargedUsage')}
                  value={`${formatWorkspacePaymentDecimal(payg.chargedUsageGb, locale, 2)} GB`}
                  detail={t('workspaceUsage.payg.nativeCounter')}
                  tone="amber"
                />
                <MetricCard
                  icon={<CircleDollarSign className="h-4 w-4" />}
                  label={payg.cycleStatus === 'awaiting_payment'
                    ? t('workspaceUsage.payg.amountDue')
                    : t('workspaceUsage.payg.accruedCharge')}
                  value={`${formatWorkspacePaymentDecimal(payg.amountIqd, locale, 0)} ${currencyLabel}`}
                  detail={t('workspaceUsage.payg.roundingHint')}
                  tone="amber"
                />
                <MetricCard
                  icon={<CalendarClock className="h-4 w-4" />}
                  label={t('workspaceUsage.payg.renewalDue')}
                  value={formatDate(payg.renewalDueAt, locale)}
                  detail={t('workspaceUsage.payg.cycleStarted', { value: formatDate(payg.cycleStartedAt, locale) })}
                  tone="sky"
                />
                <MetricCard
                  icon={<Gauge className="h-4 w-4" />}
                  label={t('workspaceUsage.payg.pricingProfile')}
                  value={payg.pricingProfileName ?? t('workspaceUsage.payg.pricingProfileFallback', { version: payg.pricingVersion ?? '—' })}
                  detail={t('workspaceUsage.payg.pricingFrozen')}
                  tone="violet"
                />
              </div>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <div className="rounded-xl border border-border/60 bg-background p-4">
                  <h3 className="flex items-center gap-2 text-sm font-bold">
                    <Gauge className="h-4 w-4 text-primary" />
                    {t('workspaceUsage.payg.graphTitle')}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('workspaceUsage.payg.serverLastUpdated', { value: formatTimestamp(payg.lastUpdatedAt, locale) })}
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {payg.pricingCheckpoints.map((checkpoint) => (
                      <div key={`${checkpoint.gb}-${checkpoint.amountIqd}`} className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-3 py-2 text-xs">
                        <span className="font-semibold tabular-nums">{formatWorkspacePaymentDecimal(String(checkpoint.gb), locale, 2)} GB</span>
                        <span className="font-bold tabular-nums">{new Intl.NumberFormat(locale).format(checkpoint.amountIqd)} {currencyLabel}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-border/60 bg-background p-4">
                  <h3 className="flex items-center gap-2 text-sm font-bold">
                    <CalendarDays className="h-4 w-4 text-primary" />
                    {t('workspaceUsage.payg.historyTitle')}
                  </h3>
                  <DateRangeFilters className="mt-3" label={t('workspacePaymentPage.cycleStartDate')} />
                  <div className="mt-3 space-y-2">
                    {filteredPaygCycles.length ? filteredPaygCycles.map((cycle) => (
                      <div key={cycle.id} className="grid gap-2 rounded-lg border border-border/50 bg-card p-3 text-xs sm:grid-cols-[1fr_auto_auto] sm:items-center">
                        <div>
                          <p className="font-semibold">{formatDate(cycle.periodStartedAt, locale)} – {formatDate(cycle.periodEndedAt, locale)}</p>
                          <p className="mt-1 text-muted-foreground">{cycle.pricingProfileName ?? t('workspaceUsage.payg.pricingProfileFallback', { version: cycle.pricingVersion })}</p>
                        </div>
                        <p className="font-bold tabular-nums">{formatWorkspacePaymentDecimal(cycle.chargedUsageGb, locale, 2)} GB · {new Intl.NumberFormat(locale).format(Number(cycle.amountIqd))} {currencyLabel}</p>
                        <span className="rounded-full bg-muted px-2.5 py-1 text-center font-semibold">{t(`workspaceUsage.payg.statuses.${cycle.status}`)}</span>
                      </div>
                    )) : (
                      <p className="rounded-lg bg-muted/35 p-3 text-xs text-muted-foreground">
                        {payg.history.length ? t('workspacePaymentPage.noCyclesForRange') : t('workspaceUsage.payg.noHistory')}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
            <SectionHeading
              icon={<ReceiptText className="h-5 w-5" />}
              title={t('workspacePayments.paymentHistory')}
              action={transactions.length ? (
                <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
                  {t('workspacePaymentPage.recentTransactions', { count: transactions.length })}
                </span>
              ) : null}
            />
            <DateRangeFilters className="mb-4" label={t('workspacePayments.submittedAt')} />
            {filteredTransactions.length ? (
              <div className="space-y-2">
                {filteredTransactions.map((transaction) => (
                  <article key={transaction.id} className="grid gap-3 rounded-xl border border-border/60 bg-background p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:p-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-bold text-foreground">
                          {t(`workspacePaymentPage.paymentTypes.${transaction.paymentType}`)}
                        </p>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${getTransactionStatusClass(transaction.status)}`}>
                          {transaction.status === 'unknown'
                            ? t('workspacePaymentPage.unknownStatus')
                            : t(`workspacePayments.statuses.${transaction.status}`)}
                        </span>
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{t('workspacePayments.provider')}: {t(`workspacePaymentPage.providers.${transaction.provider}`)}</span>
                        <span>{t('workspacePayments.submittedAt')}: {formatTimestamp(transaction.createdAt, locale)}</span>
                        {transaction.paidAt ? <span>{t('workspacePayments.paidAt')}: {formatTimestamp(transaction.paidAt, locale)}</span> : null}
                      </p>
                      {transaction.reviewNote ? (
                        <p className="mt-2 rounded-lg bg-muted/35 p-2 text-xs text-muted-foreground">
                          {t('workspacePayments.reviewNote')}: {transaction.reviewNote}
                        </p>
                      ) : null}
                    </div>
                    <p className="text-sm font-black tabular-nums text-foreground sm:text-end">
                      {new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number(transaction.amount))} {transaction.currency}
                    </p>
                    {Number(transaction.gbAdded) > 0 ? (
                      <p className="flex items-center gap-1 text-xs font-semibold tabular-nums text-muted-foreground sm:justify-end">
                        <Database className="h-3.5 w-3.5" />
                        {formatWorkspacePaymentDecimal(transaction.gbAdded, locale, 2)} GB
                      </p>
                    ) : <span className="hidden sm:block" />}
                  </article>
                ))}
              </div>
            ) : (
              <p className="rounded-xl bg-muted/35 p-4 text-sm text-muted-foreground">
                {transactions.length ? t('workspacePaymentPage.noTransactionsForRange') : t('workspacePayments.noTransactions')}
              </p>
            )}
          </section>

          {pendingTransaction ? (
            <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              {t('workspacePayments.pendingMessage')}
            </p>
          ) : null}

          <WorkspacePaygLimitDialog
            open={paygLimitDialogOpen}
            onOpenChange={setPaygLimitDialogOpen}
            summary={payg ?? null}
            canManage={Boolean(payg?.canSubmitPayment)}
            onSaved={async () => {
              await Promise.allSettled([query.refetch(), refreshPaygSummary()])
            }}
          />
        </>
      ) : null}
    </div>
  )
}
