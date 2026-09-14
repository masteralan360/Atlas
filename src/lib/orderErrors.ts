import type { TFunction } from 'i18next'

const ORDER_ERROR_TRANSLATIONS: Record<string, { key: string; fallback: string }> = {
    non_financed_order_must_be_paid: {
        key: 'orders.form.errors.non_financed_order_must_be_paid',
        fallback: 'This order must be paid in full before it can be reserved. To reserve it with an outstanding balance, select Loans or Installments as the payment method.'
    },
    order_request_requires_approval: {
        key: 'orders.form.errors.orderRequestRequiresApproval',
        fallback: 'This order request must be approved by an admin before the normal order workflow can continue.'
    },
    loan_delete_online_required: {
        key: 'loans.messages.loanDeleteOnlineRequired',
        fallback: 'Connect to the internet before deleting or cancelling a loan in a Cloud Sync workspace.'
    }
}

export function getLocalizedOrderError(error: unknown, t: TFunction, fallback = 'Action failed') {
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : ''
    const translation = Object.entries(ORDER_ERROR_TRANSLATIONS)
        .find(([code]) => message === code || message.includes(code))?.[1]
    if (translation) {
        return t(translation.key, { defaultValue: translation.fallback })
    }
    return message || fallback
}
