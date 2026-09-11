import type { CurrencyCode, PaymentTransaction } from '@/local-db/models'
import { isReportablePaymentTransaction } from './financialReportability'

const SETTLEMENT_EPSILON = 0.000001

export type LedgerSettlementStatus =
    | 'posted'
    | 'partially_reversed'
    | 'fully_reversed'
    | 'inconsistent'
    | 'relationship_missing'
    | 'not_applicable'

export interface LedgerSettlementProjection {
    transactionId: string
    rootTransactionId: string
    currency: CurrencyCode
    movementAmount: number
    finalSettlement: number | null
    originalAmount: number | null
    reversedAmount: number
    isReversal: boolean
    status: LedgerSettlementStatus
    linkedTransactionIds: string[]
}

export interface LedgerSettlementIndex {
    byTransactionId: Map<string, LedgerSettlementProjection>
    sourceTransactionIds: Map<string, string[]>
}

export interface LedgerFinalSettlementTotal {
    currency: CurrencyCode
    amount: number
}

export interface LedgerFinalSettlementProjection {
    relationKey: string | null
    totals: LedgerFinalSettlementTotal[]
    status: LedgerSettlementStatus
    isRelationTotal: boolean
    linkedTransactionIds: string[]
    linkedRootTransactionIds: string[]
}

export interface LedgerFinalSettlementIndex {
    byTransactionId: Map<string, LedgerFinalSettlementProjection>
}

function normalizeSettlementAmount(value: number) {
    return Math.abs(value) <= SETTLEMENT_EPSILON ? 0 : value
}

/** Signed cash effect: positive enters the business, negative leaves it. */
export function getSignedPaymentTransactionAmount(
    transaction: Pick<PaymentTransaction, 'amount' | 'direction'>,
) {
    const amount = Number(transaction.amount || 0)
    return normalizeSettlementAmount(transaction.direction === 'incoming' ? amount : -amount)
}

/** Stable source-document identity. It intentionally does not imply a reversal relationship. */
export function getPaymentTransactionSourceKey(
    transaction: Pick<PaymentTransaction, 'sourceModule' | 'sourceRecordId'>,
) {
    return JSON.stringify([transaction.sourceModule, transaction.sourceRecordId])
}

function resolveRootTransaction(
    transaction: PaymentTransaction,
    transactionById: ReadonlyMap<string, PaymentTransaction>,
) {
    let current = transaction
    const visited = new Set<string>([current.id])

    while (current.reversalOfTransactionId) {
        const parent = transactionById.get(current.reversalOfTransactionId)
        if (!parent) {
            return { root: null, missingRootId: current.reversalOfTransactionId }
        }
        if (visited.has(parent.id)) {
            return { root: null, missingRootId: parent.id }
        }
        visited.add(parent.id)
        current = parent
    }

    return { root: current, missingRootId: null }
}

/**
 * Builds an all-time read model for Ledger presentation. No records are mutated
 * and source-document peers never become part of a payment chain unless an
 * explicit reversalOfTransactionId link connects them.
 */
export function buildLedgerSettlementIndex(rows: readonly PaymentTransaction[]): LedgerSettlementIndex {
    const activeRows = rows.filter(isReportablePaymentTransaction)
    const transactionById = new Map(activeRows.map((row) => [row.id, row] as const))
    const sourceTransactionIds = new Map<string, string[]>()
    const groupByRootId = new Map<string, PaymentTransaction[]>()
    const missingRelationshipById = new Map<string, string>()

    activeRows.forEach((transaction) => {
        const sourceKey = getPaymentTransactionSourceKey(transaction)
        const sourceIds = sourceTransactionIds.get(sourceKey) ?? []
        sourceIds.push(transaction.id)
        sourceTransactionIds.set(sourceKey, sourceIds)

        const resolved = resolveRootTransaction(transaction, transactionById)
        if (!resolved.root) {
            missingRelationshipById.set(transaction.id, resolved.missingRootId || transaction.id)
            return
        }

        const group = groupByRootId.get(resolved.root.id) ?? []
        group.push(transaction)
        groupByRootId.set(resolved.root.id, group)
    })

    sourceTransactionIds.forEach((ids) => {
        ids.sort((leftId, rightId) => {
            const left = transactionById.get(leftId)
            const right = transactionById.get(rightId)
            return (left?.paidAt || '').localeCompare(right?.paidAt || '') || leftId.localeCompare(rightId)
        })
    })

    const byTransactionId = new Map<string, LedgerSettlementProjection>()

    groupByRootId.forEach((group, rootTransactionId) => {
        const root = transactionById.get(rootTransactionId)
        if (!root) return

        const linkedTransactionIds = group
            .slice()
            .sort((left, right) => left.paidAt.localeCompare(right.paidAt) || left.id.localeCompare(right.id))
            .map((transaction) => transaction.id)
        const hasCurrencyMismatch = group.some((transaction) => transaction.currency !== root.currency)
        const finalSettlement = hasCurrencyMismatch
            ? null
            : normalizeSettlementAmount(group.reduce((total, transaction) => total + getSignedPaymentTransactionAmount(transaction), 0))
        const originalAmount = getSignedPaymentTransactionAmount(root)
        const reversedAmount = group.reduce(
            (total, transaction) =>
                transaction.id === root.id ? total : total + Math.abs(getSignedPaymentTransactionAmount(transaction)),
            0,
        )
        const hasReversals = group.some((transaction) => transaction.id !== root.id)
        const crossedPastZero =
            finalSettlement !== null &&
            Math.abs(originalAmount) > SETTLEMENT_EPSILON &&
            Math.abs(finalSettlement) > SETTLEMENT_EPSILON &&
            Math.sign(finalSettlement) !== Math.sign(originalAmount)
        const status: LedgerSettlementStatus =
            hasCurrencyMismatch || crossedPastZero
                ? 'inconsistent'
                : !hasReversals
                  ? 'posted'
                  : finalSettlement === 0
                    ? 'fully_reversed'
                    : 'partially_reversed'

        group.forEach((transaction) => {
            byTransactionId.set(transaction.id, {
                transactionId: transaction.id,
                rootTransactionId,
                currency: root.currency,
                movementAmount: getSignedPaymentTransactionAmount(transaction),
                finalSettlement,
                originalAmount,
                reversedAmount,
                isReversal: transaction.id !== root.id,
                status,
                linkedTransactionIds,
            })
        })
    })

    missingRelationshipById.forEach((rootTransactionId, transactionId) => {
        const transaction = transactionById.get(transactionId)
        if (!transaction) return

        byTransactionId.set(transactionId, {
            transactionId,
            rootTransactionId,
            currency: transaction.currency,
            movementAmount: getSignedPaymentTransactionAmount(transaction),
            finalSettlement: null,
            originalAmount: null,
            reversedAmount: Math.abs(getSignedPaymentTransactionAmount(transaction)),
            isReversal: true,
            status: 'relationship_missing',
            linkedTransactionIds: [transactionId],
        })
    })

    return { byTransactionId, sourceTransactionIds }
}

/**
 * Expands reversal-chain settlements into legitimate Ledger relation totals.
 * A relation key must come from the Ledger's immutable source identity (for
 * example `loan:<loan UUID>`), never from a mutable display reference.
 *
 * Every reversal chain is included exactly once, so selecting either an
 * original movement or one of its reversals returns the same all-date result.
 * Currencies remain on separate lines and are never implicitly converted.
 */
export function buildLedgerFinalSettlementIndex(
    settlementIndex: LedgerSettlementIndex,
    relationKeyByTransactionId: ReadonlyMap<string, string | null | undefined>,
): LedgerFinalSettlementIndex {
    const chainByRootId = new Map<string, LedgerSettlementProjection>()

    settlementIndex.byTransactionId.forEach((projection) => {
        const existing = chainByRootId.get(projection.rootTransactionId)
        if (!existing || projection.transactionId === projection.rootTransactionId) {
            chainByRootId.set(projection.rootTransactionId, projection)
        }
    })

    const groups = new Map<
        string,
        {
            relationKey: string | null
            chains: Map<string, LedgerSettlementProjection>
        }
    >()

    chainByRootId.forEach((projection, rootTransactionId) => {
        const relationKeys = new Set(
            projection.linkedTransactionIds
                .map((transactionId) => relationKeyByTransactionId.get(transactionId))
                .filter((relationKey): relationKey is string => typeof relationKey === 'string' && relationKey.length > 0),
        )
        const relationKey = relationKeys.values().next().value ?? null
        const groupKey = relationKey ? `relation:${relationKey}` : `payment-chain:${rootTransactionId}`
        const group = groups.get(groupKey) ?? { relationKey, chains: new Map() }
        group.chains.set(rootTransactionId, projection)
        groups.set(groupKey, group)
    })

    const byTransactionId = new Map<string, LedgerFinalSettlementProjection>()

    groups.forEach((group) => {
        const chains = Array.from(group.chains.values())
        const linkedRootTransactionIds = chains.map((chain) => chain.rootTransactionId).sort()
        const linkedTransactionIds = Array.from(
            new Set(chains.flatMap((chain) => chain.linkedTransactionIds)),
        ).sort()
        const unavailableChain = chains.find((chain) => chain.finalSettlement === null)
        const totalsByCurrency = new Map<CurrencyCode, number>()

        if (!unavailableChain) {
            chains.forEach((chain) => {
                totalsByCurrency.set(
                    chain.currency,
                    normalizeSettlementAmount((totalsByCurrency.get(chain.currency) ?? 0) + (chain.finalSettlement ?? 0)),
                )
            })
        }

        const totals = unavailableChain
            ? []
            : Array.from(totalsByCurrency, ([currency, amount]) => ({ currency, amount }))
                  .sort((left, right) => left.currency.localeCompare(right.currency))
        const isRelationTotal = group.relationKey !== null && chains.length > 1
        const status: LedgerSettlementStatus = unavailableChain
            ? unavailableChain.status === 'relationship_missing'
                ? 'relationship_missing'
                : 'inconsistent'
            : isRelationTotal
              ? 'posted'
              : chains[0]?.status ?? 'not_applicable'
        const projection: LedgerFinalSettlementProjection = {
            relationKey: group.relationKey,
            totals,
            status,
            isRelationTotal,
            linkedTransactionIds,
            linkedRootTransactionIds,
        }

        linkedTransactionIds.forEach((transactionId) => {
            byTransactionId.set(transactionId, projection)
        })
    })

    return { byTransactionId }
}
