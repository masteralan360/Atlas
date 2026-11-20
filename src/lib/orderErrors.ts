import { normalizeStockReservationError } from './stockReservationConflict'

type OrderErrorTranslator = (key: string, options?: Record<string, unknown>) => string

const ORDER_ERROR_TRANSLATIONS: Record<string, { key: string; fallback: string }> = {
    return_request_identity_mismatch: {
        key: 'orders.form.errors.returnRequestIdentityMismatch',
        fallback: 'This return request changed. Refresh the order before trying again.'
    },
    non_financed_order_must_be_paid: {
        key: 'orders.form.errors.non_financed_order_must_be_paid',
        fallback: 'This order must be paid in full before it can be reserved. To reserve it with an outstanding balance, select Loans or Installments as the payment method.'
    },
    financed_order_loan_missing: {
        key: 'orders.form.errors.financedOrderLoanMissing',
        fallback: 'The linked loan could not be loaded. Refresh the order and try again.'
    },
    financed_order_loan_mismatch: {
        key: 'orders.form.errors.financedOrderLoanMismatch',
        fallback: 'The linked loan changed or does not match this order. Refresh and try again.'
    },
    financed_order_has_payment_history: {
        key: 'orders.form.errors.financedOrderHasPaymentHistory',
        fallback: 'This order has payment history, so its financing terms can no longer be edited.'
    },
    financed_order_currency_locked: {
        key: 'orders.form.errors.financedOrderCurrencyLocked',
        fallback: 'The currency cannot be changed while this loan is linked.'
    },
    financed_order_total_invalid: {
        key: 'orders.form.errors.financedOrderTotalInvalid',
        fallback: 'The edited order total must be greater than zero.'
    },
    financed_order_schedule_required: {
        key: 'orders.form.errors.financedOrderScheduleRequired',
        fallback: 'Select a first due date for the installment schedule.'
    },
    financed_order_schedule_invalid: {
        key: 'orders.form.errors.financedOrderScheduleInvalid',
        fallback: 'The installment schedule is invalid. Check the date, frequency, and installment count.'
    },
    financed_order_payment_method_locked: {
        key: 'orders.form.errors.financedOrderPaymentMethodLocked',
        fallback: 'Keep the order on its existing Loan or Installments payment method.'
    },
    financed_order_not_editable: {
        key: 'orders.form.errors.financedOrderNotEditable',
        fallback: 'Only unpaid pending orders with no posted payment can be edited.'
    },
    financed_order_still_unpaid: {
        key: 'orders.form.errors.financedOrderStillUnpaid',
        fallback: 'The edited order must remain unpaid.'
    },
    financed_order_version_conflict: {
        key: 'orders.form.errors.financedOrderConflict',
        fallback: 'The order or installment schedule changed. Refresh the order and try again.'
    },
    credit_limit_exceeded: {
        key: 'orders.form.errors.financedOrderCreditLimitExceeded',
        fallback: 'The updated order exceeds the customer’s credit limit.'
    },
    missing_credit_limit_exchange_rate: {
        key: 'orders.form.errors.financedOrderCreditRateUnavailable',
        fallback: 'The customer’s credit limit cannot be checked because an exchange rate is unavailable.'
    },
    order_request_requires_approval: {
        key: 'orders.form.errors.orderRequestRequiresApproval',
        fallback: 'This order request must be approved by an admin before the normal order workflow can continue.'
    },
    sales_order_return_not_allowed: {
        key: 'orders.form.errors.salesOrderReturnNotAllowed',
        fallback: 'You do not have permission to return this sales order.'
    },
    sales_order_payment_method_not_allowed: {
        key: 'members.permissions.salesOrderPaymentMethodNotAllowed',
        fallback: 'This Sales Order payment method is not allowed for your account.'
    },
    sales_order_status_advancement_not_allowed: {
        key: 'members.permissions.salesOrderStatusNotAllowed',
        fallback: 'You cannot advance this Sales Order to the selected status.'
    },
    sales_order_permissions_unavailable: {
        key: 'members.permissions.salesOrderPermissionsUnavailable',
        fallback: 'Sales Order permissions could not be verified. Check your connection and try again.'
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

export function getLocalizedOrderError(error: unknown, t: OrderErrorTranslator, fallback = 'Action failed') {
    const reservationError = normalizeStockReservationError(error)
    if (reservationError) return reservationError.message
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
