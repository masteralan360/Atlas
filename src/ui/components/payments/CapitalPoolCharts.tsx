import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  ChartNoAxesCombined,
  CircleDollarSign,
  PieChart as PieChartIcon,
  TrendingUp
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from 'recharts'

import { useDateRange } from '@/context/DateRangeContext'
import {
  buildCapitalPoolAccountCashFlows,
  buildCapitalPoolTotalsByCurrency
} from '@/local-db/capitalPools'
import type {
  CapitalPool,
  PaymentAccount,
  PaymentAccountBalance,
  PaymentAccountMovement,
  PaymentTransaction
} from '@/local-db/models'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import { PaymentAccountIcon } from '@/ui/components/payments/PaymentAccountIcon'

import type { CapitalPoolBreakdown, CapitalPoolCashFlowGranularity } from '@/local-db/capitalPools'

const CHART_COLORS = [
  '#2563eb',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#84cc16'
]
const COMPARISON_CHART_INITIAL_DIMENSION = { width: 320, height: 220 }
const STANDARD_CHART_INITIAL_DIMENSION = { width: 320, height: 288 }

type IqdDisplayPreference = 'IQD' | 'د.ع'

interface CapitalPoolChartDataProps {
  pools: CapitalPool[]
  accounts: PaymentAccount[]
  balances: PaymentAccountBalance[]
  iqdDisplayPreference: IqdDisplayPreference
}

interface SelectedCapitalPoolChartsProps {
  pools: CapitalPool[]
  accounts: PaymentAccount[]
  selectedPool: CapitalPool
  breakdown: CapitalPoolBreakdown
  movements: PaymentAccountMovement[]
  transactions: PaymentTransaction[]
  iqdDisplayPreference: IqdDisplayPreference
}

interface CapitalDistributionDatum extends Record<string, unknown> {
  accountId: string
  accountName: string
  balanceAmount: number
  sharePercent: number
}

function compactAmount(value: number, language: string) {
  return new Intl.NumberFormat(language, {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

function truncateChartLabel(value: string, maximumLength = 18) {
  return value.length > maximumLength ? `${value.slice(0, maximumLength - 1)}…` : value
}

function cashFlowBucketLabel(
  value: string,
  granularity: CapitalPoolCashFlowGranularity,
  language: string
) {
  if (granularity === 'month') {
    return new Date(`${value}T00:00:00`).toLocaleDateString(language, { month: 'short', year: '2-digit' })
  }
  return formatDate(value)
}

function NoChartData({ message }: { message: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/10 px-6 text-center">
      <ChartNoAxesCombined className="h-9 w-9 text-muted-foreground/60" />
      <p className="mt-3 text-sm font-medium text-muted-foreground">{message}</p>
    </div>
  )
}

export function CapitalPoolTotalsComparison({
  pools,
  accounts,
  balances,
  iqdDisplayPreference
}: CapitalPoolChartDataProps) {
  const { t, i18n } = useTranslation()
  const currencyGroups = useMemo(
    () => buildCapitalPoolTotalsByCurrency(pools, accounts, balances),
    [accounts, balances, pools]
  )
  const activePoolCount = pools.filter((pool) => !pool.isDeleted).length

  if (activePoolCount < 2 || currencyGroups.length === 0) return null

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border/60">
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          {t('paymentAccounts.capitalPools.charts.poolComparisonTitle')}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('paymentAccounts.capitalPools.charts.poolComparisonDescription')}
        </p>
      </CardHeader>
      <CardContent className="grid gap-5 p-5 lg:grid-cols-2">
        {currencyGroups.map((group) => (
          <section
            key={group.currency}
            className="min-w-0 rounded-2xl border border-border/60 bg-muted/[0.12] p-4"
            aria-label={t('paymentAccounts.capitalPools.charts.poolComparisonAria', {
              currency: group.currency.toUpperCase()
            })}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-black uppercase text-primary">
                {group.currency}
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                {t('paymentAccounts.capitalPools.poolCount', { count: group.pools.length })}
              </span>
            </div>
            <div style={{ height: Math.max(220, group.pools.length * 56) }} role="img">
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={0}
                initialDimension={COMPARISON_CHART_INITIAL_DIMENSION}
              >
                <BarChart
                  data={group.pools}
                  layout="vertical"
                  margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke="hsl(var(--border))" opacity={0.55} />
                  <XAxis
                    type="number"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(value) => compactAmount(Number(value), i18n.language)}
                  />
                  <YAxis
                    type="category"
                    dataKey="poolName"
                    width={112}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fontWeight: 700, fill: 'hsl(var(--foreground))' }}
                    tickFormatter={(value) => truncateChartLabel(String(value), 16)}
                  />
                  <RechartsTooltip
                    cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
                    contentStyle={{
                      color: 'hsl(var(--popover-foreground))',
                      backgroundColor: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '14px'
                    }}
                    labelStyle={{ color: 'hsl(var(--popover-foreground))', fontWeight: 700 }}
                    itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                    formatter={(value) => [
                      formatCurrency(Number(value), group.currency, iqdDisplayPreference, 2),
                      t('paymentAccounts.capitalPools.totalCapital')
                    ]}
                  />
                  <Bar dataKey="totalCapital" fill="#2563eb" radius={[0, 8, 8, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  )
}

export function SelectedCapitalPoolCharts({
  pools,
  accounts,
  selectedPool,
  breakdown,
  movements,
  transactions,
  iqdDisplayPreference
}: SelectedCapitalPoolChartsProps) {
  const { t, i18n } = useTranslation()
  const { dateRange, customDates } = useDateRange()
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )
  const flowRange = useMemo(
    () => getDateRangeBounds(dateRange, customDates),
    [customDates, dateRange]
  )
  const cashFlows = useMemo(
    () => buildCapitalPoolAccountCashFlows(selectedPool, movements, transactions, flowRange),
    [flowRange, movements, selectedPool, transactions]
  )
  const cashFlowByAccount = useMemo(
    () => new Map(cashFlows.map((flow) => [flow.accountId, flow])),
    [cashFlows]
  )
  const distributionData = useMemo<CapitalDistributionDatum[]>(
    () => breakdown.members
      .filter((member) => member.balanceAmount > 0)
      .map((member) => ({
        accountId: member.accountId,
        accountName: member.accountName,
        balanceAmount: member.balanceAmount,
        sharePercent: member.sharePercent
      })),
    [breakdown.members]
  )
  const poolCount = pools.filter((pool) => !pool.isDeleted).length

  return (
    <section className="space-y-6" aria-labelledby="capital-pool-analytics-title">
      <div>
        <div className="flex items-center gap-2">
          <ChartNoAxesCombined className="h-6 w-6 text-primary" />
          <h3 id="capital-pool-analytics-title" className="text-xl font-bold">
            {t('paymentAccounts.capitalPools.charts.analyticsTitle')}
          </h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(poolCount >= 2
            ? 'paymentAccounts.capitalPools.charts.analyticsDescription'
            : 'paymentAccounts.capitalPools.charts.analyticsDescriptionSingle', {
            pool: selectedPool.name,
            count: poolCount
          })}
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b border-border/60">
            <CardTitle className="flex items-center gap-2">
              <PieChartIcon className="h-5 w-5 text-primary" />
              {t('paymentAccounts.capitalPools.charts.distributionTitle')}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {t('paymentAccounts.capitalPools.charts.distributionDescription')}
            </p>
          </CardHeader>
          <CardContent className="p-5">
            {distributionData.length === 0 ? (
              <NoChartData message={t('paymentAccounts.capitalPools.charts.noBalanceData')} />
            ) : (
              <>
                <div
                  className="h-72 w-full"
                  role="img"
                  aria-label={t('paymentAccounts.capitalPools.charts.distributionAria', { pool: selectedPool.name })}
                >
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={0}
                    initialDimension={STANDARD_CHART_INITIAL_DIMENSION}
                  >
                    <PieChart>
                      <Pie
                        data={distributionData}
                        dataKey="balanceAmount"
                        nameKey="accountName"
                        cx="50%"
                        cy="50%"
                        innerRadius="48%"
                        outerRadius="78%"
                        paddingAngle={2}
                        stroke="hsl(var(--card))"
                        strokeWidth={2}
                      >
                        {distributionData.map((member, index) => (
                          <Cell key={member.accountId} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip
                        contentStyle={{
                          color: 'hsl(var(--popover-foreground))',
                          backgroundColor: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '14px'
                        }}
                        labelStyle={{ color: 'hsl(var(--popover-foreground))', fontWeight: 700 }}
                        itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                        formatter={(value, _name, item) => {
                          const member = item.payload as { sharePercent?: number }
                          return [
                            `${formatCurrency(Number(value), selectedPool.currency, iqdDisplayPreference, 2)} · ${Number(member.sharePercent || 0).toFixed(2)}%`,
                            t('paymentAccounts.capitalPools.totalCapital')
                          ]
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {distributionData.map((member, index) => (
                    <div key={member.accountId} className="flex min-w-0 items-center gap-2 rounded-xl border border-border/50 px-3 py-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{member.accountName}</span>
                      <span className="text-xs font-black tabular-nums text-primary">{member.sharePercent.toFixed(2)}%</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="border-b border-border/60">
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              {t('paymentAccounts.capitalPools.charts.balanceRankingTitle')}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {t('paymentAccounts.capitalPools.charts.balanceRankingDescription')}
            </p>
          </CardHeader>
          <CardContent className="p-5">
            <div
              style={{ height: Math.max(288, breakdown.members.length * 58) }}
              role="img"
              aria-label={t('paymentAccounts.capitalPools.charts.balanceRankingAria', { pool: selectedPool.name })}
            >
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={0}
                initialDimension={STANDARD_CHART_INITIAL_DIMENSION}
              >
                <BarChart
                  data={breakdown.members}
                  layout="vertical"
                  margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke="hsl(var(--border))" opacity={0.55} />
                  <XAxis
                    type="number"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    tickFormatter={(value) => compactAmount(Number(value), i18n.language)}
                  />
                  <YAxis
                    type="category"
                    dataKey="accountName"
                    width={118}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fontWeight: 700, fill: 'hsl(var(--foreground))' }}
                    tickFormatter={(value) => truncateChartLabel(String(value))}
                  />
                  <RechartsTooltip
                    cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
                    contentStyle={{
                      color: 'hsl(var(--popover-foreground))',
                      backgroundColor: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '14px'
                    }}
                    labelStyle={{ color: 'hsl(var(--popover-foreground))', fontWeight: 700 }}
                    itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                    formatter={(value) => [
                      formatCurrency(Number(value), selectedPool.currency, iqdDisplayPreference, 2),
                      t('paymentAccounts.capitalPools.charts.balance')
                    ]}
                  />
                  <Bar dataKey="balanceAmount" fill="#10b981" radius={[0, 8, 8, 0]} maxBarSize={30} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border/60">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                {t('paymentAccounts.capitalPools.charts.cashFlowTitle')}
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('paymentAccounts.capitalPools.charts.cashFlowDescription', {
                  currency: selectedPool.currency.toUpperCase()
                })}
              </p>
            </div>
            <DateRangeFilters
              showYesterday
              label={t('paymentAccounts.capitalPools.charts.cashFlowPeriod')}
              className="max-w-full [&>div>div]:flex-wrap"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('paymentAccounts.capitalPools.charts.liveBalanceUnaffected')}
          </p>
        </CardHeader>
        <CardContent className="grid gap-5 p-5 xl:grid-cols-2">
          {breakdown.members.map((member) => {
            const account = accountById.get(member.accountId)
            const flow = cashFlowByAccount.get(member.accountId)
            const grouping = flow?.granularity ?? 'day'
            const points = flow?.points ?? []
            const net = flow?.net ?? 0
            return (
              <article key={member.accountId} className="min-w-0 rounded-2xl border border-border/60 bg-muted/[0.08] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="rounded-xl bg-primary/10 p-2 text-primary">
                      <PaymentAccountIcon iconKey={account?.iconKey} accountType={account?.accountType} className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <h4 className="truncate font-bold">{member.accountName}</h4>
                      <p className="text-xs text-muted-foreground">
                        {t(`paymentAccounts.capitalPools.charts.grouping.${grouping}`)}
                      </p>
                    </div>
                  </div>
                  <span className="rounded-full border bg-background px-2.5 py-1 text-xs font-bold tabular-nums">
                    {t('paymentAccounts.capitalPools.charts.transactionCount', { count: flow?.transactionCount ?? 0 })}
                  </span>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-2.5">
                    <p className="flex items-center gap-1 text-[10px] font-bold uppercase text-emerald-700 dark:text-emerald-300">
                      <ArrowDownLeft className="h-3 w-3" />
                      {t('ledger.incoming')}
                    </p>
                    <p className="mt-1 break-words text-xs font-black leading-tight tabular-nums text-emerald-700 dark:text-emerald-300">
                      {formatCurrency(flow?.incoming ?? 0, selectedPool.currency, iqdDisplayPreference, 2)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-2.5">
                    <p className="flex items-center gap-1 text-[10px] font-bold uppercase text-rose-700 dark:text-rose-300">
                      <ArrowUpRight className="h-3 w-3" />
                      {t('ledger.outgoing')}
                    </p>
                    <p className="mt-1 break-words text-xs font-black leading-tight tabular-nums text-rose-700 dark:text-rose-300">
                      {formatCurrency(flow?.outgoing ?? 0, selectedPool.currency, iqdDisplayPreference, 2)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-2.5">
                    <p className="flex items-center gap-1 text-[10px] font-bold uppercase text-sky-700 dark:text-sky-300">
                      <CircleDollarSign className="h-3 w-3" />
                      {t('ledger.netFlow')}
                    </p>
                    <p className="mt-1 break-words text-xs font-black leading-tight tabular-nums text-sky-700 dark:text-sky-300">
                      {formatCurrency(net, selectedPool.currency, iqdDisplayPreference, 2)}
                    </p>
                  </div>
                </div>

                {points.length === 0 ? (
                  <div className="mt-4">
                    <NoChartData message={t('paymentAccounts.capitalPools.charts.noCashFlowData')} />
                  </div>
                ) : (
                  <div
                    className="mt-4 h-72 w-full"
                    role="img"
                    aria-label={t('paymentAccounts.capitalPools.charts.cashFlowAria', { account: member.accountName })}
                  >
                    <ResponsiveContainer
                      width="100%"
                      height="100%"
                      minWidth={0}
                      initialDimension={STANDARD_CHART_INITIAL_DIMENSION}
                    >
                      <ComposedChart data={points} margin={{ top: 10, right: 8, bottom: 4, left: 0 }}>
                        <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="hsl(var(--border))" opacity={0.55} />
                        <XAxis
                          dataKey="bucketStart"
                          axisLine={false}
                          tickLine={false}
                          minTickGap={22}
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          tickFormatter={(value) => cashFlowBucketLabel(String(value), grouping, i18n.language)}
                        />
                        <YAxis
                          yAxisId="amount"
                          axisLine={false}
                          tickLine={false}
                          width={48}
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          tickFormatter={(value) => compactAmount(Number(value), i18n.language)}
                        />
                        <YAxis yAxisId="count" hide />
                        <RechartsTooltip
                          cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
                          contentStyle={{
                            color: 'hsl(var(--popover-foreground))',
                            backgroundColor: 'hsl(var(--popover))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '14px'
                          }}
                          labelStyle={{ color: 'hsl(var(--popover-foreground))', fontWeight: 700 }}
                          itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                          labelFormatter={(value) => cashFlowBucketLabel(String(value), grouping, i18n.language)}
                          formatter={(value, name, item) => item.dataKey === 'transactionCount'
                            ? [Number(value), t('paymentAccounts.capitalPools.charts.transactions')]
                            : [formatCurrency(Number(value), selectedPool.currency, iqdDisplayPreference, 2), String(name)]}
                        />
                        <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                        <Bar
                          yAxisId="amount"
                          dataKey="incoming"
                          name={t('ledger.incoming')}
                          fill="#10b981"
                          radius={[5, 5, 0, 0]}
                          maxBarSize={22}
                        />
                        <Bar
                          yAxisId="amount"
                          dataKey="outgoing"
                          name={t('ledger.outgoing')}
                          fill="#f43f5e"
                          radius={[5, 5, 0, 0]}
                          maxBarSize={22}
                        />
                        <Line
                          yAxisId="amount"
                          type="monotone"
                          dataKey="net"
                          name={t('ledger.netFlow')}
                          stroke="#0ea5e9"
                          strokeWidth={2.5}
                          dot={{ r: 2.5 }}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          yAxisId="count"
                          dataKey="transactionCount"
                          name={t('paymentAccounts.capitalPools.charts.transactions')}
                          stroke="transparent"
                          dot={false}
                          activeDot={false}
                          legendType="none"
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </article>
            )
          })}
        </CardContent>
      </Card>
    </section>
  )
}
