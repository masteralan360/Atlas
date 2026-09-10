export const LEDGER_CASH_GROUP_IDS = ['operating', 'borrowing', 'lending'] as const

export type LedgerCashGroupId = (typeof LEDGER_CASH_GROUP_IDS)[number]

export const LEDGER_CASH_BUCKET_IDS = [
    'cashRevenueReceived',
    'cashRefundsPaid',
    'operatingCashPaid',
    'loansReceived',
    'loanRepaymentsPaid',
    'repaymentsCollected',
    'loansAdvanced',
    'otherCompletedMovement',
] as const

export type LedgerCashBucketId = (typeof LEDGER_CASH_BUCKET_IDS)[number]
export type LedgerCashDrilldownId =
    LedgerCashBucketId | LedgerCashGroupId | 'netCashRevenue' | 'netRecordedCashMovement'

export interface LedgerDashboardConfig {
    version: 1
    hiddenGroups: LedgerCashGroupId[]
    groupOrder: LedgerCashGroupId[]
}

export const DEFAULT_LEDGER_DASHBOARD_CONFIG: LedgerDashboardConfig = {
    version: 1,
    hiddenGroups: [],
    groupOrder: [...LEDGER_CASH_GROUP_IDS],
}

export interface LedgerCashSummaryEntry {
    type: string
    direction: 'incoming' | 'outgoing' | 'opening' | 'adjustment'
    amount: number
}

export interface LedgerCashBucketTotal {
    amount: number
    entryCount: number
}

export interface LedgerCashSummary {
    buckets: Record<LedgerCashBucketId, LedgerCashBucketTotal>
    netCashRevenue: number
    cashOperatingSurplus: number
    netBorrowingMovement: number
    netLendingMovement: number
    netRecordedCashMovement: number
    completedEntryCount: number
    excludedEntryCount: number
}

export interface LedgerCashCurrencySummary<Currency extends string = string> {
    currency: Currency
    summary: LedgerCashSummary
}

export type LedgerOperatingCashPresentationMode = 'paid' | 'recovered' | 'movement'

export interface LedgerOperatingCashPresentation {
    mode: LedgerOperatingCashPresentationMode
    operator: '−' | '+'
    amounts: number[]
}

const OPERATING_REVENUE_TYPES = new Set([
    'pos_sale',
    'instant_pos_sale',
    'ecommerce_payment',
    'sales_order_payment',
    'order_loan_collection',
    'installment_sale_down_payment',
    'installment_sale_collection',
    'real_estate_commission',
    'clinical_appointment_payment',
    'rental_payment',
    'travel_booking_profit',
])

const OPERATING_REFUND_TYPES = new Set(['activity_refund', 'order_loan_refund'])

const OPERATING_PAYMENT_TYPES = new Set([
    'purchase_order_payment',
    'expense',
    'payroll_payment',
    'agent_commission_payout',
    'delivery_courier_fee_payout',
])

const BORROWING_RECEIPT_TYPES = new Set(['loan_taken'])
const BORROWING_REPAYMENT_TYPES = new Set(['loan_repayment_paid', 'installment_paid'])
const LENDING_COLLECTION_TYPES = new Set(['loan_repayment_received', 'installment_received'])
const LENDING_ADVANCE_TYPES = new Set(['loan_given'])
const NON_CASH_TYPES = new Set(['ecommerce_receivable'])

function roundLedgerAmount(amount: number) {
    return Number(amount.toFixed(8))
}

function isCashDirection(direction: LedgerCashSummaryEntry['direction']): direction is 'incoming' | 'outgoing' {
    return direction === 'incoming' || direction === 'outgoing'
}

export function normalizeLedgerDashboardConfig(value: unknown): LedgerDashboardConfig {
    if (!value || typeof value !== 'object') {
        return {
            ...DEFAULT_LEDGER_DASHBOARD_CONFIG,
            groupOrder: [...DEFAULT_LEDGER_DASHBOARD_CONFIG.groupOrder],
        }
    }

    const candidate = value as Partial<LedgerDashboardConfig>
    const hiddenGroups = Array.isArray(candidate.hiddenGroups)
        ? Array.from(
              new Set(
                  candidate.hiddenGroups.filter((group): group is LedgerCashGroupId =>
                      LEDGER_CASH_GROUP_IDS.includes(group),
                  ),
              ),
          )
        : []
    const configuredOrder = Array.isArray(candidate.groupOrder)
        ? Array.from(
              new Set(
                  candidate.groupOrder.filter((group): group is LedgerCashGroupId =>
                      LEDGER_CASH_GROUP_IDS.includes(group),
                  ),
              ),
          )
        : []
    const groupOrder = [
        ...configuredOrder,
        ...LEDGER_CASH_GROUP_IDS.filter((group) => !configuredOrder.includes(group)),
    ]

    return {
        version: 1,
        hiddenGroups: hiddenGroups.filter((group) => group !== 'operating'),
        groupOrder,
    }
}

export function getLedgerCashBucketId(entry: LedgerCashSummaryEntry): LedgerCashBucketId | null {
    if (!isCashDirection(entry.direction)) return null
    if (NON_CASH_TYPES.has(entry.type)) return null

    if (entry.type === 'activity_transaction') {
        return entry.direction === 'incoming' ? 'cashRevenueReceived' : 'operatingCashPaid'
    }

    if (OPERATING_REVENUE_TYPES.has(entry.type)) {
        return entry.direction === 'incoming' ? 'cashRevenueReceived' : 'cashRefundsPaid'
    }

    if (OPERATING_REFUND_TYPES.has(entry.type)) return 'cashRefundsPaid'
    if (OPERATING_PAYMENT_TYPES.has(entry.type)) return 'operatingCashPaid'
    if (BORROWING_RECEIPT_TYPES.has(entry.type)) return 'loansReceived'
    if (BORROWING_REPAYMENT_TYPES.has(entry.type)) return 'loanRepaymentsPaid'
    if (LENDING_COLLECTION_TYPES.has(entry.type)) return 'repaymentsCollected'
    if (LENDING_ADVANCE_TYPES.has(entry.type)) return 'loansAdvanced'

    // Completed movements that cannot truthfully be called operating activity,
    // borrowing, or lending still reconcile into the headline without being
    // mislabeled. Examples include deposits, pass-through settlements, and FX
    // margin entries.
    return 'otherCompletedMovement'
}

function getBucketAmount(entry: LedgerCashSummaryEntry, bucketId: LedgerCashBucketId) {
    const directionSign = entry.direction === 'incoming' ? 1 : -1

    switch (bucketId) {
        case 'cashRevenueReceived':
        case 'loansReceived':
        case 'repaymentsCollected':
            return directionSign * entry.amount
        case 'cashRefundsPaid':
        case 'operatingCashPaid':
        case 'loanRepaymentsPaid':
        case 'loansAdvanced':
            return -directionSign * entry.amount
        case 'otherCompletedMovement':
            return directionSign * entry.amount
    }
}

export function summarizeLedgerCashMovements<T extends LedgerCashSummaryEntry>(
    entries: readonly T[],
    getAmount: (entry: T) => number = (entry) => entry.amount,
): LedgerCashSummary {
    const bucketValues = Object.fromEntries(
        LEDGER_CASH_BUCKET_IDS.map((bucketId) => [bucketId, { amount: 0, entryCount: 0 }]),
    ) as Record<LedgerCashBucketId, LedgerCashBucketTotal>
    let excludedEntryCount = 0
    let completedEntryCount = 0

    entries.forEach((entry) => {
        const amount = getAmount(entry)
        const bucketId = getLedgerCashBucketId(entry)
        if (!bucketId || !Number.isFinite(amount)) {
            excludedEntryCount += 1
            return
        }

        const normalizedEntry = { ...entry, amount }
        bucketValues[bucketId].amount += getBucketAmount(normalizedEntry, bucketId)
        bucketValues[bucketId].entryCount += 1
        completedEntryCount += 1
    })

    LEDGER_CASH_BUCKET_IDS.forEach((bucketId) => {
        bucketValues[bucketId].amount = roundLedgerAmount(bucketValues[bucketId].amount)
    })

    const netCashRevenue = roundLedgerAmount(
        bucketValues.cashRevenueReceived.amount - bucketValues.cashRefundsPaid.amount,
    )
    const cashOperatingSurplus = roundLedgerAmount(netCashRevenue - bucketValues.operatingCashPaid.amount)
    const netBorrowingMovement = roundLedgerAmount(
        bucketValues.loansReceived.amount - bucketValues.loanRepaymentsPaid.amount,
    )
    const netLendingMovement = roundLedgerAmount(
        bucketValues.repaymentsCollected.amount - bucketValues.loansAdvanced.amount,
    )
    const netRecordedCashMovement = roundLedgerAmount(
        cashOperatingSurplus + netBorrowingMovement + netLendingMovement + bucketValues.otherCompletedMovement.amount,
    )

    return {
        buckets: bucketValues,
        netCashRevenue,
        cashOperatingSurplus,
        netBorrowingMovement,
        netLendingMovement,
        netRecordedCashMovement,
        completedEntryCount,
        excludedEntryCount,
    }
}

export function summarizeLedgerCashMovementsByCurrency<
    Currency extends string,
    T extends LedgerCashSummaryEntry & { currency: Currency },
>(entries: readonly T[], currencies: readonly Currency[] = []): LedgerCashCurrencySummary<Currency>[] {
    const entriesByCurrency = new Map<Currency, T[]>()

    currencies.forEach((currency) => {
        if (!entriesByCurrency.has(currency)) entriesByCurrency.set(currency, [])
    })

    entries.forEach((entry) => {
        const currencyEntries = entriesByCurrency.get(entry.currency)
        if (currencyEntries) {
            currencyEntries.push(entry)
            return
        }
        entriesByCurrency.set(entry.currency, [entry])
    })

    return Array.from(entriesByCurrency, ([currency, currencyEntries]) => ({
        currency,
        summary: summarizeLedgerCashMovements(currencyEntries),
    }))
}

/**
 * Operating payment buckets are stored as net cash paid: outgoing payments add
 * to the bucket and incoming reversals reduce it. Present a net recovery as an
 * addition instead of rendering the confusing expression `A - (-B)`.
 *
 * When currencies have opposite signs, one shared subtraction/addition label
 * cannot describe every line. In that case expose the signed cash contribution
 * and add it to net cash revenue, preserving each currency equation.
 */
export function getLedgerOperatingCashPresentation(amounts: readonly number[]): LedgerOperatingCashPresentation {
    const hasNetPayment = amounts.some((amount) => amount > 0)
    const hasNetRecovery = amounts.some((amount) => amount < 0)

    if (hasNetPayment && hasNetRecovery) {
        return {
            mode: 'movement',
            operator: '+',
            amounts: amounts.map((amount) => (amount === 0 ? 0 : -amount)),
        }
    }

    if (hasNetRecovery) {
        return {
            mode: 'recovered',
            operator: '+',
            amounts: amounts.map((amount) => Math.abs(amount)),
        }
    }

    return {
        mode: 'paid',
        operator: '−',
        amounts: amounts.map((amount) => Math.abs(amount)),
    }
}

export function isLedgerCashDrilldownMatch(entry: LedgerCashSummaryEntry, drilldownId: LedgerCashDrilldownId | null) {
    if (!drilldownId) return true

    const bucketId = getLedgerCashBucketId(entry)
    if (drilldownId === 'netRecordedCashMovement') return bucketId !== null
    if (!bucketId) return false
    if (LEDGER_CASH_BUCKET_IDS.includes(drilldownId as LedgerCashBucketId)) return bucketId === drilldownId
    if (drilldownId === 'netCashRevenue') return bucketId === 'cashRevenueReceived' || bucketId === 'cashRefundsPaid'
    if (drilldownId === 'operating') {
        return bucketId === 'cashRevenueReceived' || bucketId === 'cashRefundsPaid' || bucketId === 'operatingCashPaid'
    }
    if (drilldownId === 'borrowing') return bucketId === 'loansReceived' || bucketId === 'loanRepaymentsPaid'
    if (drilldownId === 'lending') return bucketId === 'repaymentsCollected' || bucketId === 'loansAdvanced'
    return false
}

export function getLedgerCashGroupEntryCount(summary: LedgerCashSummary, groupId: LedgerCashGroupId) {
    if (groupId === 'operating') {
        return (
            summary.buckets.cashRevenueReceived.entryCount +
            summary.buckets.cashRefundsPaid.entryCount +
            summary.buckets.operatingCashPaid.entryCount
        )
    }
    if (groupId === 'borrowing') {
        return summary.buckets.loansReceived.entryCount + summary.buckets.loanRepaymentsPaid.entryCount
    }
    return summary.buckets.repaymentsCollected.entryCount + summary.buckets.loansAdvanced.entryCount
}
