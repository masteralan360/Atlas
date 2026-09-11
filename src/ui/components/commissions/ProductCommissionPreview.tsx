import { CircleCheck, Clock3, HandCoins, PackageCheck, RotateCcw, UserRound } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
    activeProductCommissionRule,
    type CurrencyCode,
    type ExchangeRateSnapshot,
    type AgentCommissionEntry,
    type PaymentObligation,
    type ProductCommissionRule,
    type ProductCommissionRuleAgent,
    useAgentCommissionEntries,
    useProductCommissionRuleAgents,
    useProductCommissionRules
} from '@/local-db'
import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/ui/components/button'
import { useCommissionAgentDirectory } from './useCommissionAgentDirectory'

export type ProductCommissionPreviewItem = {
    id?: string
    productId: string
    productName: string
    quantity: number
    convertedUnitPrice?: number
    lineTotal?: number
}

export type ProductCommissionPreviewAgent = {
    id: string
    name: string
}

type ProductCommissionPreviewRow = {
    total: number
    unavailableConversion: boolean
}

type ProductCommissionBalance = {
    id: string
    agentId: string
    assignmentId: string
    currency: CurrencyCode
    commissionAmount: number
    paidAmount: number
    recoveredAmount: number
    outstandingAmount: number
    occurredAt: string
}

type ProductCommissionSettlementAgent = {
    id: string
    name: string
    businessPartnerId: string
    businessPartnerName: string
}

export type ProductCommissionSettlementAction = {
    id: string
    agentId: string
    agentName: string
    obligation: PaymentObligation
}

type ProductCommissionPaymentStatus = 'unpaid' | 'partial' | 'paid' | 'recovery_due' | 'recovered' | 'reversed'

export type ProductCommissionPaymentSummary = ProductCommissionBalance & {
    agentName: string
    status: ProductCommissionPaymentStatus
}

const COMMISSION_EPSILON = 0.000001

function roundCommissionAmount(amount: number) {
    return Math.round(amount * 1_000_000) / 1_000_000
}

function buildProductCommissionBalances({
    orderId,
    agentIds,
    entries
}: {
    orderId: string
    agentIds: readonly string[]
    entries: readonly AgentCommissionEntry[]
}) {
    const selectedAgentIds = new Set(agentIds)
    const balances = new Map<string, ProductCommissionBalance>()

    for (const entry of entries) {
        if (
            entry.isDeleted
            || entry.orderId !== orderId
            || !entry.assignmentId
            || entry.kind === 'estimate'
            || entry.kind === 'approval'
            || !selectedAgentIds.has(entry.agentId)
        ) {
            continue
        }

        const amount = Number(entry.amount || 0)
        if (!Number.isFinite(amount)) continue

        const currency = entry.currency.toLowerCase() as CurrencyCode
        const id = `${entry.agentId}:${entry.assignmentId}:${currency}`
        const balance = balances.get(id) || {
            id,
            agentId: entry.agentId,
            assignmentId: entry.assignmentId,
            currency,
            commissionAmount: 0,
            paidAmount: 0,
            recoveredAmount: 0,
            outstandingAmount: 0,
            occurredAt: entry.occurredAt
        }

        balance.outstandingAmount += amount
        if (entry.kind === 'payout') {
            balance.paidAmount += Math.abs(amount)
        } else if (entry.kind === 'recovery') {
            balance.recoveredAmount += Math.abs(amount)
        } else {
            balance.commissionAmount += amount
        }
        if (entry.occurredAt < balance.occurredAt) balance.occurredAt = entry.occurredAt
        balances.set(id, balance)
    }

    return [...balances.values()].map((balance) => ({
        ...balance,
        commissionAmount: roundCommissionAmount(balance.commissionAmount),
        paidAmount: roundCommissionAmount(balance.paidAmount),
        recoveredAmount: roundCommissionAmount(balance.recoveredAmount),
        outstandingAmount: roundCommissionAmount(balance.outstandingAmount)
    }))
}

function productCommissionPaymentStatus(balance: ProductCommissionBalance): ProductCommissionPaymentStatus {
    if (balance.outstandingAmount > COMMISSION_EPSILON) {
        return balance.paidAmount > COMMISSION_EPSILON ? 'partial' : 'unpaid'
    }
    if (balance.outstandingAmount < -COMMISSION_EPSILON) return 'recovery_due'
    if (balance.paidAmount > COMMISSION_EPSILON) return 'paid'
    if (balance.recoveredAmount > COMMISSION_EPSILON) return 'recovered'
    return 'reversed'
}

/** Final per-agent payment state for a product commission in one order. */
export function buildProductCommissionPaymentSummaries({
    orderId,
    agentIds,
    agents,
    entries
}: {
    orderId: string
    agentIds: readonly string[]
    agents: readonly ProductCommissionPreviewAgent[]
    entries: readonly AgentCommissionEntry[]
}): ProductCommissionPaymentSummary[] {
    const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]))

    return buildProductCommissionBalances({ orderId, agentIds, entries })
        .sort((left, right) => (
            (agentNameById.get(left.agentId) || '').localeCompare(agentNameById.get(right.agentId) || '')
            || left.assignmentId.localeCompare(right.assignmentId)
            || left.currency.localeCompare(right.currency)
        ))
        .map((balance) => ({
            ...balance,
            agentName: agentNameById.get(balance.agentId) || balance.agentId,
            status: productCommissionPaymentStatus(balance)
        }))
}

/**
 * Product commission rows explain what was earned for each product. The
 * aggregate commission ledger is the payment source of truth because it also
 * contains payouts, returns, and other order-level adjustments.
 */
export function buildProductCommissionSettlementActions({
    workspaceId,
    orderId,
    orderReference,
    agentIds,
    agents,
    entries
}: {
    workspaceId: string
    orderId: string
    orderReference: string
    agentIds: readonly string[]
    agents: readonly ProductCommissionSettlementAgent[]
    entries: readonly AgentCommissionEntry[]
}): ProductCommissionSettlementAction[] {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
    return buildProductCommissionBalances({ orderId, agentIds, entries })
        .filter((balance) => Math.abs(balance.outstandingAmount) > COMMISSION_EPSILON)
        .sort((left, right) => (
            (agentsById.get(left.agentId)?.name || '').localeCompare(agentsById.get(right.agentId)?.name || '')
            || left.assignmentId.localeCompare(right.assignmentId)
            || left.currency.localeCompare(right.currency)
        ))
        .flatMap((balance) => {
            const agent = agentsById.get(balance.agentId)
            if (!agent) return []
            const isPayout = balance.outstandingAmount > 0
            const obligation: PaymentObligation = {
                id: `agent-commission:${agent.id}:${balance.assignmentId}:${balance.currency}`,
                workspaceId,
                sourceModule: 'orders',
                sourceType: isPayout ? 'agent_commission_payout' : 'agent_commission_recovery',
                sourceRecordId: orderId,
                sourceSubrecordId: balance.assignmentId,
                direction: isPayout ? 'outgoing' : 'incoming',
                amount: Math.abs(balance.outstandingAmount),
                currency: balance.currency,
                dueDate: balance.occurredAt.slice(0, 10),
                createdAt: balance.occurredAt,
                counterpartyName: agent.businessPartnerName,
                referenceLabel: orderReference,
                title: agent.businessPartnerName,
                subtitle: orderReference,
                status: 'open',
                routePath: `/orders/${orderId}`,
                metadata: {
                    businessPartnerId: agent.businessPartnerId,
                    agentId: agent.id,
                    commissionAssignmentId: balance.assignmentId,
                    orderId
                }
            }
            return {
                id: balance.id,
                agentId: agent.id,
                agentName: agent.name,
                obligation
            }
        })
}

/** A total is only meaningful when every qualifying line has an exchange rate. */
export function getProductCommissionPreviewTotal(rows: readonly ProductCommissionPreviewRow[]) {
    if (rows.some((row) => row.unavailableConversion)) return null
    return rows.reduce((sum, row) => sum + row.total, 0)
}

/** True when at least one selected beneficiary qualifies for a cart line. */
export function hasEligibleProductCommission({
    items,
    agentIds,
    rules,
    recipients,
    at
}: {
    items: readonly ProductCommissionPreviewItem[]
    agentIds: readonly string[]
    rules: readonly ProductCommissionRule[]
    recipients: readonly ProductCommissionRuleAgent[]
    at: string
}) {
    const selectedAgentIds = [...new Set(agentIds.filter(Boolean))]
    return items.some((item) => {
        if (Number(item.quantity || 0) <= 0) return false
        const rule = activeProductCommissionRule(rules, item.productId, at)
        if (!rule) return false
        return rule.recipientScope === 'all_assigned'
            ? selectedAgentIds.length > 0
            : selectedAgentIds.some((agentId) => recipients.some((recipient) => (
                recipient.ruleId === rule.id && recipient.agentId === agentId
            )))
    })
}

function paymentStatusLabel(status: ProductCommissionPaymentStatus, t: (key: string) => string) {
    switch (status) {
        case 'unpaid': return t('salesAgentCommissions.productCommission.paymentStatusUnpaid')
        case 'partial': return t('salesAgentCommissions.productCommission.paymentStatusPartial')
        case 'paid': return t('salesAgentCommissions.productCommission.paymentStatusPaid')
        case 'recovery_due': return t('salesAgentCommissions.productCommission.paymentStatusRecoveryDue')
        case 'recovered': return t('salesAgentCommissions.productCommission.paymentStatusRecovered')
        case 'reversed': return t('salesAgentCommissions.reversed')
    }
}

function paymentStatusClass(status: ProductCommissionPaymentStatus) {
    switch (status) {
        case 'unpaid': return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        case 'partial': return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
        case 'paid': return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        case 'recovery_due': return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
        case 'recovered': return 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
        case 'reversed': return 'border-muted-foreground/30 bg-muted text-muted-foreground'
    }
}

function PaymentStatusIcon({ status }: { status: ProductCommissionPaymentStatus }) {
    const className = 'h-3 w-3'
    if (status === 'paid' || status === 'recovered') return <CircleCheck className={className} />
    if (status === 'recovery_due' || status === 'reversed') return <RotateCcw className={className} />
    if (status === 'partial') return <HandCoins className={className} />
    return <Clock3 className={className} />
}

/** Read-only form/POS preview. Final amounts are locked at completion. */
export function ProductCommissionPreview({
    workspaceId,
    items,
    agentIds,
    agents = [],
    currency,
    exchangeRates,
    iqdPreference,
    showTotal = false,
    orderId,
    orderReference,
    canPayCommission = false,
    onSettleCommission
}: {
    workspaceId: string
    items: ProductCommissionPreviewItem[]
    agentIds: string[]
    agents?: ProductCommissionPreviewAgent[]
    currency: CurrencyCode
    exchangeRates: ExchangeRateSnapshot[]
    iqdPreference: 'IQD' | 'د.ع'
    showTotal?: boolean
    /** Enables the order-detail settlement action without affecting form/POS previews. */
    orderId?: string
    orderReference?: string
    canPayCommission?: boolean
    onSettleCommission?: (obligation: PaymentObligation) => void
}) {
    const { t } = useTranslation()
    const rules = useProductCommissionRules(workspaceId)
    const recipients = useProductCommissionRuleAgents(workspaceId)
    const commissionEntries = useAgentCommissionEntries(orderId ? workspaceId : undefined)
    const commissionDirectory = useCommissionAgentDirectory(orderId ? workspaceId : undefined)
    const now = new Date().toISOString()
    const agentNameById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents])
    const rows = useMemo(() => items.flatMap((item) => {
        const rule = activeProductCommissionRule(rules, item.productId, now)
        if (!rule || Number(item.quantity || 0) <= 0) return []
        const allowed = rule.recipientScope === 'all_assigned'
            ? agentIds
            : agentIds.filter((agentId) => recipients.some((recipient) => recipient.ruleId === rule.id && recipient.agentId === agentId))
        if (allowed.length === 0) return []
        const basePerUnit = Math.max(0, Number(item.convertedUnitPrice || 0))
        const fixedConversion = rule.commissionType === 'fixed_amount' && rule.fixedCurrency
            ? getAppliedCurrencyConversion(Number(rule.fixedAmount || 0), rule.fixedCurrency, currency, exchangeRates)
            : null
        const unavailableConversion = rule.commissionType === 'fixed_amount' && !fixedConversion
        const perUnit = rule.commissionType === 'fixed_amount'
            ? Number(fixedConversion?.convertedAmount || 0)
            : basePerUnit * Number(rule.ratePercent || 0) / 100
        return allowed.map((agentId) => ({
            item,
            agentId,
            agentName: agentNameById.get(agentId) || t('salesAgentCommissions.salesAgent'),
            perUnit,
            total: perUnit * Number(item.quantity || 0),
            rule,
            unavailableConversion
        }))
    }), [agentIds, agentNameById, currency, exchangeRates, items, now, recipients, rules, t])
    const total = useMemo(() => getProductCommissionPreviewTotal(rows), [rows])
    const paymentSummaries = useMemo(() => (
        orderId
            ? buildProductCommissionPaymentSummaries({
                orderId,
                agentIds,
                agents,
                entries: commissionEntries
            })
            : []
    ), [agentIds, agents, commissionEntries, orderId])
    const settlementAgents = useMemo<ProductCommissionSettlementAgent[]>(() => (
        agentIds.flatMap((agentId) => {
            const entry = commissionDirectory.agentById.get(agentId)
            if (!entry?.partner) return []
            return [{
                id: entry.agent.id,
                name: entry.name,
                businessPartnerId: entry.partner.id,
                businessPartnerName: entry.partner.partnerName
            }]
        })
    ), [agentIds, commissionDirectory.agentById])
    const settlementActions = useMemo(() => {
        if (!orderId || !orderReference || !canPayCommission || !onSettleCommission) return []
        return buildProductCommissionSettlementActions({
            workspaceId,
            orderId,
            orderReference,
            agentIds,
            agents: settlementAgents,
            entries: commissionEntries
        })
    }, [
        agentIds,
        canPayCommission,
        commissionEntries,
        onSettleCommission,
        orderId,
        orderReference,
        settlementAgents,
        workspaceId
    ])
    const settlementActionByPaymentSummaryId = useMemo(() => (
        new Map(settlementActions.map((action) => [action.id, action]))
    ), [settlementActions])

    if (rows.length === 0) return null
    return (
        <div className="space-y-3 rounded-2xl border border-violet-500/25 bg-violet-500/[0.035] p-4">
            <div className="flex items-center gap-2 font-semibold">
                <PackageCheck className="h-4 w-4 text-violet-600" />
                {t('salesAgentCommissions.productCommission.previewTitle')}
            </div>
            <p className="text-xs text-muted-foreground">{t('salesAgentCommissions.productCommission.previewHint')}</p>
            <div className="space-y-2">
                {rows.map(({ item, agentId, agentName, perUnit, total, rule, unavailableConversion }) => (
                    <div key={`${item.id || item.productId}:${rule.id}:${agentId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-background/70 px-3 py-2 text-sm">
                        <div>
                            <div className="font-medium">{item.productName}</div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <UserRound className="h-3 w-3" />
                                <span>{agentName}</span>
                                <span>·</span>
                                <span>{unavailableConversion
                                    ? t('salesAgentCommissions.errors.commissionExchangeRateUnavailable')
                                    : formatCurrency(perUnit, currency, iqdPreference)}</span>
                            </div>
                        </div>
                        <div className="font-bold tabular-nums">{unavailableConversion ? '—' : formatCurrency(total, currency, iqdPreference)}</div>
                    </div>
                ))}
            </div>
            {showTotal ? (
                <div className="flex items-center justify-between border-t pt-3 text-sm">
                    <span className="font-semibold">{t('common.total')}</span>
                    <span className="font-bold tabular-nums">{total === null ? '—' : formatCurrency(total, currency, iqdPreference)}</span>
                </div>
            ) : null}
            {paymentSummaries.length > 0 ? (
                <div className="grid gap-2 border-t pt-3">
                    {paymentSummaries.map((summary) => {
                        const settlementAction = settlementActionByPaymentSummaryId.get(summary.id)
                        const remainingAmount = Math.max(0, summary.outstandingAmount)
                        return (
                            <div key={summary.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/70 p-3 text-sm">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <div className="font-medium">{summary.agentName}</div>
                                        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', paymentStatusClass(summary.status))}>
                                            <PaymentStatusIcon status={summary.status} />
                                            {paymentStatusLabel(summary.status, t)}
                                        </span>
                                    </div>
                                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                        <span>{t('salesAgentCommissions.productCommission.paidAmount')} · {formatCurrency(summary.paidAmount, summary.currency, iqdPreference)}</span>
                                        {remainingAmount > COMMISSION_EPSILON ? (
                                            <span>{t('salesAgentCommissions.productCommission.remainingAmount')} · {formatCurrency(remainingAmount, summary.currency, iqdPreference)}</span>
                                        ) : null}
                                        {summary.status === 'recovery_due' ? (
                                            <span>{t('salesAgentCommissions.recoveryDue')} · {formatCurrency(Math.abs(summary.outstandingAmount), summary.currency, iqdPreference)}</span>
                                        ) : null}
                                    </div>
                                </div>
                                {settlementAction ? (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant={settlementAction.obligation.direction === 'incoming' ? 'outline' : 'default'}
                                        className="gap-2"
                                        onClick={() => onSettleCommission?.(settlementAction.obligation)}
                                    >
                                        <HandCoins className="h-4 w-4" />
                                        {settlementAction.obligation.direction === 'incoming'
                                            ? t('salesAgentCommissions.collectRecovery')
                                            : t('salesAgentCommissions.payCommission')}
                                    </Button>
                                ) : null}
                            </div>
                        )
                    })}
                </div>
            ) : null}
        </div>
    )
}
