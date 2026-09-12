import type {
    AgentCommissionEntry,
    AgentCommissionMembership,
    AgentCommissionPlan,
    CommissionEntryStatus,
    CommissionPlanLevel
} from '@/local-db'
import { formatCurrency } from '@/lib/utils'

export function formatCommissionPlanTerms(
    plan: Pick<AgentCommissionPlan, 'commissionType' | 'ratePercent' | 'fixedAmount' | 'fixedCurrency'>,
    iqdPreference: 'IQD' | 'د.ع' = 'IQD'
) {
    if (plan.commissionType === 'fixed_amount') {
        return formatCurrency(
            Number(plan.fixedAmount || 0),
            (plan.fixedCurrency || 'usd') as Parameters<typeof formatCurrency>[1],
            iqdPreference
        )
    }
    return `${plan.ratePercent}%`
}

export function getActiveAgentCommissionMembership(
    memberships: AgentCommissionMembership[],
    agentId: string,
    at = new Date()
) {
    const atMs = at.getTime()

    return memberships
        .filter((membership) => {
            if (membership.agentId !== agentId || membership.isDeleted) return false
            const startsAt = new Date(membership.effectiveFrom).getTime()
            const endsAt = membership.effectiveTo ? new Date(membership.effectiveTo).getTime() : Number.POSITIVE_INFINITY
            return startsAt <= atMs && endsAt > atMs
        })
        .sort((left, right) => new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime())[0]
}

export function getCurrentCommissionPlanRevision(
    plans: readonly AgentCommissionPlan[],
    level: CommissionPlanLevel
) {
    const allLevelRevisions = plans
        .filter((plan) => plan.level === level && !plan.isDeleted)
        .sort((left, right) => new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime()
            || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())

    return allLevelRevisions.find((plan) => plan.isActive || plan.effectiveTo == null)
        || allLevelRevisions[0]
}

export type CommissionCurrencyTotals = Record<string, number>

export interface CommissionEntrySummary {
    estimated: CommissionCurrencyTotals
    earned: CommissionCurrencyTotals
    approved: CommissionCurrencyTotals
    /** Gross outgoing commission settlements. */
    paid: CommissionCurrencyTotals
    /** Incoming recoveries of previously paid commission. */
    recovered: CommissionCurrencyTotals
    /** Cash paid to the agent after recoveries are deducted. */
    netPaid: CommissionCurrencyTotals
    reversed: CommissionCurrencyTotals
    due: CommissionCurrencyTotals
    orderCount: number
    entryCount: number
}

export type CommissionHistoryStatus = 'earned' | 'paid' | 'recovered' | 'reversed' | 'outstanding' | 'recovery_due'

/**
 * A review dialog is an operational view, not the accounting journal. Group
 * the append-only events by order and currency so internal reconciliation
 * entries do not look like separate user actions.
 */
export interface CommissionHistoryGroup {
    id: string
    orderId: string | null
    payoutReference: string | null
    currency: string
    entries: AgentCommissionEntry[]
    earned: number
    paid: number
    recovered: number
    reversed: number
    outstanding: number
    status: CommissionHistoryStatus
    occurredAt: string
}

function addCurrencyAmount(totals: CommissionCurrencyTotals, currency: string, amount: number) {
    const normalizedCurrency = currency.toLowerCase()
    totals[normalizedCurrency] = (totals[normalizedCurrency] || 0) + amount
}

export function summarizeCommissionEntries(entries: AgentCommissionEntry[]): CommissionEntrySummary {
    const summary: CommissionEntrySummary = {
        estimated: {},
        earned: {},
        approved: {},
        paid: {},
        recovered: {},
        netPaid: {},
        reversed: {},
        due: {},
        orderCount: 0,
        entryCount: entries.filter((entry) => !entry.isDeleted).length
    }
    const orderIds = new Set<string>()

    const activeEntries = entries.filter((entry) => !entry.isDeleted)
    const entryById = new Map(activeEntries.map((entry) => [entry.id, entry]))
    const approvedSourceIds = new Set(activeEntries
        .filter((entry) => entry.kind === 'approval' && entry.relatedEntryId)
        .map((entry) => entry.relatedEntryId as string))
    const recognizedChildrenBySourceId = new Map<string, AgentCommissionEntry[]>()

    for (const entry of activeEntries) {
        if (!entry.relatedEntryId || (entry.kind !== 'reversal' && entry.kind !== 'adjustment')) continue
        const relatedEntries = recognizedChildrenBySourceId.get(entry.relatedEntryId) || []
        relatedEntries.push(entry)
        recognizedChildrenBySourceId.set(entry.relatedEntryId, relatedEntries)
    }

    for (const entry of activeEntries) {
        if (entry.orderId) orderIds.add(entry.orderId)
        if (entry.kind === 'estimate') {
            addCurrencyAmount(summary.estimated, entry.currency, entry.amount)
        }
        if (entry.kind === 'accrual' || entry.kind === 'reversal' || entry.kind === 'adjustment') {
            addCurrencyAmount(summary.earned, entry.currency, entry.amount)
            addCurrencyAmount(summary.due, entry.currency, entry.amount)
        }
        if (entry.kind === 'reversal') {
            addCurrencyAmount(summary.reversed, entry.currency, entry.amount)
        }
        if (entry.kind === 'payout') {
            addCurrencyAmount(summary.paid, entry.currency, Math.abs(entry.amount))
            addCurrencyAmount(summary.due, entry.currency, entry.amount)
        }
        if (entry.kind === 'recovery') {
            addCurrencyAmount(summary.recovered, entry.currency, entry.amount)
            addCurrencyAmount(summary.due, entry.currency, entry.amount)
        }
    }

    for (const currency of new Set([...Object.keys(summary.paid), ...Object.keys(summary.recovered)])) {
        const netPaid = (summary.paid[currency] || 0) - (summary.recovered[currency] || 0)
        if (Math.abs(netPaid) > 0.000001) summary.netPaid[currency] = netPaid
    }

    const approvedEntryIds = new Set<string>()
    const pendingApprovedEntryIds = [...approvedSourceIds]

    while (pendingApprovedEntryIds.length > 0) {
        const approvedEntryId = pendingApprovedEntryIds.pop() as string
        if (approvedEntryIds.has(approvedEntryId)) continue
        approvedEntryIds.add(approvedEntryId)

        const approvedEntry = entryById.get(approvedEntryId)
        if (approvedEntry) addCurrencyAmount(summary.approved, approvedEntry.currency, approvedEntry.amount)

        for (const childEntry of recognizedChildrenBySourceId.get(approvedEntryId) || []) {
            if (!approvedEntryIds.has(childEntry.id)) pendingApprovedEntryIds.push(childEntry.id)
        }
    }

    summary.orderCount = orderIds.size
    return summary
}

export function buildCommissionHistoryGroups(entries: AgentCommissionEntry[]): CommissionHistoryGroup[] {
    const groups = new Map<string, CommissionHistoryGroup>()

    for (const entry of entries) {
        if (entry.isDeleted || entry.kind === 'estimate' || entry.kind === 'approval') continue
        const currency = entry.currency.toLowerCase()
        const reference = entry.orderId || entry.payoutReference || entry.id
        const id = `${entry.orderId ? 'order' : 'manual'}:${reference}:${currency}`
        const group = groups.get(id) || {
            id,
            orderId: entry.orderId || null,
            payoutReference: entry.payoutReference || null,
            currency,
            entries: [],
            earned: 0,
            paid: 0,
            recovered: 0,
            reversed: 0,
            outstanding: 0,
            status: 'earned' as CommissionHistoryStatus,
            occurredAt: entry.occurredAt,
        }

        group.entries.push(entry)
        group.outstanding += entry.amount
        if (entry.kind === 'accrual' || entry.kind === 'reversal' || entry.kind === 'adjustment') {
            group.earned += entry.amount
        }
        if (entry.kind === 'payout') group.paid += Math.abs(entry.amount)
        if (entry.kind === 'recovery') group.recovered += Math.abs(entry.amount)
        if (entry.kind === 'reversal') group.reversed += Math.abs(entry.amount)
        if (new Date(entry.occurredAt).getTime() > new Date(group.occurredAt).getTime()) {
            group.occurredAt = entry.occurredAt
        }
        groups.set(id, group)
    }

    return [...groups.values()]
        .map((group) => {
            group.earned = Math.round(group.earned * 1_000_000) / 1_000_000
            group.paid = Math.round(group.paid * 1_000_000) / 1_000_000
            group.recovered = Math.round(group.recovered * 1_000_000) / 1_000_000
            group.reversed = Math.round(group.reversed * 1_000_000) / 1_000_000
            group.outstanding = Math.round(group.outstanding * 1_000_000) / 1_000_000
            group.entries.sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())

            if (group.outstanding > 0.000001) group.status = 'outstanding'
            else if (group.outstanding < -0.000001) group.status = 'recovery_due'
            else if (group.paid > 0.000001) group.status = 'paid'
            else if (group.recovered > 0.000001) group.status = 'recovered'
            else if (group.reversed > 0.000001) group.status = 'reversed'

            return group
        })
        .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
}

/**
 * Commission entries store an order UUID for the relationship, not its human-facing
 * sales-order reference.  The order can arrive in the local read model a moment
 * after its commission entry (notably for POS quick orders), so never expose that
 * UUID as a temporary order label.
 */
export function commissionEntryOrderReference(
    entry: Pick<AgentCommissionEntry, 'orderId' | 'payoutReference'>,
    orderNumberById: ReadonlyMap<string, string>
) {
    if (entry.orderId) return orderNumberById.get(entry.orderId) || '—'
    return entry.payoutReference || '—'
}

export function commissionStatusLabel(status: CommissionEntryStatus, translate?: (key: string) => string) {
    switch (status) {
        case 'estimated': return translate?.('salesAgentCommissions.estimated') || 'Estimated'
        case 'earned': return translate?.('salesAgentCommissions.earned') || 'Earned'
        case 'approved': return translate?.('salesAgentCommissions.approved') || 'Approved'
        case 'paid': return translate?.('salesAgentCommissions.paid') || 'Paid'
        case 'reversed': return translate?.('salesAgentCommissions.reversed') || 'Reversed'
    }
}

export function commissionStatusClass(status: CommissionEntryStatus) {
    switch (status) {
        case 'estimated': return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
        case 'earned': return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        case 'approved': return 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
        case 'paid': return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        case 'reversed': return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
    }
}
