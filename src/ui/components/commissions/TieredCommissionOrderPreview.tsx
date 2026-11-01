import { BadgeCheck, Clock3, Coins, Loader2, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { TieredCommissionOrderPreview as TieredCommissionOrderPreviewData } from '@/local-db/tieredPerformanceCommissions'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Badge } from '@/ui/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/table'

export function TieredCommissionOrderPreview({
  preview,
  isLoading,
  hasError,
  iqdPreference,
}: {
  preview: TieredCommissionOrderPreviewData | null | undefined
  isLoading: boolean
  hasError: boolean
  iqdPreference: 'IQD' | 'د.ع'
}) {
  const { t } = useTranslation()

  if (!isLoading && !hasError && !preview) return null

  return (
    <Card className="border-primary/20">
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          {t('salesAgentCommissions.tiered.orderPreviewTitle')}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t('salesAgentCommissions.tiered.orderPreviewDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div role="status" className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('salesAgentCommissions.tiered.loading')}
          </div>
        ) : hasError ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {t('salesAgentCommissions.tiered.orderPreviewLoadFailed')}
          </p>
        ) : preview ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <Summary label={t('salesAgentCommissions.tiered.orderPreviewAgent')} value={preview.agentName} />
              <Summary label={t('salesAgentCommissions.tiered.program')} value={preview.programName} />
              <Summary label={t('salesAgentCommissions.tiered.tier')} value={preview.tierName || '—'} />
            </div>

            {preview.saleStatus === 'pending_cycle' ? (
              <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                {t('salesAgentCommissions.tiered.orderPreviewPending')}
              </p>
            ) : null}

            {preview.entries.length ? (
              <div className="overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('salesAgentCommissions.tiered.date')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.product')}</TableHead>
                      <TableHead>{t('salesAgentCommissions.tiered.recordStatus')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.quantity')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.orderPreviewRate')}</TableHead>
                      <TableHead className="text-end">{t('salesAgentCommissions.tiered.amount')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-nowrap">{formatDate(entry.occurredAt)}</TableCell>
                        <TableCell>
                          <div className="font-medium">{entry.productName}</div>
                          {entry.productSku ? <div className="text-xs text-muted-foreground">{entry.productSku}</div> : null}
                          <div className="mt-1 text-xs text-muted-foreground">
                            {entry.programName} · {entry.tierName} · {t(`salesAgentCommissions.tiered.kind.${entry.kind}`)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={entry.status === 'correction_pending' ? 'destructive' : entry.status === 'settled' ? 'secondary' : 'outline'}>
                            {t(`salesAgentCommissions.tiered.status.${entry.status}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{Math.abs(entry.quantity).toLocaleString()}</TableCell>
                        <TableCell className="text-end tabular-nums">{formatCurrency(entry.commissionPerUnitIqd, 'iqd', iqdPreference)}</TableCell>
                        <TableCell className={`text-end font-semibold tabular-nums ${entry.amountIqd < 0 ? 'text-destructive' : ''}`}>
                          {formatCurrency(entry.amountIqd, 'iqd', iqdPreference)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : preview.saleStatus !== 'pending_cycle' ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                <BadgeCheck className="h-4 w-4 shrink-0" />
                {t('salesAgentCommissions.tiered.orderPreviewNoRates')}
              </div>
            ) : null}

            {preview.entries.length ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/35 p-3">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Coins className="h-4 w-4 text-primary" />
                  {t('salesAgentCommissions.tiered.orderPreviewTotal')}
                </span>
                <span className={`text-lg font-bold tabular-nums ${preview.totalAmountIqd < 0 ? 'text-destructive' : ''}`}>
                  {formatCurrency(preview.totalAmountIqd, 'iqd', iqdPreference)}
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border bg-background/70 p-3">
      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium" title={value}>{value}</div>
    </div>
  )
}
