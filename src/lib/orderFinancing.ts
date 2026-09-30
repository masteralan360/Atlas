import { roundOrderValue } from '@/lib/orderPrecision'

export function getRemainingFinancedBalance(totalAmount: number, initialPaymentAmount: number | string | null | undefined) {
    const total = roundOrderValue(Math.max(0, Number.isFinite(totalAmount) ? totalAmount : 0))
    const parsedInitialPayment = typeof initialPaymentAmount === 'string'
        ? Number(initialPaymentAmount)
        : Number(initialPaymentAmount ?? 0)
    const initialPayment = roundOrderValue(Math.max(0, Number.isFinite(parsedInitialPayment) ? parsedInitialPayment : 0))

    return roundOrderValue(Math.max(0, total - initialPayment))
}

export type QuickOrderLoanRepaymentSummary = {
    initialPaymentAmount: number | null
    remainingBalance: number
    isValid: boolean
}

export function getQuickOrderLoanRepaymentSummary(
    totalAmount: number,
    initialPaymentInput: string
): QuickOrderLoanRepaymentSummary {
    const total = roundOrderValue(Math.max(0, Number.isFinite(totalAmount) ? totalAmount : 0))
    const paymentText = initialPaymentInput.trim()
    const parsedPayment = paymentText ? Number(paymentText) : Number.NaN
    const initialPaymentAmount = Number.isFinite(parsedPayment) && parsedPayment >= 0
        ? roundOrderValue(parsedPayment)
        : null

    return {
        initialPaymentAmount,
        remainingBalance: getRemainingFinancedBalance(total, initialPaymentAmount),
        isValid: initialPaymentAmount !== null
            && parsedPayment > 0
            && initialPaymentAmount > 0
            && initialPaymentAmount < total
    }
}
