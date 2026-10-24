import { useTranslation } from 'react-i18next'
import { CircleCheck, HandCoins, Loader2, Truck } from 'lucide-react'
import type { PostalDashboardSummary } from '@/local-db/postalSummary'
import { PostalError } from './shared'

export function PostalDashboardCards({
  summary,
  loading,
  error,
  onRetry,
}: {
  summary?: PostalDashboardSummary
  loading: boolean
  error: unknown
  onRetry: () => void
}) {
  const { t, i18n } = useTranslation()
  if (error && !loading) return <PostalError retry={onRetry} />
  const cards = [
    {
      key: 'active',
      value: summary?.active_shipments,
      icon: Truck,
      style:
        'border-blue-200 bg-gradient-to-br from-blue-50 to-blue-50/20 dark:border-blue-900 dark:from-blue-950/40 dark:to-card',
      iconStyle:
        'bg-blue-100 text-blue-600 dark:bg-blue-900/60 dark:text-blue-300',
    },
    {
      key: 'delivered',
      value: summary?.delivered_shipments,
      icon: CircleCheck,
      style:
        'border-emerald-200 bg-gradient-to-br from-emerald-50 to-emerald-50/20 dark:border-emerald-900 dark:from-emerald-950/40 dark:to-card',
      iconStyle:
        'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/60 dark:text-emerald-300',
    },
    {
      key: 'inTransit',
      value: summary?.in_transit_shipments,
      icon: Truck,
      style:
        'border-amber-200 bg-gradient-to-br from-amber-50 to-amber-50/20 dark:border-amber-900 dark:from-amber-950/40 dark:to-card',
      iconStyle:
        'bg-amber-100 text-amber-600 dark:bg-amber-900/60 dark:text-amber-300',
    },
    {
      key: 'cod',
      value: summary?.cod_balance,
      icon: HandCoins,
      style:
        'border-violet-200 bg-gradient-to-br from-violet-50 to-violet-50/20 dark:border-violet-900 dark:from-violet-950/40 dark:to-card',
      iconStyle:
        'bg-violet-100 text-violet-600 dark:bg-violet-900/60 dark:text-violet-300',
    },
  ] as const
  return (
    <section
      aria-label={t('postal.dashboard.title')}
      aria-busy={loading}
      className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
      data-testid="postal-dashboard"
    >
      {cards.map(({ key, value, icon: Icon, style, iconStyle }) => (
        <article
          key={key}
          className={`flex min-w-0 items-start gap-4 rounded-xl border p-4 shadow-sm ${style}`}
        >
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${iconStyle}`}
          >
            <Icon className="h-7 w-7" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">
              {t(`postal.dashboard.${key}.title`)}
            </h2>
            {loading || value === undefined ? (
              <div className="flex min-h-12 items-center" role="status">
                <Loader2
                  className="h-6 w-6 animate-spin text-muted-foreground"
                  aria-label={t('common.loading')}
                />
              </div>
            ) : (
              <p
                className="my-1 text-2xl font-bold tabular-nums [overflow-wrap:anywhere]"
                data-testid={`postal-stat-${key}`}
              >
                {key === 'cod'
                  ? `${t('postal.iqd')} ${new Intl.NumberFormat(i18n.language).format(BigInt(value))}`
                  : new Intl.NumberFormat(i18n.language).format(Number(value))}
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(`postal.dashboard.${key}.description`)}
            </p>
          </div>
        </article>
      ))}
    </section>
  )
}
