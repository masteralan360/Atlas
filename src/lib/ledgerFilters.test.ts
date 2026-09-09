import { describe, expect, it } from 'vitest'

import {
    LEDGER_NO_COUNTERPARTY,
    LEDGER_UNASSIGNED_PAYMENT_ACCOUNT,
    applyGeneralLedgerFilters,
    getLedgerCounterpartyFilterKey,
    getLedgerMovementCategory,
    getLedgerPaymentAccountFilterKey,
    hasInvalidLedgerAmountRange,
    normalizeLedgerFiltersForCurrency,
    type GeneralLedgerFilterEntry,
    type GeneralLedgerFilterState,
} from './ledgerFilters'

const entries: GeneralLedgerFilterEntry[] = [
    {
        transactionId: 'sale-1',
        referenceId: 'POS-1',
        date: '2026-09-10T10:00:00.000Z',
        type: 'pos_sale',
        direction: 'incoming',
        amount: 100,
        currency: 'usd',
        sourceModule: 'pos',
        partner: null,
        businessPartnerId: null,
        paymentMethod: 'cash',
        paymentAccountId: 'cashbox',
        paymentAccount: 'Main Cashbox',
        notes: null,
        description: 'Completed POS sale',
    },
    {
        transactionId: 'expense-1',
        referenceId: 'EXP-1',
        date: '2026-09-10T11:00:00.000Z',
        type: 'expense',
        direction: 'outgoing',
        amount: 40,
        currency: 'usd',
        sourceModule: 'expenses',
        partner: 'Office Supplier',
        businessPartnerId: 'supplier-1',
        paymentMethod: 'bank_transfer',
        paymentAccountId: null,
        paymentAccount: null,
        notes: 'September supplies',
        description: null,
    },
    {
        transactionId: 'loan-reversal',
        referenceId: 'REV-1',
        date: '2026-09-10T12:00:00.000Z',
        type: 'loan_taken',
        direction: 'outgoing',
        amount: 25,
        currency: 'usd',
        sourceModule: 'loans',
        partner: 'Lender',
        businessPartnerId: null,
        paymentMethod: 'cash',
        paymentAccountId: 'cashbox',
        paymentAccount: 'Main Cashbox',
        notes: null,
        description: 'Reversal',
        reversalOfTransactionId: 'loan-1',
    },
]

function filters(overrides: Partial<GeneralLedgerFilterState> = {}): GeneralLedgerFilterState {
    return {
        search: '',
        direction: [],
        category: [],
        transactionState: [],
        type: [],
        source: [],
        counterparty: [],
        currency: [],
        paymentMethods: [],
        paymentAccounts: [],
        minAmount: '',
        maxAmount: '',
        sort: 'date_desc',
        ...overrides,
    }
}

describe('general Ledger filters', () => {
    it('filters by accounting category and reversal state instead of unrelated record fields', () => {
        expect(getLedgerMovementCategory(entries[0])).toBe('cashRevenueReceived')
        expect(getLedgerMovementCategory(entries[1])).toBe('operatingCashPaid')
        expect(applyGeneralLedgerFilters(entries, filters({ transactionState: ['reversal'] }))).toEqual([entries[2]])
        expect(applyGeneralLedgerFilters(entries, filters({ category: ['operatingCashPaid'] }))).toEqual([entries[1]])
    })

    it('uses stable counterparty and payment-account keys with explicit missing states', () => {
        expect(getLedgerCounterpartyFilterKey(entries[0])).toBe(LEDGER_NO_COUNTERPARTY)
        expect(getLedgerCounterpartyFilterKey(entries[1])).toBe('partner:supplier-1')
        expect(getLedgerCounterpartyFilterKey(entries[2])).toBe('name:lender')
        expect(getLedgerPaymentAccountFilterKey(entries[0])).toBe('account:cashbox')
        expect(getLedgerPaymentAccountFilterKey(entries[1])).toBe(LEDGER_UNASSIGNED_PAYMENT_ACCOUNT)
    })

    it('only compares and sorts nominal amounts when exactly one currency is selected', () => {
        const mixedCurrencyFilters = filters({ minAmount: '50', sort: 'amount_asc' })
        expect(normalizeLedgerFiltersForCurrency(mixedCurrencyFilters)).toMatchObject({ minAmount: '', sort: 'date_desc' })
        expect(applyGeneralLedgerFilters(entries, mixedCurrencyFilters).map((entry) => entry.transactionId)).toEqual([
            'loan-reversal',
            'expense-1',
            'sale-1',
        ])

        const usdFilters = filters({ currency: ['usd'], minAmount: '50', sort: 'amount_asc' })
        expect(applyGeneralLedgerFilters(entries, usdFilters)).toEqual([entries[0]])
    })

    it('rejects an inverted single-currency amount range', () => {
        expect(hasInvalidLedgerAmountRange(filters({ currency: ['usd'], minAmount: '100', maxAmount: '20' }))).toBe(true)
        expect(hasInvalidLedgerAmountRange(filters({ currency: ['usd', 'iqd'], minAmount: '100', maxAmount: '20' }))).toBe(false)
    })

    it('searches references, descriptions, and localized terms supplied by the page', () => {
        expect(applyGeneralLedgerFilters(entries, filters({ search: 'POS-1' }))).toEqual([entries[0]])
        expect(
            applyGeneralLedgerFilters(entries, filters({ search: 'cash revenue' }), () => ['Cash Revenue']),
        ).toHaveLength(3)
    })
})
