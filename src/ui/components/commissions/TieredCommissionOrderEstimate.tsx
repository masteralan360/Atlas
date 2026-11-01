import { Coins, Loader2, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { TieredCommissionOrderEstimate as TieredCommissionOrderEstimateData } from '@/local-db/tieredPerformanceCommissions'
import { formatCurrency } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'

export function TieredCommissionOrderEstimate({
  estimate,
  isLoading,
  hasError,
  iqdPreference,
}: {
  estimate: TieredCommissionOrderEstimateData | null | undefined
  isLoading: boolean
  hasError: boolean
  iqdPreference: 'IQD' | 'د.ع'
}) {
  const { t } = useTranslation()

  if (!isLoading && !hasError && !estimate) return null

  return (
    <Card className="border-primary/20 bg-primary/[0.02]">
      <CardHeader className="p-3 sm:p-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4 shrink-0 text-primary" />
          {t('salesAgentCommissions.tiered.draftEstimateTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-3 pb-3 pt-0 sm:px-4 sm:pb-4">
        {isLoading ? (
          <div role="status" className="flex min-h-12 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('salesAgentCommissions.tiered.loading')}
          </div>
        ) : hasError ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {t('salesAgentCommissions.tiered.draftEstimateLoadFailed')}
          </p>
        ) : estimate ? (
          <>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <Summary label={t('salesAgentCommissions.tiered.agent')} value={estimate.agentName} />
              <Summary label={t('salesAgentCommissions.tiered.program')} value={estimate.programName} />
              <Summary label={t('salesAgentCommissions.tiered.tier')} value={estimate.tierName} />
              <Summary label={t('salesAgentCommissions.tiered.totalQualifyingSales')} value={estimate.qualifyingSalesAfter.toLocaleString()} />
            </div>

            <p className="rounded-lg bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
              {t('salesAgentCommissions.tiered.draftEstimateCountedSale', {
                saleNumber: estimate.qualifyingSalesAfter.toLocaleString(),
              })}
            </p>

            {estimate.entries.length ? (
              <div className="divide-y rounded-lg border px-2.5">
                {estimate.entries.map((entry) => (
                  <div key={entry.lineId} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-medium" title={entry.productName}>{entry.productName}</div>
                      <div className="mt-0.5 text-muted-foreground">
                        {entry.quantity.toLocaleString()} × {formatCurrency(entry.commissionPerUnitIqd, 'iqd', iqdPreference)} {t('salesAgentCommissions.tiered.orderPreviewRate')}
                      </div>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatCurrency(entry.amountIqd, 'iqd', iqdPreference)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">
                {t('salesAgentCommissions.tiered.draftEstimateNoRates')}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/35 px-2.5 py-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                <Coins className="h-3.5 w-3.5 text-primary" />
                {t('salesAgentCommissions.tiered.orderPreviewTotal')}
              </span>
              <span className="text-sm font-bold tabular-nums">
                {formatCurrency(estimate.totalAmountIqd, 'iqd', iqdPreference)}
              </span>
            </div>

          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return <span className="min-w-0 truncate" title={`${label}: ${value}`}><span className="text-muted-foreground">{label}: </span><span className="font-medium">{value}</span></span>
}
