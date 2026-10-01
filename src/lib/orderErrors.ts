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
    },
    order_archive_not_allowed: {
        key: 'orders.archive.notAllowed',
        fallback: 'Only cancelled or returned orders can be archived.'
    },
    order_archive_not_found: {
        key: 'orders.archive.notFound',
        fallback: 'The order could not be found. Refresh and try again.'
    },
    order_archive_conflict: {
        key: 'orders.archive.conflict',
        fallback: 'The order changed before this action. Refresh and try again.'
    },
    order_archive_must_not_change_order_data: {
        key: 'orders.archive.conflict',
        fallback: 'The order changed before this action. Refresh and try again.'
    },
    order_archive_requires_existing_order: {
        key: 'orders.archive.conflict',
        fallback: 'The order changed before this action. Refresh and try again.'
    },
    order_archive_wait_for_sync: {
        key: 'orders.archive.waitForSync',
        fallback: 'Sync this order before archiving it, then try again.'
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
