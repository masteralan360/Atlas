import { useMemo } from 'react'
import { BadgeCheck, BadgeDollarSign, BadgePercent, CircleDollarSign, Eye, ReceiptText, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'

import { formatCurrency, formatDateTime } from '@/lib/utils'
import {
    useAgentCommissionEntries,
    useAgentProductCommissionEntries,
    useSalesOrders,
    useSalesOrderAgentAssignments,
    type CurrencyCode,
    type IQDDisplayPreference
} from '@/local-db'
import { getCommissionEntryMode } from '@/local-db/commissionMode'
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
import {
    commissionEntryOrderReference,
    commissionStatusClass,
    commissionStatusLabel,
    formatCommissionPlanTerms,
    summarizeCommissionEntries
} from './agentCommissionPresentation'
import { useCommissionAgentDirectory } from './useCommissionAgentDirectory'

export function AgentCommissionPerformanceCard({
    workspaceId,
    agentId,
    iqdPreference,
    startDate,
    endDate
}: {
    workspaceId: string
    agentId: string
    iqdPreference: IQDDisplayPreference
    startDate?: string
    endDate?: string
}) {
    const { t } = useTranslation()
    const directory = useCommissionAgentDirectory(workspaceId)
    const allEntries = useAgentCommissionEntries(workspaceId)
    const allProductEntries = useAgentProductCommissionEntries(workspaceId)
    const assignments = useSalesOrderAgentAssignments(workspaceId)
    const salesOrders = useSalesOrders(workspaceId)
    const orderNumberById = useMemo(
        () => new Map(salesOrders.map((order) => [order.id, order.orderNumber])),
        [salesOrders]
    )
    const agent = directory.agentById.get(agentId)
    const entries = useMemo(() => allEntries
        .filter((entry) => {
            if (entry.agentId !== agentId || entry.isDeleted) return false
            if (startDate && entry.occurredAt < startDate) return false
            if (endDate && entry.occurredAt >= endDate) return false
            return true
        })
        .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime()),
    [agentId, allEntries, endDate, startDate])
    const summary = useMemo(() => summarizeCommissionEntries(entries), [entries])
    const trackedSummary = useMemo(() => summarizeCommissionEntries(entries, 'tracked'), [entries])
    const productCommissionTotals = useMemo(() => allProductEntries
        .filter((entry) => entry.agentId === agentId && !entry.isDeleted
            && getCommissionEntryMode(entry) === 'payable'
            && (!startDate || entry.occurredAt >= startDate)
            && (!endDate || entry.occurredAt < endDate))
        .reduce<Record<string, number>>((totals, entry) => {
            totals[entry.currency] = (totals[entry.currency] || 0) + Number(entry.amount || 0)
            return totals
        }, {}), [agentId, allProductEntries, endDate, startDate])
    const entriesByOrderId = useMemo(() => {
        const rows = new Map<string, typeof allEntries>()
        for (const entry of allEntries) {
            if (!entry.orderId || entry.agentId !== agentId || entry.isDeleted) continue
            const current = rows.get(entry.orderId) || []
            current.push(entry)
            rows.set(entry.orderId, current)
        }
        return rows
    }, [agentId, allEntries])
    const assignmentByOrderId = useMemo(() => {
        const selected = new Map<string, (typeof assignments)[number]>()
        for (const assignment of assignments) {
            if (assignment.agentId !== agentId || assignment.isDeleted) continue
            const isRecognizedHistory = !assignment.unassignedAt || (entriesByOrderId.get(assignment.orderId) || [])
                .some((entry) => entry.assignmentId === assignment.id)
            if (!isRecognizedHistory) continue
            const current = selected.get(assignment.orderId)
            const hasAccrual = (entriesByOrderId.get(assignment.orderId) || [])
                .some((entry) => entry.assignmentId === assignment.id && entry.kind === 'accrual')
            const currentHasAccrual = current
                ? (entriesByOrderId.get(current.orderId) || [])
                    .some((entry) => entry.assignmentId === current.id && entry.kind === 'accrual')
                : false
            if (
                !current
                || (hasAccrual && !currentHasAccrual)
                || (!assignment.unassignedAt && Boolean(current.unassignedAt))
                || (Boolean(assignment.unassignedAt) === Boolean(current.unassignedAt)
                    && assignment.assignedAt > current.assignedAt)
            ) {
                selected.set(assignment.orderId, assignment)
            }
        }
        return selected
    }, [agentId, assignments, entriesByOrderId])
    const assignedOrders = useMemo(() => salesOrders
        .filter((order) => {
            if (!assignmentByOrderId.has(order.id) || order.isDeleted) return false
            if (startDate && order.createdAt < startDate) return false
            if (endDate && order.createdAt >= endDate) return false
            return true
        })
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [assignmentByOrderId, endDate, salesOrders, startDate])
    const commissionBasisTotals = useMemo(() => assignedOrders.reduce<Record<string, number>>((totals, order) => {
        const assignment = assignmentByOrderId.get(order.id)
        const sourceEntry = (entriesByOrderId.get(order.id) || []).find((entry) => (
            entry.kind === 'accrual' && entry.assignmentId === assignment?.id
        ))
        if (!assignment || !sourceEntry) return totals
        // A commission entry is an immutable event snapshot. Recalculating
        // from today's order costs, delivery figures, or plan revision made
        // historical performance drift after an order was edited or returned.
        totals[sourceEntry.currency] = (totals[sourceEntry.currency] || 0) + sourceEntry.basisAmount
        return totals
    }, {}), [assignmentByOrderId, assignedOrders, entriesByOrderId])
    const completedOrderCount = assignedOrders.filter((order) => order.status === 'completed').length
    const openOrderCount = assignedOrders.filter((order) => order.status === 'draft' || order.status === 'pending').length
    const cancelledOrderCount = assignedOrders.filter((order) => order.status === 'cancelled').length
    const returnedOrderCount = assignedOrders.filter((order) => order.returnStatus === 'partial' || order.returnStatus === 'full').length
    const zeroValueOrderCount = assignedOrders.filter((order) => order.total <= 0).length

    return (
        <Card className="border-violet-500/20 bg-violet-500/[0.02]">
            <CardHeader className="space-y-1">
                <CardTitle className="flex flex-wrap items-center gap-2">
                    <BadgePercent className="h-5 w-5 text-violet-600" />
                    {t('salesAgentCommissions.performance')}
                    {agent?.plan ? (
                        <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                            {agent.plan.name} · {formatCommissionPlanTerms(agent.plan, iqdPreference)}
                        </Badge>
                    ) : null}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                    {t('salesAgentCommissions.performanceDescription')}
                </p>
            </CardHeader>
            <CardContent className="space-y-5">
                {!agent?.membership ? (
                    <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-sm text-amber-800 dark:text-amber-200">
                        {t('salesAgentCommissions.noPlanPerformanceNotice')}
                    </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
                    <PerformanceMetric label={t('salesAgentCommissions.assignedOrders')} icon={ReceiptText} value={String(assignedOrders.length)} />
                    <PerformanceMetric label={t('salesAgentCommissions.payableCommission')} icon={BadgeCheck} value={<CommissionCurrencyTotalsView totals={summary.earned} iqdPreference={iqdPreference} />} />
                    <PerformanceMetric label={t('salesAgentCommissions.trackedTotal')} icon={BadgeDollarSign} value={<CommissionCurrencyTotalsView totals={trackedSummary.earned} iqdPreference={iqdPreference} />} />
                    <PerformanceMetric label={t('salesAgentCommissions.approved')} icon={BadgePercent} value={<CommissionCurrencyTotalsView totals={summary.approved} iqdPreference={iqdPreference} />} />
                    <PerformanceMetric
                        label={t('salesAgentCommissions.paidReversed')}
                        icon={RotateCcw}
                        value={(
                            <span className="flex flex-col gap-0.5">
                                <CommissionCurrencyTotalsView totals={summary.paid} iqdPreference={iqdPreference} />
                                <span className="text-xs text-rose-600"><CommissionCurrencyTotalsView totals={summary.reversed} iqdPreference={iqdPreference} /></span>
                            </span>
                        )}
                    />
                    <PerformanceMetric label={t('salesAgentCommissions.due')} icon={CircleDollarSign} value={<CommissionCurrencyTotalsView totals={summary.due} iqdPreference={iqdPreference} />} />
                    <PerformanceMetric label={t('salesAgentCommissions.productCommission.earned')} icon={BadgePercent} value={<CommissionCurrencyTotalsView totals={productCommissionTotals} iqdPreference={iqdPreference} />} />
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                    <OperationalMetric label={t('salesAgentCommissions.completed')} value={completedOrderCount} tone="emerald" />
                    <OperationalMetric label={t('salesAgentCommissions.openIncomplete')} value={openOrderCount} tone="amber" />
                    <OperationalMetric label={t('salesAgentCommissions.cancelled')} value={cancelledOrderCount} tone="rose" />
                    <OperationalMetric label={t('salesAgentCommissions.returned')} value={returnedOrderCount} tone="orange" />
                    <OperationalMetric label={t('salesAgentCommissions.zeroValue')} value={zeroValueOrderCount} />
                    <div className="rounded-2xl border bg-background/80 p-4">
                        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('salesAgentCommissions.profitCommissionBasis')}</div>
                        <div className="mt-2 text-sm font-black">
                            <CommissionCurrencyTotalsView totals={commissionBasisTotals} iqdPreference={iqdPreference} />
                        </div>
                    </div>
                </div>

                {assignedOrders.length > 0 ? (
                    <div className="space-y-2">
                        <div>
                            <h3 className="font-semibold">{t('salesAgentCommissions.assignedOrderDetails')}</h3>
                            <p className="text-sm text-muted-foreground">{t('salesAgentCommissions.assignedOrderDetailsDescription')}</p>
                        </div>
                        <div className="overflow-x-auto rounded-2xl border bg-background">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('salesAgentCommissions.order')}</TableHead>
                                        <TableHead>{t('salesAgentCommissions.city')}</TableHead>
                                        <TableHead>{t('salesAgentCommissions.customer')}</TableHead>
                                        <TableHead>{t('salesAgentCommissions.status')}</TableHead>
                                        <TableHead className="text-end">{t('salesAgentCommissions.delivery')}</TableHead>
                                        <TableHead className="text-end">{t('salesAgentCommissions.orderTotal')}</TableHead>
                                        <TableHead className="text-end">{t('salesAgentCommissions.basis')}</TableHead>
                                        <TableHead className="text-end">{t('salesAgentCommissions.commission')}</TableHead>
                                        <TableHead className="text-end">{t('salesAgentCommissions.productCommission.total')}</TableHead>
                                        <TableHead className="text-end">{t('salesAgentCommissions.action')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {assignedOrders.slice(0, 10).map((order) => {
                                        const assignment = assignmentByOrderId.get(order.id)
                                        const orderEntries = (entriesByOrderId.get(order.id) || [])
                                            .filter((entry) => entry.assignmentId === assignment?.id)
                                        const recognizedEntries = orderEntries.filter((entry) => ['accrual', 'reversal', 'adjustment'].includes(entry.kind))
                                        const commissionAmount = recognizedEntries.reduce((total, entry) => total + entry.amount, 0)
                                        const sourceEntry = recognizedEntries.find((entry) => (
                                            entry.kind === 'accrual' && entry.assignmentId === assignment?.id
                                        ))
                                        const historicalBasisAmount = sourceEntry?.basisAmount ?? null
                                        const productCommissionAmount = allProductEntries
                                            .filter((entry) => entry.assignmentId === assignment?.id && entry.orderId === order.id && !entry.isDeleted)
                                            .reduce((total, entry) => total + Number(entry.amount || 0), 0)
                                        return (
                                            <TableRow key={order.id}>
                                                <TableCell className="font-semibold">{order.orderNumber}</TableCell>
                                                <TableCell>{assignment?.customerCitySnapshot || '—'}</TableCell>
                                                <TableCell>{order.customerName}</TableCell>
                                                <TableCell>
                                                    <div className="flex flex-wrap gap-1">
                                                        <Badge variant="outline">{t(`orders.status.${order.status}`, { defaultValue: order.status })}</Badge>
                                                        {order.commissionMode === 'tracked' ? (
                                                            <>
                                                                <Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                                                                    {t('salesAgentCommissions.trackedCommission')}
                                                                </Badge>
                                                                <Badge variant="secondary">{t('salesAgentCommissions.nonpayable')}</Badge>
                                                            </>
                                                        ) : null}
                                                        {order.returnStatus && order.returnStatus !== 'none' ? (
                                                            <Badge variant="outline" className="border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300">
                                                                {order.returnStatus === 'full' ? t('salesAgentCommissions.returned') : t('salesAgentCommissions.partialReturn')}
                                                            </Badge>
                                                        ) : null}
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-end">{formatCurrency(assignment?.deliveryChargeAmount || 0, order.currency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end font-semibold">{formatCurrency(order.total, order.currency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{historicalBasisAmount !== null && sourceEntry ? formatCurrency(historicalBasisAmount, sourceEntry.currency as CurrencyCode, iqdPreference) : '—'}</TableCell>
                                                <TableCell className="text-end font-black">{orderEntries.length > 0 && sourceEntry ? formatCurrency(commissionAmount, sourceEntry.currency as CurrencyCode, iqdPreference) : '—'}</TableCell>
                                                <TableCell className="text-end font-bold">{productCommissionAmount !== 0 && sourceEntry ? formatCurrency(productCommissionAmount, sourceEntry.currency as CurrencyCode, iqdPreference) : '—'}</TableCell>
                                                <TableCell className="text-end">
                                                    <Button asChild variant="ghost" size="sm">
                                                        <Link href={`/orders/${order.id}`}>
                                                            <Eye className="me-1.5 h-3.5 w-3.5" /> {t('salesAgentCommissions.view')}
                                                        </Link>
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    </div>
                ) : null}

                {entries.length > 0 ? (
                    <div className="overflow-x-auto rounded-2xl border bg-background">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('salesAgentCommissions.date')}</TableHead>
                                    <TableHead>{t('salesAgentCommissions.order')}</TableHead>
                                    <TableHead>{t('salesAgentCommissions.status')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.basis')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.rate')}</TableHead>
                                    <TableHead className="text-end">{t('salesAgentCommissions.commission')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {entries.slice(0, 8).map((entry) => (
                                    <TableRow key={entry.id}>
                                        <TableCell>{formatDateTime(entry.occurredAt)}</TableCell>
                                        <TableCell className="font-medium">{commissionEntryOrderReference(entry, orderNumberById)}</TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1">
                                                <Badge variant="outline" className={commissionStatusClass(entry.status)}>
                                                    {commissionStatusLabel(entry.status, t)}
                                                </Badge>
                                                {getCommissionEntryMode(entry) === 'tracked' ? (
                                                    <>
                                                        <Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                                                            {t('salesAgentCommissions.trackedCommission')}
                                                        </Badge>
                                                        <Badge variant="secondary">{t('salesAgentCommissions.nonpayable')}</Badge>
                                                    </>
                                                ) : null}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-end">{formatCurrency(entry.basisAmount, entry.currency as CurrencyCode, iqdPreference)}</TableCell>
                                        <TableCell className="text-end">{entry.ratePercent}%</TableCell>
                                        <TableCell className="text-end font-black">{formatCurrency(entry.amount, entry.currency as CurrencyCode, iqdPreference)}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                ) : (
                    <div className="rounded-2xl border border-dashed py-8 text-center text-sm text-muted-foreground">
                        {t('salesAgentCommissions.entriesEmpty')}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

function OperationalMetric({
    label,
    value,
    tone
}: {
    label: string
    value: number
    tone?: 'emerald' | 'amber' | 'rose' | 'orange'
}) {
    const toneClass = tone === 'emerald'
        ? 'text-emerald-700 dark:text-emerald-300'
        : tone === 'amber'
            ? 'text-amber-700 dark:text-amber-300'
            : tone === 'rose'
                ? 'text-rose-700 dark:text-rose-300'
                : tone === 'orange'
                    ? 'text-orange-700 dark:text-orange-300'
                    : ''
    return (
        <div className="rounded-2xl border bg-background/80 p-4">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
            <div className={`mt-2 text-2xl font-black ${toneClass}`}>{value}</div>
        </div>
    )
}

function PerformanceMetric({
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
