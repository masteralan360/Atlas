import { getLedgerCashBucketId, type LedgerCashBucketId } from './ledgerCashSummary'

export const LEDGER_MOVEMENT_CATEGORY_IDS = [
    'cashRevenueReceived',
    'cashRefundsPaid',
    'operatingCashPaid',
    'loansReceived',
    'loanRepaymentsPaid',
    'repaymentsCollected',
    'loansAdvanced',
    'otherCompletedMovement',
    'openingBalance',
    'balanceAdjustment',
] as const

export type LedgerMovementCategory = LedgerCashBucketId | 'openingBalance' | 'balanceAdjustment'
export type LedgerTransactionState = 'standard' | 'reversal'
export type LedgerSortOption = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'

export const LEDGER_NO_COUNTERPARTY = '__no_counterparty__'
export const LEDGER_UNASSIGNED_PAYMENT_ACCOUNT = '__unassigned_payment_account__'

export interface GeneralLedgerFilterEntry {
    transactionId: string
    referenceId: string
    date: string
    type: string
    direction: 'incoming' | 'outgoing' | 'opening' | 'adjustment'
    amount: number
    currency: string
    sourceModule: string
    partner: string | null
    businessPartnerId: string | null
    paymentMethod: string | null
    paymentAccountId?: string | null
    paymentAccount?: string | null
    notes: string | null
    description: string | null
    reversalOfTransactionId?: string | null
}

export interface GeneralLedgerFilterState<
    TType extends string = string,
    TSource extends string = string,
    TCurrency extends string = string,
> {
    search: string
    direction: GeneralLedgerFilterEntry['direction'][]
    category: LedgerMovementCategory[]
    transactionState: LedgerTransactionState[]
    type: TType[]
    source: TSource[]
    counterparty: string[]
    currency: TCurrency[]
    paymentMethods: string[]
    paymentAccounts: string[]
    minAmount: string
    maxAmount: string
    sort: LedgerSortOption
}

export function getLedgerMovementCategory(entry: GeneralLedgerFilterEntry): LedgerMovementCategory | null {
    if (entry.direction === 'opening') return 'openingBalance'
    if (entry.direction === 'adjustment') return 'balanceAdjustment'
    return getLedgerCashBucketId(entry)
}

export function getLedgerTransactionState(entry: GeneralLedgerFilterEntry): LedgerTransactionState {
    return entry.reversalOfTransactionId ? 'reversal' : 'standard'
}

export function getLedgerCounterpartyFilterKey(entry: GeneralLedgerFilterEntry) {
    if (entry.businessPartnerId) return `partner:${entry.businessPartnerId}`
    const normalizedName = entry.partner?.trim().toLocaleLowerCase()
    return normalizedName ? `name:${normalizedName}` : LEDGER_NO_COUNTERPARTY
}

export function getLedgerPaymentAccountFilterKey(entry: GeneralLedgerFilterEntry) {
    if (entry.paymentAccountId) return `account:${entry.paymentAccountId}`
    const normalizedName = entry.paymentAccount?.trim().toLocaleLowerCase()
    return normalizedName ? `name:${normalizedName}` : LEDGER_UNASSIGNED_PAYMENT_ACCOUNT
}

export function canCompareLedgerAmounts(filters: Pick<GeneralLedgerFilterState, 'currency'>) {
    return filters.currency.length === 1
}

export function normalizeLedgerFiltersForCurrency<
    TType extends string,
    TSource extends string,
    TCurrency extends string,
>(filters: GeneralLedgerFilterState<TType, TSource, TCurrency>): GeneralLedgerFilterState<TType, TSource, TCurrency> {
    if (canCompareLedgerAmounts(filters)) return filters

    return {
        ...filters,
        minAmount: '',
        maxAmount: '',
        sort: filters.sort === 'amount_asc' || filters.sort === 'amount_desc' ? 'date_desc' : filters.sort,
    }
}

export function countActiveLedgerFilters(filters: GeneralLedgerFilterState) {
    return [
        !!filters.search.trim(),
        filters.direction.length > 0,
        filters.category.length > 0,
        filters.transactionState.length > 0,
        filters.type.length > 0,
        filters.source.length > 0,
        filters.counterparty.length > 0,
        filters.currency.length > 0,
        filters.paymentMethods.length > 0,
        filters.paymentAccounts.length > 0,
        !!filters.minAmount,
        !!filters.maxAmount,
        filters.sort !== 'date_desc',
    ].filter(Boolean).length
}

function parseFilterAmount(value: string) {
    if (!value) return null
    const parsed = Number(value.replace(/,/g, ''))
    return Number.isFinite(parsed) ? parsed : null
}

export function hasInvalidLedgerAmountRange(filters: Pick<GeneralLedgerFilterState, 'currency' | 'minAmount' | 'maxAmount'>) {
    if (!canCompareLedgerAmounts(filters)) return false
    const minimum = parseFilterAmount(filters.minAmount)
    const maximum = parseFilterAmount(filters.maxAmount)
    return minimum !== null && maximum !== null && minimum > maximum
}

export function applyGeneralLedgerFilters<
    TEntry extends GeneralLedgerFilterEntry,
    TType extends string,
    TSource extends string,
    TCurrency extends string,
>(
    entries: readonly TEntry[],
    rawFilters: GeneralLedgerFilterState<TType, TSource, TCurrency>,
    getAdditionalSearchTerms?: (entry: TEntry) => Array<string | null | undefined>,
) {
    const filters = normalizeLedgerFiltersForCurrency(rawFilters)
    const normalizedSearch = filters.search.trim().toLocaleLowerCase()
    const minAmount = parseFilterAmount(filters.minAmount)
    const maxAmount = parseFilterAmount(filters.maxAmount)

    const filtered = entries.filter((entry) => {
        if (filters.direction.length > 0 && !filters.direction.includes(entry.direction)) return false

        const category = getLedgerMovementCategory(entry)
        if (filters.category.length > 0 && (!category || !filters.category.includes(category))) return false

        if (filters.transactionState.length > 0 && !filters.transactionState.includes(getLedgerTransactionState(entry))) return false
        if (filters.type.length > 0 && !filters.type.includes(entry.type as TType)) return false
        if (filters.source.length > 0 && !filters.source.includes(entry.sourceModule as TSource)) return false
        if (filters.counterparty.length > 0 && !filters.counterparty.includes(getLedgerCounterpartyFilterKey(entry))) return false
        if (filters.currency.length > 0 && !filters.currency.includes(entry.currency as TCurrency)) return false
        if (filters.paymentMethods.length > 0 && !filters.paymentMethods.includes(entry.paymentMethod || 'unknown')) return false
        if (filters.paymentAccounts.length > 0 && !filters.paymentAccounts.includes(getLedgerPaymentAccountFilterKey(entry))) return false
        if (minAmount !== null && entry.amount < minAmount) return false
        if (maxAmount !== null && entry.amount > maxAmount) return false
        if (!normalizedSearch) return true

        const searchTerms = [
            entry.transactionId,
            entry.referenceId,
            entry.partner,
            entry.notes,
            entry.description,
            entry.paymentMethod,
            entry.paymentAccount,
            entry.type.replace(/_/g, ' '),
            entry.sourceModule.replace(/_/g, ' '),
            ...(getAdditionalSearchTerms?.(entry) || []),
        ]
        return searchTerms.some((value) => value?.toLocaleLowerCase().includes(normalizedSearch))
    })

    return [...filtered].sort((left, right) => {
        if (filters.sort === 'date_asc') {
            return left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId)
        }
        if (filters.sort === 'amount_desc') return right.amount - left.amount || right.date.localeCompare(left.date)
        if (filters.sort === 'amount_asc') return left.amount - right.amount || right.date.localeCompare(left.date)
        return right.date.localeCompare(left.date) || right.transactionId.localeCompare(left.transactionId)
    })
}
