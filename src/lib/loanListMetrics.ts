import type { Loan, LoanInstallment } from '@/local-db/models'
import { getLoanDirection } from '@/lib/loanPresentation'

type LoanMetricInput = Pick<Loan, 'id' | 'principalAmount' | 'totalPaidAmount' | 'balanceAmount' | 'status' | 'settlementCurrency'>
type LegacySimpleLoanMetricInput = Pick<Loan, 'balanceAmount' | 'status' | 'settlementCurrency' | 'direction'>
type InstallmentMetricInput = Pick<LoanInstallment, 'loanId' | 'balanceAmount' | 'dueDate' | 'status'>

export type SimpleLoanSummaryMode = 'principal_paid' | 'lent_borrowed'

export type SimpleLoanListMetrics = {
    totalPrincipalByCurrency: Record<string, number>
    totalPaidByCurrency: Record<string, number>
    totalBalanceByCurrency: Record<string, number>
    activeCount: number
}

export type LegacySimpleLoanListMetrics = {
    totalLentByCurrency: Record<string, number>
    totalBorrowedByCurrency: Record<string, number>
    activeCount: number
    settledCount: number
}

export type InstallmentLoanListMetrics = {
    totalOutstanding: number
    activeLoans: number
    overdueLoans: number
    dueToday: number
}

function addMetricAmount(total: number, amount: number) {
    // Loan amounts are persisted to a finite precision. Keep the summary free
    // of JavaScript floating-point residue while retaining that precision.
    return Math.round((total + amount + Number.EPSILON) * 1_000_000) / 1_000_000
}

/**
 * Calculates the simple-loan cards from the exact rows currently visible in
 * the table after its date, direction, payment, completion, and search
 * filters have been applied.
 */
export function calculateSimpleLoanListMetrics(
    visibleLoans: readonly LoanMetricInput[],
    defaultCurrency: string
): SimpleLoanListMetrics {
    const activeLoans = visibleLoans.filter((loan) => loan.balanceAmount > 0 && loan.status !== 'completed')
    const totalPrincipalByCurrency: Record<string, number> = {}
    const totalPaidByCurrency: Record<string, number> = {}
    const totalBalanceByCurrency: Record<string, number> = {}

    for (const loan of visibleLoans) {
        const currency = loan.settlementCurrency || defaultCurrency
        totalPrincipalByCurrency[currency] = addMetricAmount(totalPrincipalByCurrency[currency] || 0, loan.principalAmount)
        totalPaidByCurrency[currency] = addMetricAmount(totalPaidByCurrency[currency] || 0, loan.totalPaidAmount)
        totalBalanceByCurrency[currency] = addMetricAmount(totalBalanceByCurrency[currency] || 0, loan.balanceAmount)
    }

    return {
        totalPrincipalByCurrency,
        totalPaidByCurrency,
        totalBalanceByCurrency,
        activeCount: activeLoans.length
    }
}

/**
 * Preserves the original simple-loan card calculation exactly. These totals
 * are date-scoped by the caller, ignore the table's other filters, include
 * only active balances, and intentionally use plain JavaScript addition.
 */
export function calculateLegacySimpleLoanListMetrics(
    dateScopedLoans: readonly LegacySimpleLoanMetricInput[],
    defaultCurrency: string
): LegacySimpleLoanListMetrics {
    const activeLoans = dateScopedLoans.filter(
        (loan) => loan.balanceAmount > 0 && loan.status !== 'completed'
    )
    const totalLentByCurrency: Record<string, number> = {}
    const totalBorrowedByCurrency: Record<string, number> = {}

    for (const loan of activeLoans) {
        const currency = loan.settlementCurrency ?? defaultCurrency
        const direction = getLoanDirection(loan)
        if (direction === 'lent') {
            totalLentByCurrency[currency] = (totalLentByCurrency[currency] || 0) + loan.balanceAmount
        } else {
            totalBorrowedByCurrency[currency] = (totalBorrowedByCurrency[currency] || 0) + loan.balanceAmount
        }
    }

    return {
        totalLentByCurrency,
        totalBorrowedByCurrency,
        activeCount: activeLoans.length,
        settledCount: dateScopedLoans.filter(
            (loan) => loan.balanceAmount <= 0 || loan.status === 'completed'
        ).length
    }
}

/**
 * Calculates the installment-loan cards from the table's visible loans and
 * only the installments that belong to those loans.
 */
export function calculateInstallmentLoanListMetrics<TLoan extends LoanMetricInput>(
    visibleLoans: readonly TLoan[],
    dateScopedInstallments: readonly InstallmentMetricInput[],
    today: string,
    isOverdue: (loan: TLoan) => boolean
): InstallmentLoanListMetrics {
    const visibleLoanIds = new Set(visibleLoans.map((loan) => loan.id))
    const visibleInstallments = dateScopedInstallments.filter((item) => visibleLoanIds.has(item.loanId))

    return {
        totalOutstanding: visibleInstallments.reduce(
            (sum, item) => addMetricAmount(sum, item.balanceAmount),
            0
        ),
        activeLoans: visibleLoans.filter((loan) => loan.status === 'active' && loan.balanceAmount > 0).length,
        overdueLoans: visibleLoans.filter(isOverdue).length,
        dueToday: visibleInstallments
            .filter((item) => item.dueDate === today && item.balanceAmount > 0 && item.status !== 'paid')
            .reduce((sum, item) => addMetricAmount(sum, item.balanceAmount), 0)
    }
}
