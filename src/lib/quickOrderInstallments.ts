import { roundOrderValue } from '@/lib/orderPrecision'

export type QuickOrderInstallmentSummary = {
    installmentCount: number | null
    initialPaymentAmount: number | null
    financedBalance: number
    isInstallmentCountValid: boolean
    isInitialPaymentAmountValid: boolean
    isValid: boolean
}

export function getQuickOrderInstallmentSummary(
    totalAmount: number,
    installmentCountInput: string,
    initialPaymentInput: string
): QuickOrderInstallmentSummary {
    const total = roundOrderValue(Math.max(0, Number.isFinite(totalAmount) ? totalAmount : 0))
    const countText = installmentCountInput.trim()
    const parsedCount = countText && /^\d+$/.test(countText) ? Number(countText) : Number.NaN
    const isInstallmentCountValid = Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= 120

    const paymentText = initialPaymentInput.trim()
    const parsedPayment = paymentText ? Number(paymentText) : Number.NaN
    const initialPaymentAmount = Number.isFinite(parsedPayment) && parsedPayment >= 0
        ? roundOrderValue(parsedPayment)
        : null
    const isInitialPaymentAmountValid = initialPaymentAmount !== null
        && parsedPayment >= 0
        && initialPaymentAmount < total

    return {
        installmentCount: isInstallmentCountValid ? parsedCount : null,
        initialPaymentAmount,
        financedBalance: roundOrderValue(Math.max(0, total - (initialPaymentAmount ?? 0))),
        isInstallmentCountValid,
        isInitialPaymentAmountValid,
        isValid: isInstallmentCountValid && isInitialPaymentAmountValid
    }
}
