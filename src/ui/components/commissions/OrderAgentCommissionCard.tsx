import { useMemo } from 'react'
import { BadgeDollarSign, BadgePercent, HandCoins, MapPin, Truck, UserRoundCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatCurrency, formatDateTime } from '@/lib/utils'
import {
    getActiveSalesOrderAgentAssignments,
    useAgentCommissionEntries,
    useAgentProductCommissionEntries,
    useSalesOrderAgentAssignments,
    useSalesOrder,
    type CurrencyCode,
    type IQDDisplayPreference,
    type PaymentObligation
} from '@/local-db'
import { getCommissionEntryMode, getSalesOrderCommissionMode } from '@/local-db/commissionMode'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/ui/components'
import { commissionStatusClass, commissionStatusLabel, formatCommissionPlanTerms } from './agentCommissionPresentation'
import { useCommissionAgentDirectory } from './useCommissionAgentDirectory'

export function OrderAgentCommissionCard({
    workspaceId,
    orderId,
    iqdPreference,
    orderCurrency,
    canAssign,
    canViewAllCommission,
    canViewOwnCommission,
    canPayCommission,
    onSettleCommission,
    userId
}: {
    workspaceId: string
    orderId: string
    iqdPreference: IQDDisplayPreference
    orderCurrency: CurrencyCode
    canAssign: boolean
    canViewAllCommission: boolean
    canViewOwnCommission: boolean
    canPayCommission: boolean
    onSettleCommission: (obligation: PaymentObligation) => void
    userId?: string | null
}) {
    const { t } = useTranslation()
    const assignments = useSalesOrderAgentAssignments(workspaceId)
    const order = useSalesOrder(orderId)
    const commissionMode = order ? getSalesOrderCommissionMode(order) : 'payable'
    const isTrackedCommission = commissionMode === 'tracked'
    const entries = useAgentCommissionEntries(workspaceId)
    const productEntries = useAgentProductCommissionEntries(workspaceId)
    const directory = useCommissionAgentDirectory(workspaceId)
    const activeAssignments = getActiveSalesOrderAgentAssignments(assignments, orderId)
    const visibleAssignments = activeAssignments.filter((candidate) => {
        const candidateAgent = directory.agentById.get(candidate.agentId)
        return canViewAllCommission || (canViewOwnCommission && Boolean(userId) && candidateAgent?.agent.linkedUserId === userId)
    })
    const displayedAssignments = canAssign || canViewAllCommission ? activeAssignments : visibleAssignments
    const canViewAssignment = canAssign || canViewAllCommission || visibleAssignments.length > 0
    const orderEntries = useMemo(() => entries
        .filter((entry) => !entry.isDeleted && entry.orderId === orderId && getCommissionEntryMode(entry) === commissionMode)
        .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime()),
    [commissionMode, entries, orderId])

    if (!canViewAssignment) return null

    return (
        <Card className="border-violet-500/20 bg-violet-500/[0.02]">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <UserRoundCheck className="h-5 w-5 text-violet-600" />
                    {activeAssignments.length > 1
                        ? t('salesAgentCommissions.salesAgentBeneficiaries')
                        : t('salesAgentCommissions.salesAgent')}
                    {isTrackedCommission ? (
                        <>
                            <Badge variant="outline" className="gap-1 border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                                <BadgeDollarSign className="h-3.5 w-3.5" />
                                {t('salesAgentCommissions.trackedCommission')}
                            </Badge>
                            <Badge variant="secondary">{t('salesAgentCommissions.nonpayable')}</Badge>
                            <Badge variant="outline">
                                {order?.status === 'completed'
                                    ? t('salesAgentCommissions.final')
                                    : t('salesAgentCommissions.projected')}
                            </Badge>
                        </>
                    ) : null}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
                    {displayedAssignments.length > 0 ? (
                        <div className="grid gap-3">
                            {displayedAssignments.map((assignment) => {
                                const assignedAgent = directory.agentById.get(assignment.agentId)
                                const canViewCommission = canViewAllCommission
                                    || (canViewOwnCommission && Boolean(userId) && assignedAgent?.agent.linkedUserId === userId)
                                const assignmentEntries = orderEntries.filter((entry) => entry.assignmentId === assignment.id)
                                const assignmentProductEntries = productEntries
                                    .filter((entry) => !entry.isDeleted
                                        && entry.assignmentId === assignment.id
                                        && entry.orderId === orderId
                                        && getCommissionEntryMode(entry) === commissionMode)
                                    .sort((left, right) => left.productNameSnapshot.localeCompare(right.productNameSnapshot))
                                const sourceEntry = assignmentEntries.find((entry) => entry.kind === 'accrual')
                                const latestEntry = assignmentEntries[0]
                                const commissionAmount = assignmentEntries
                                    .filter((entry) => ['accrual', 'reversal', 'adjustment'].includes(entry.kind))
                                    .reduce((total, entry) => total + Number(entry.amount || 0), 0)
                                const outstandingAmount = isTrackedCommission ? 0 : assignmentEntries
                                    .filter((entry) => entry.kind !== 'estimate' && entry.kind !== 'approval')
                                    .reduce((total, entry) => total + Number(entry.amount || 0), 0)
                                const currency = (sourceEntry?.currency || latestEntry?.currency || orderCurrency) as CurrencyCode
                                const partner = assignedAgent?.partner
                                const commissionObligation: PaymentObligation | null = !isTrackedCommission && partner && Math.abs(outstandingAmount) > 0.000001
                                    ? {
                                        id: `agent-commission:${assignment.agentId}:${assignment.id}:${currency}`,
                                        workspaceId,
                                        sourceModule: 'orders',
                                        sourceType: outstandingAmount > 0 ? 'agent_commission_payout' : 'agent_commission_recovery',
                                        sourceRecordId: orderId,
                                        sourceSubrecordId: assignment.id,
                                        direction: outstandingAmount > 0 ? 'outgoing' : 'incoming',
                                        amount: Math.abs(outstandingAmount),
                                        currency,
                                        dueDate: (sourceEntry?.occurredAt || latestEntry?.occurredAt || new Date().toISOString()).slice(0, 10),
                                        createdAt: sourceEntry?.occurredAt,
                                        counterpartyName: partner.partnerName,
                                        referenceLabel: orderId,
                                        title: partner.partnerName,
                                        subtitle: orderId,
                                        status: 'open',
                                        routePath: `/orders/${orderId}`,
                                        metadata: {
                                            businessPartnerId: partner.id,
                                            agentId: assignment.agentId,
                                            commissionAssignmentId: assignment.id,
                                            orderId
                                        }
                                    }
                                    : null
                                return (
                                    <div key={assignment.id} className="space-y-3 rounded-2xl border bg-background/50 p-4">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div>
                                                <div className="font-semibold">{assignedAgent?.name || t('salesAgentCommissions.assignedFieldAgent')}</div>
                                                <div className="mt-1 text-xs text-muted-foreground">{t('salesAgentCommissions.assignedAt', { date: formatDateTime(assignment.assignedAt) })}</div>
                                            </div>
                                            {assignedAgent?.plan ? (
                                                <Badge variant="outline" className="gap-1.5 border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                                                    <BadgePercent className="h-3.5 w-3.5" />
                                                    {assignedAgent.plan.name} · {formatCommissionPlanTerms(assignedAgent.plan, iqdPreference)}
                                                </Badge>
                                            ) : (
                                                <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                                                    {t('salesAgentCommissions.noCommissionPlan')}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="grid gap-3">
                                            <div className="rounded-xl border bg-background/70 p-3">
                                                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                                    <MapPin className="h-3.5 w-3.5" /> {t('salesAgentCommissions.customerCity')}
                                                </div>
                                                <div className="mt-1 font-medium">{assignment.customerCitySnapshot || '—'}</div>
                                            </div>
                                            <div className="rounded-xl border bg-background/70 p-3">
                                                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                                    <Truck className="h-3.5 w-3.5" /> {t('salesAgentCommissions.deliverySnapshot')}
                                                </div>
                                                <div className="mt-2 flex items-center justify-between gap-2">
                                                    <span className="text-muted-foreground">{t('salesAgentCommissions.customerCharge')}</span>
                                                    <span className="font-semibold">{formatCurrency(assignment.deliveryChargeAmount, currency, iqdPreference)}</span>
                                                </div>
                                                <div className="mt-1 flex items-center justify-between gap-2">
                                                    <span className="text-muted-foreground">{t('salesAgentCommissions.internalCost')}</span>
                                                    <span className="font-semibold">{formatCurrency(assignment.internalDeliveryCostAmount, currency, iqdPreference)}</span>
                                                </div>
                                            </div>
                                        </div>
                                        {canViewCommission ? (sourceEntry ? (
                                            <div className="rounded-xl border bg-background/80 p-3">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <Badge variant="outline" className={commissionStatusClass(latestEntry?.status || sourceEntry.status)}>
                                                        {commissionStatusLabel(latestEntry?.status || sourceEntry.status, t)}
                                                    </Badge>
                                                    <div className="text-end">
                                                        <div className="text-xs text-muted-foreground">{t('salesAgentCommissions.commissionAmount')}</div>
                                                        <div className="mt-1 font-black">{formatCurrency(commissionAmount, currency, iqdPreference)}</div>
                                                    </div>
                                                </div>
                                                <div className="mt-3 grid gap-3 text-xs">
                                                    {!isTrackedCommission && Math.abs(outstandingAmount - commissionAmount) > 0.000001 ? (
                                                        <div>
                                                            <div className="text-muted-foreground">{t('salesAgentCommissions.due')}</div>
                                                            <div className="mt-1 font-semibold">{formatCurrency(outstandingAmount, currency, iqdPreference)}</div>
                                                        </div>
                                                    ) : null}
                                                    {!isTrackedCommission && canPayCommission && commissionObligation ? (
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant={commissionObligation.direction === 'incoming' ? 'outline' : 'default'}
                                                            className="w-full gap-2"
                                                            onClick={() => onSettleCommission(commissionObligation)}
                                                        >
                                                            <HandCoins className="h-4 w-4" />
                                                            {commissionObligation.direction === 'incoming'
                                                                ? t('salesAgentCommissions.collectRecovery')
                                                                : t('salesAgentCommissions.payCommission')}
                                                        </Button>
                                                    ) : null}
                                                    <div>
                                                        <div className="text-muted-foreground">{t('salesAgentCommissions.commissionBasis')}</div>
                                                        <div className="mt-1 font-semibold">{formatCurrency(sourceEntry.basisAmount, currency, iqdPreference)}</div>
                                                    </div>
                                                    <div>
                                                        <div className="text-muted-foreground">{t('salesAgentCommissions.rateSnapshot')}</div>
                                                        <div className="mt-1 font-semibold">{sourceEntry.ratePercent}%</div>
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                                                {t('salesAgentCommissions.lifecycleHint')}
                                            </div>
                                        )) : null}
                                        {canViewCommission && assignmentProductEntries.length > 0 ? (
                                            <div className="space-y-2 rounded-xl border border-violet-500/20 bg-violet-500/[0.035] p-3">
                                                <div className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
                                                    {t('salesAgentCommissions.productCommission.orderBreakdown')}
                                                </div>
                                                {assignmentProductEntries.map((entry) => (
                                                    <div key={entry.id} className="flex items-center justify-between gap-3 text-sm">
                                                        <div className="min-w-0">
                                                            <div className="truncate font-medium">{entry.productNameSnapshot}</div>
                                                            <div className="text-xs text-muted-foreground">
                                                                {entry.quantity} × {formatCurrency(entry.commissionPerUnit, entry.currency, iqdPreference)}
                                                            </div>
                                                        </div>
                                                        <div className={entry.amount < 0 ? 'font-bold text-destructive' : 'font-bold'}>{formatCurrency(entry.amount, entry.currency, iqdPreference)}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">
                            {t('salesAgentCommissions.noSellingAgent')}
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground">{t('salesAgentCommissions.postServiceOptional')}</p>
            </CardContent>
        </Card>
    )
}
