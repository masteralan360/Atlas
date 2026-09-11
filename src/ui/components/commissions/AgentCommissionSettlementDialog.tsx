import { useMemo } from 'react'
import { ClipboardList, ReceiptText } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatCurrency, formatDateTime } from '@/lib/utils'
import {
    useSalesOrders,
    type AgentCommissionEntry,
    type CurrencyCode,
    type IQDDisplayPreference,
} from '@/local-db'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Badge,
    Button,
} from '@/ui/components'
import { CommissionCurrencyTotalsView } from './CommissionCurrencyTotals'
import {
    buildCommissionHistoryGroups,
    commissionEntryOrderReference,
    summarizeCommissionEntries
} from './agentCommissionPresentation'

export function AgentCommissionSettlementDialog({
    open,
    onOpenChange,
    workspaceId,
    agentName,
    entries,
    iqdPreference
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    agentName: string
    entries: AgentCommissionEntry[]
    iqdPreference: IQDDisplayPreference
}) {
    const { t } = useTranslation()
    const salesOrders = useSalesOrders(workspaceId)
    const summary = useMemo(() => summarizeCommissionEntries(entries), [entries])
    const orderNumberById = useMemo(() => new Map(salesOrders.map((order) => [order.id, order.orderNumber])), [salesOrders])
    const historyGroups = useMemo(() => buildCommissionHistoryGroups(entries), [entries])
    const hasReversals = Object.values(summary.reversed).some((amount) => Math.abs(amount) > 0.000001)

    return (
        <AppDialog open={open} onOpenChange={onOpenChange}>
            <AppDialogContent className="max-w-3xl">
                <AppDialogHeader>
                    <AppDialogTitle className="flex items-center gap-2">
                        <ClipboardList className="h-5 w-5 text-violet-600" />
                        {t('salesAgentCommissions.reviewAgentCommission', { name: agentName })}
                    </AppDialogTitle>
                    <AppDialogDescription>
                        {t('salesAgentCommissions.reviewDescription')}
                    </AppDialogDescription>
                </AppDialogHeader>
                <AppDialogBody className="space-y-5">
                    <div className={`grid gap-3 sm:grid-cols-2 ${hasReversals ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
                        <SummaryTile label={t('salesAgentCommissions.netEarned', { defaultValue: 'Net earned' })} totals={summary.earned} iqdPreference={iqdPreference} />
                        <SummaryTile label={t('salesAgentCommissions.paid')} totals={summary.paid} iqdPreference={iqdPreference} />
                        {hasReversals ? <SummaryTile label={t('salesAgentCommissions.reversed')} totals={summary.reversed} iqdPreference={iqdPreference} /> : null}
                        <SummaryTile label={t('salesAgentCommissions.outstanding', { defaultValue: 'Outstanding' })} totals={summary.due} iqdPreference={iqdPreference} />
                    </div>

                    <section className="space-y-3" aria-label={t('salesAgentCommissions.commissionHistory')}>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <ReceiptText className="h-4 w-4 text-muted-foreground" />
                            {t('salesAgentCommissions.commissionHistory')}
                        </div>
                        {historyGroups.length === 0 ? (
                            <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                                {t('salesAgentCommissions.entriesEmpty')}
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {historyGroups.map((group) => (
                                    <CommissionHistoryGroupCard
                                        key={group.id}
                                        group={group}
                                        orderNumberById={orderNumberById}
                                        iqdPreference={iqdPreference}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                </AppDialogBody>
                <AppDialogFooter>
                    <Button type="button" onClick={() => onOpenChange(false)}>{t('salesAgentCommissions.close')}</Button>
                </AppDialogFooter>
            </AppDialogContent>
        </AppDialog>
    )
}

function CommissionHistoryGroupCard({
    group,
    orderNumberById,
    iqdPreference,
}: {
    group: ReturnType<typeof buildCommissionHistoryGroups>[number]
    orderNumberById: ReadonlyMap<string, string>
    iqdPreference: IQDDisplayPreference
}) {
    const { t } = useTranslation()
    const orderReference = group.orderId
        ? commissionEntryOrderReference({ orderId: group.orderId, payoutReference: group.payoutReference }, orderNumberById)
        : group.payoutReference || t('salesAgentCommissions.manualAdjustment')

    return (
        <div className="overflow-hidden rounded-2xl border">
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{orderReference}</span>
                        <CommissionHistoryStatusBadge status={group.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(group.occurredAt)}</p>
                </div>
                <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:text-end">
                    <HistoryAmount label={t('salesAgentCommissions.earned')} amount={group.earned} currency={group.currency} iqdPreference={iqdPreference} />
                    {group.paid > 0.000001 ? <HistoryAmount label={t('salesAgentCommissions.paid')} amount={group.paid} currency={group.currency} iqdPreference={iqdPreference} /> : null}
                    {group.recovered > 0.000001 ? <HistoryAmount label={t('salesAgentCommissions.recovered')} amount={group.recovered} currency={group.currency} iqdPreference={iqdPreference} /> : null}
                    {group.reversed > 0.000001 ? <HistoryAmount label={t('salesAgentCommissions.reversed')} amount={group.reversed} currency={group.currency} iqdPreference={iqdPreference} /> : null}
                    {Math.abs(group.outstanding) > 0.000001 ? <HistoryAmount label={t('salesAgentCommissions.outstanding')} amount={Math.abs(group.outstanding)} currency={group.currency} iqdPreference={iqdPreference} /> : null}
                </div>
            </div>
        </div>
    )
}

function CommissionHistoryStatusBadge({ status }: { status: ReturnType<typeof buildCommissionHistoryGroups>[number]['status'] }) {
    const { t } = useTranslation()
    const labels = {
        earned: t('salesAgentCommissions.earned'),
        paid: t('salesAgentCommissions.paid'),
        recovered: t('salesAgentCommissions.recovered'),
        reversed: t('salesAgentCommissions.reversed'),
        outstanding: t('salesAgentCommissions.outstanding'),
        recovery_due: t('salesAgentCommissions.recoveryDue'),
    }
    const classes = {
        earned: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        paid: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        recovered: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        reversed: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
        outstanding: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        recovery_due: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
    }

    return <Badge variant="outline" className={classes[status]}>{labels[status]}</Badge>
}

function HistoryAmount({
    label,
    amount,
    currency,
    iqdPreference,
}: {
    label: string
    amount: number
    currency: string
    iqdPreference: IQDDisplayPreference
}) {
    return (
        <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            <div className="mt-0.5 font-semibold">{formatCurrency(amount, currency as CurrencyCode, iqdPreference)}</div>
        </div>
    )
}

function SummaryTile({
    label,
    totals,
    iqdPreference
}: {
    label: string
    totals: Record<string, number>
    iqdPreference: IQDDisplayPreference
}) {
    return (
        <div className="rounded-2xl border bg-muted/20 p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
            <div className="mt-2 font-black"><CommissionCurrencyTotalsView totals={totals} iqdPreference={iqdPreference} /></div>
        </div>
    )
}
