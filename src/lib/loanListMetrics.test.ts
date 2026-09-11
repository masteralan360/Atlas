import { describe, expect, it } from 'vitest'

import {
    calculateInstallmentLoanListMetrics,
    calculateLegacySimpleLoanListMetrics,
    calculateSimpleLoanListMetrics
} from './loanListMetrics'

const simpleLoan = (overrides: Record<string, unknown> = {}) => ({
    id: 'loan-1',
    principalAmount: 100,
    totalPaidAmount: 0,
    balanceAmount: 100,
    status: 'active',
    settlementCurrency: 'usd',
    ...overrides
}) as any

const installment = (overrides: Record<string, unknown> = {}) => ({
    loanId: 'loan-1',
    balanceAmount: 100,
    dueDate: '2026-09-09',
    status: 'unpaid',
    ...overrides
}) as any

describe('calculateSimpleLoanListMetrics', () => {
    it('summarizes principal, paid, and balance only for the loans visible in the filtered table', () => {
        const metrics = calculateSimpleLoanListMetrics([
            simpleLoan({ id: 'first', principalAmount: 0.1, totalPaidAmount: 0, balanceAmount: 0.1, settlementCurrency: 'usd' }),
            simpleLoan({ id: 'second', principalAmount: 0.2, totalPaidAmount: 0.1, balanceAmount: 0.1, settlementCurrency: 'usd' }),
            simpleLoan({ id: 'third', principalAmount: 300_000, totalPaidAmount: 50_000, balanceAmount: 250_000, settlementCurrency: 'iqd' })
        ], 'usd')

        expect(metrics).toEqual({
            totalPrincipalByCurrency: { usd: 0.3, iqd: 300_000 },
            totalPaidByCurrency: { usd: 0.1, iqd: 50_000 },
            totalBalanceByCurrency: { usd: 0.2, iqd: 250_000 },
            activeCount: 3
        })
    })

    it('keeps completed rows in the filtered total columns while excluding them from active entries', () => {
        const metrics = calculateSimpleLoanListMetrics([
            simpleLoan({ id: 'settled', principalAmount: 100, totalPaidAmount: 100, balanceAmount: 0, status: 'completed' }),
            simpleLoan({ id: 'completed-with-balance', principalAmount: 100, totalPaidAmount: 50, balanceAmount: 50, status: 'completed' }),
            simpleLoan({ id: 'active', principalAmount: 75, totalPaidAmount: 10, balanceAmount: 75, settlementCurrency: '' })
        ], 'iqd')

        expect(metrics).toEqual({
            totalPrincipalByCurrency: { usd: 200, iqd: 75 },
            totalPaidByCurrency: { usd: 150, iqd: 10 },
            totalBalanceByCurrency: { usd: 50, iqd: 75 },
            activeCount: 1
        })
    })
})

describe('calculateLegacySimpleLoanListMetrics', () => {
    it('preserves the original active-balance totals by direction and currency without rounding', () => {
        const metrics = calculateLegacySimpleLoanListMetrics([
            simpleLoan({ id: 'lent-1', balanceAmount: 0.1, direction: 'lent', settlementCurrency: 'usd' }),
            simpleLoan({ id: 'lent-2', balanceAmount: 0.2, direction: 'lent', settlementCurrency: 'usd' }),
            simpleLoan({ id: 'borrowed', balanceAmount: 250_000, direction: 'borrowed', settlementCurrency: 'iqd' }),
            simpleLoan({ id: 'default-direction', balanceAmount: 25, direction: undefined, settlementCurrency: 'iqd' })
        ], 'usd')

        expect(metrics).toEqual({
            totalLentByCurrency: { usd: 0.1 + 0.2, iqd: 25 },
            totalBorrowedByCurrency: { iqd: 250_000 },
            activeCount: 4,
            settledCount: 0
        })
    })

    it('uses the nullish currency fallback and the original active and settled boundaries', () => {
        const metrics = calculateLegacySimpleLoanListMetrics([
            simpleLoan({ id: 'fallback-currency', balanceAmount: 80, direction: 'lent', settlementCurrency: null }),
            simpleLoan({ id: 'empty-currency', balanceAmount: 20, direction: 'borrowed', settlementCurrency: '' }),
            simpleLoan({ id: 'zero-balance', balanceAmount: 0, direction: 'lent', status: 'active' }),
            simpleLoan({ id: 'completed-with-balance', balanceAmount: 40, direction: 'borrowed', status: 'completed' }),
            simpleLoan({ id: 'cancelled-with-balance', balanceAmount: 10, direction: 'lent', status: 'cancelled', settlementCurrency: null })
        ], 'iqd')

        expect(metrics).toEqual({
            totalLentByCurrency: { iqd: 90 },
            totalBorrowedByCurrency: { '': 20 },
            activeCount: 3,
            settledCount: 2
        })
    })
})

describe('calculateInstallmentLoanListMetrics', () => {
    it('includes installments only for rows visible in the filtered table', () => {
        const metrics = calculateInstallmentLoanListMetrics(
            [
                simpleLoan({ id: 'active', balanceAmount: 50, status: 'active' }),
                simpleLoan({ id: 'overdue', balanceAmount: 20, status: 'overdue' })
            ],
            [
                installment({ loanId: 'active', balanceAmount: 0.1, dueDate: '2026-09-09', status: 'unpaid' }),
                installment({ loanId: 'active', balanceAmount: 0.2, dueDate: '2026-09-09', status: 'partial' }),
                installment({ loanId: 'overdue', balanceAmount: 20, dueDate: '2026-09-08', status: 'unpaid' }),
                installment({ loanId: 'excluded-by-filter', balanceAmount: 999, dueDate: '2026-09-09', status: 'unpaid' }),
                installment({ loanId: 'active', balanceAmount: 100, dueDate: '2026-09-09', status: 'paid' })
            ],
            '2026-09-09',
            (loan) => loan.id === 'overdue'
        )

        expect(metrics).toEqual({
            totalOutstanding: 120.3,
            activeLoans: 1,
            overdueLoans: 1,
            dueToday: 0.3
        })
    })
})
