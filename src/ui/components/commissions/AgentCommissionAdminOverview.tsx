import { useMemo, useState } from 'react'
import { BadgeCheck, BadgeDollarSign, BadgePercent, CircleDollarSign, Eye, ReceiptText, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAgentCommissionEntries, usePaymentObligations, useSalesOrderAgentAssignments, useSalesOrders, type IQDDisplayPreference, type PaymentObligation } from '@/local-db'
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/ui/components'
import { CommissionCurrencyTotalsView } from './CommissionCurrencyTotals'
import { formatCommissionPlanTerms, summarizeCommissionEntries } from './agentCommissionPresentation'
import { useCommissionAgentDirectory } from './useCommissionAgentDirectory'
import { AgentCommissionSettlementDialog } from './AgentCommissionSettlementDialog'

export function AgentCommissionAdminOverview({
    workspaceId,
    iqdPreference,
    canReview = false,
    canPay = false,
    onSettleCommission
}: {
    workspaceId: string
    iqdPreference: IQDDisplayPreference
    canReview?: boolean
    canPay?: boolean
    onSettleCommission?: (obligation: PaymentObligation) => void
}) {
    const { t } = useTranslation()
    const entries = useAgentCommissionEntries(workspaceId)
    const assignments = useSalesOrderAgentAssignments(workspaceId)
    const salesOrders = useSalesOrders(workspaceId)
    const directory = useCommissionAgentDirectory(workspaceId)
    const paymentObligations = usePaymentObligations(workspaceId)
    const [settlementAgentId, setSettlementAgentId] = useState<string | null>(null)
    const summary = useMemo(() => summarizeCommissionEntries(entries), [entries])
    const trackedSummary = useMemo(() => summarizeCommissionEntries(entries, 'tracked'), [entries])
    const currentAssignments = useMemo(
        () => assignments.filter((assignment) => !assignment.isDeleted && !assignment.unassignedAt),
        [assignments]
    )
    const assignedAssignments = useMemo(
        () => assignments.filter((assignment) => !assignment.isDeleted),
        [assignments]
    )
    const salesOrderById = useMemo(() => new Map(salesOrders.map((order) => [order.id, order])), [salesOrders])
    const rows = useMemo(() => directory.agents
        .map((entry) => {
            const agentOrders = Array.from(new Map(assignedAssignments
                .filter((assignment) => assignment.agentId === entry.agent.id)
                .flatMap((assignment) => {
                    const order = salesOrderById.get(assignment.orderId)
                    return order ? [order] : []
                })
                .map((order) => [order.id, order] as const)).values())
            const totalOrderValue = agentOrders.reduce<Record<string, number>>((totals, order) => {
                totals[order.currency] = (totals[order.currency] || 0) + Number(order.total || 0)
                return totals
            }, {})
            return {
                entry,
                summary: summarizeCommissionEntries(entries.filter((ledgerEntry) => ledgerEntry.agentId === entry.agent.id)),
                trackedSummary: summarizeCommissionEntries(entries.filter((ledgerEntry) => ledgerEntry.agentId === entry.agent.id), 'tracked'),
                assignedOrders: agentOrders.length,
                openOrders: agentOrders.filter((order) => order.status === 'draft' || order.status === 'pending').length,
                cancelledOrders: agentOrders.filter((order) => order.status === 'cancelled').length,
                returnedOrders: agentOrders.filter((order) => order.returnStatus === 'partial' || order.returnStatus === 'full').length,
                zeroValueOrders: agentOrders.filter((order) => order.total <= 0).length,
                totalOrderValue
            }
        })
        .filter((row) => row.entry.membership || row.summary.entryCount > 0 || row.trackedSummary.entryCount > 0 || row.assignedOrders > 0)
        .sort((left, right) => right.assignedOrders - left.assignedOrders || left.entry.name.localeCompare(right.entry.name)),
    [assignedAssignments, directory.agents, entries, salesOrderById])
    const settlementByAgentId = useMemo(() => {
        const result = new Map<string, PaymentObligation>()
        paymentObligations
            .filter((obligation) => (
                obligation.sourceType === 'agent_commission_payout'
                || obligation.sourceType === 'agent_commission_recovery'
            ))
            .sort((left, right) => (left.createdAt || '').localeCompare(right.createdAt || ''))
            .forEach((obligation) => {
                const agentId = typeof obligation.metadata?.agentId === 'string' ? obligation.metadata.agentId : null
                if (agentId && !result.has(agentId)) result.set(agentId, obligation)
            })
        return result
    }, [paymentObligations])

    return (
        <Card className="border-violet-500/20 bg-violet-500/[0.02]">
            <CardHeader className="space-y-1">
                <CardTitle className="flex items-center gap-2">
                    <BadgePercent className="h-5 w-5 text-violet-600" />
                    {t('salesAgentCommissions.title')}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                    {t('salesAgentCommissions.overviewDescription')}
                </p>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
                    <OverviewMetric
                        label={t('salesAgentCommissions.assignedOrders')}
                        icon={ReceiptText}
                        value={String(currentAssignments.length)}
                    />
                    <OverviewMetric
                        label={t('salesAgentCommissions.payableCommission')}
                        icon={BadgeCheck}
                        value={<CommissionCurrencyTotalsView totals={summary.earned} iqdPreference={iqdPreference} />}
                    />
                    <OverviewMetric
                        label={t('salesAgentCommissions.netPaid')}
                        icon={CircleDollarSign}
                        value={<CommissionCurrencyTotalsView totals={summary.netPaid} iqdPreference={iqdPreference} />}
                    />
                    <OverviewMetric
                        label={t('salesAgentCommissions.trackedTotal')}
                        icon={BadgeDollarSign}
                        value={<CommissionCurrencyTotalsView totals={trackedSummary.earned} iqdPreference={iqdPreference} />}
                    />
                    <OverviewMetric
                        label={t('salesAgentCommissions.recovered')}
                        icon={RotateCcw}
                        value={<CommissionCurrencyTotalsView totals={summary.recovered} iqdPreference={iqdPreference} />}
                    />
                    <OverviewMetric
                        label={t('salesAgentCommissions.reversed')}
                        icon={RotateCcw}
                        value={<CommissionCurrencyTotalsView totals={summary.reversed} iqdPreference={iqdPreference} />}
                    />
                    <OverviewMetric
                        label={t('salesAgentCommissions.due')}
                        icon={CircleDollarSign}
                        value={<CommissionCurrencyTotalsView totals={summary.due} iqdPreference={iqdPreference} />}
                    />
                </div>

                {rows.length === 0 ? (
                    <div className="rounded-2xl border border-dashed py-8 text-center text-sm text-muted-foreground">
                        {t('salesAgentCommissions.overviewEmpty')}
                    </div>
                ) : (
                    <div className="overflow-x-auto rounded-2xl border bg-background">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('salesAgentCommissions.agent')}</TableHead>
                                    <TableHead>{t('salesAgentCommissions.plan')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.orders')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.open')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.returned')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.cancelledZero')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.totalOrderValue')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.payableCommission')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.trackedTotal')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.netPaid')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.recovered')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.reversed')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.outstanding')}</TableHead>
                                    {canReview || canPay ? <TableHead className="text-end">{t('salesAgentCommissions.action')}</TableHead> : null}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map(({ entry, summary: agentSummary, trackedSummary: agentTrackedSummary, assignedOrders, openOrders, returnedOrders, cancelledOrders, zeroValueOrders, totalOrderValue }) => {
                                    const settlement = settlementByAgentId.get(entry.agent.id)
                                    return (
                                    <TableRow key={entry.agent.id}>
                                        <TableCell>
                                            <div className="font-semibold">{entry.name}</div>
                                            <div className="text-xs text-muted-foreground">{entry.agent.zone}</div>
                                        </TableCell>
                                        <TableCell>
                                            {entry.plan ? (
                                                <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                                                    {entry.plan.name} · {formatCommissionPlanTerms(entry.plan, iqdPreference)}
                                                </Badge>
                                            ) : <span className="text-sm text-muted-foreground">{t('salesAgentCommissions.noPlan')}</span>}
                                        </TableCell>
                                        <TableCell className="text-end font-semibold">{assignedOrders}</TableCell>
                                        <TableCell className="text-end font-semibold text-amber-600">{openOrders}</TableCell>
                                        <TableCell className="text-end font-semibold text-orange-600">{returnedOrders}</TableCell>
                                        <TableCell className="text-end font-semibold text-rose-600">{cancelledOrders} / {zeroValueOrders}</TableCell>
                                        <TableCell className="text-end font-semibold"><CommissionCurrencyTotalsView totals={totalOrderValue} iqdPreference={iqdPreference} /></TableCell>
                                        <TableCell className="text-end font-semibold"><CommissionCurrencyTotalsView totals={agentSummary.earned} iqdPreference={iqdPreference} /></TableCell>
                                        <TableCell className="text-end font-semibold text-sky-700 dark:text-sky-300"><CommissionCurrencyTotalsView totals={agentTrackedSummary.earned} iqdPreference={iqdPreference} /></TableCell>
                                        <TableCell className="text-end font-semibold text-emerald-600"><CommissionCurrencyTotalsView totals={agentSummary.netPaid} iqdPreference={iqdPreference} /></TableCell>
                                        <TableCell className="text-end font-semibold text-sky-600"><CommissionCurrencyTotalsView totals={agentSummary.recovered} iqdPreference={iqdPreference} /></TableCell>
                                        <TableCell className="text-end font-semibold text-rose-600"><CommissionCurrencyTotalsView totals={agentSummary.reversed} iqdPreference={iqdPreference} /></TableCell>
                                        <TableCell className="text-end font-black"><CommissionCurrencyTotalsView totals={agentSummary.due} iqdPreference={iqdPreference} /></TableCell>
                                        {canReview || canPay ? (
                                            <TableCell className="text-end">
                                                {canReview ? (
                                                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSettlementAgentId(entry.agent.id)}>
                                                        <Eye className="h-3.5 w-3.5" /> {t('salesAgentCommissions.review')}
                                                    </Button>
                                                ) : null}
                                                {canPay && settlement && onSettleCommission ? (
                                                    <Button size="sm" className="ms-2 gap-1.5" onClick={() => onSettleCommission(settlement)}>
                                                        <CircleDollarSign className="h-3.5 w-3.5" />
                                                        {settlement.direction === 'incoming'
                                                            ? t('salesAgentCommissions.collectRecovery')
                                                            : t('salesAgentCommissions.payCommission')}
                                                    </Button>
                                                ) : null}
                                            </TableCell>
                                        ) : null}
                                    </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
            {settlementAgentId ? (
                <AgentCommissionSettlementDialog
                    open={true}
                    onOpenChange={(open) => { if (!open) setSettlementAgentId(null) }}
                    workspaceId={workspaceId}
                    agentName={directory.agentById.get(settlementAgentId)?.name || t('salesAgentCommissions.agent')}
                    entries={entries.filter((entry) => entry.agentId === settlementAgentId && !entry.isDeleted)}
                    iqdPreference={iqdPreference}
                />
            ) : null}
        </Card>
    )
}

function OverviewMetric({
    label,
    icon: Icon,
    value
}: {
    label: string
    icon: typeof ReceiptText
    value: React.ReactNode
}) {
    return (
        <div className="rounded-2xl border bg-background/80 p-4">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                <Icon className="h-4 w-4" />
                {label}
            </div>
            <div className="mt-2 text-lg font-black">{value}</div>
        </div>
    )
}
