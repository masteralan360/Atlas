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
    sales_order_return_not_allowed: {
        key: 'orders.form.errors.salesOrderReturnNotAllowed',
        fallback: 'You do not have permission to return this sales order.'
    },
    order_cancellation_pending: {
        key: 'orders.cancellationPending',
        fallback: 'Cancellation is pending. Resolve any sync error before changing this order.'
    },
    order_cancellation_waiting_for_sync: {
        key: 'orders.cancellationWaitingForSync',
        fallback: 'Sync earlier order changes, then try cancelling again.'
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
    if (/order_cancellation_|financed_order_|loan_payment_transaction_missing|deleted_loan_has_active_installments|orders_module_not_available/.test(message)) {
        return t('orders.cancellationFailed', {
            defaultValue: 'The order and loan could not be cancelled together. Refresh and try again.'
        })
    }
    return message || fallback
}
