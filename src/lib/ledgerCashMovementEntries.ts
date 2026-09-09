import type { CurrencyCode, Loan, PaymentTransaction, Sale } from '@/local-db/models'

import { getInstallmentSaleLedgerPayment } from './installmentSaleLedger'
import { classifySalesOrderLoanCash } from './ledgerOrderLoan'
import { getLedgerPaymentTransactionEffect } from './ledgerPaymentTransactions'
import type { LedgerCashSummaryEntry } from './ledgerCashSummary'

export interface LedgerCashMovementEntry extends LedgerCashSummaryEntry {
    date: string
    currency: CurrencyCode
}

type SaleCashMovementSource = Pick<
    Sale,
    'createdAt' | 'isDeleted' | 'isReturned' | 'origin' | 'payment_method' | 'settlementCurrency' | 'totalAmount'
> & {
    paymentMethod?: string | null
    paymentType?: string | null
    digitalProvider?: string | null
}

export interface ExchangeCashMovementSource {
    createdAt: string
    transactionDate?: string | null
    transactionType?: string | null
    profitAmount?: number | null
    profitCurrency?: CurrencyCode | null
    fromCurrency?: CurrencyCode | null
    isDeleted?: boolean
    isReversed?: boolean
}

function resolveSalePaymentMethod(sale: SaleCashMovementSource) {
    const directMethod = typeof sale.payment_method === 'string' && sale.payment_method.trim() ? sale.payment_method.trim() : null
    if (directMethod) return directMethod

    const legacyMethod = typeof sale.paymentMethod === 'string' && sale.paymentMethod.trim() ? sale.paymentMethod.trim() : null
    if (legacyMethod) return legacyMethod

    if (sale.paymentType === 'digital') {
        return typeof sale.digitalProvider === 'string' && sale.digitalProvider.trim() ? sale.digitalProvider.trim() : null
    }

    if (sale.paymentType === 'cash' || sale.paymentType === 'loan') return sale.paymentType

    return null
}

function applyPaymentReversal(
    movement: LedgerCashMovementEntry,
    transaction: Pick<PaymentTransaction, 'amount' | 'direction' | 'reversalOfTransactionId'>,
) {
    if (!transaction.reversalOfTransactionId) return movement

    const effect = getLedgerPaymentTransactionEffect(transaction)
    return { ...movement, ...effect }
}

export function getLedgerCashMovementFromSale(sale: SaleCashMovementSource): LedgerCashMovementEntry | null {
    if (sale.isDeleted || sale.isReturned || (sale.origin !== 'pos' && sale.origin !== 'instant_pos')) return null
    if (resolveSalePaymentMethod(sale) === 'loan') return null

    return {
        date: sale.createdAt,
        type: sale.origin === 'instant_pos' ? 'instant_pos_sale' : 'pos_sale',
        direction: 'incoming',
        amount: sale.totalAmount || 0,
        currency: sale.settlementCurrency,
    }
}

export function getLedgerCashMovementFromExchange(
    transaction: ExchangeCashMovementSource,
): LedgerCashMovementEntry | null {
    if (
        transaction.isDeleted ||
        transaction.isReversed ||
        transaction.transactionType !== 'sell' ||
        transaction.profitAmount == null ||
        transaction.profitAmount <= 0
    ) {
        return null
    }

    return {
        date: transaction.transactionDate || transaction.createdAt,
        type: 'exchange_profit',
        direction: 'incoming',
        amount: transaction.profitAmount,
        currency: transaction.profitCurrency || transaction.fromCurrency || 'usd',
    }
}

export function getLedgerCashMovementFromPayment(
    transaction: PaymentTransaction,
    loan?: Pick<Loan, 'source' | 'orderId' | 'orderType'> | null,
): LedgerCashMovementEntry | null {
    if (transaction.isDeleted || transaction.paymentMethod === 'loan' || transaction.paymentMethod === 'loan_adjustment') {
        return null
    }

    const createMovement = (
        type: string,
        direction: LedgerCashMovementEntry['direction'],
        amount = transaction.amount,
    ) =>
        applyPaymentReversal(
            {
                date: transaction.paidAt,
                type,
                direction,
                amount,
                currency: transaction.currency,
            },
            transaction,
        )

    if (transaction.sourceType === 'direct_transaction') {
        return createMovement(transaction.direction === 'incoming' ? 'direct_inflow' : 'direct_outflow', transaction.direction)
    }

    if (transaction.sourceType === 'payment_account_opening_balance') {
        return createMovement('payment_account_opening_balance', 'opening')
    }

    if (
        transaction.sourceType === 'payment_account_deposit' ||
        transaction.sourceType === 'payment_account_withdrawal' ||
        transaction.sourceType === 'payment_account_adjustment'
    ) {
        return createMovement(
            transaction.sourceType,
            transaction.sourceType === 'payment_account_adjustment' ? 'adjustment' : transaction.direction,
        )
    }

    const installmentSalePayment = getInstallmentSaleLedgerPayment(transaction)
    if (installmentSalePayment) return createMovement(installmentSalePayment.type, 'incoming')

    switch (transaction.sourceType) {
        case 'delivery_courier_remittance':
        case 'delivery_courier_fee_payout':
        case 'delivery_courier_reimbursement':
        case 'delivery_merchant_payout':
        case 'delivery_recipient_payout':
        case 'delivery_merchant_repayment':
        case 'rental_payment':
        case 'rental_deposit':
        case 'rental_deposit_refund':
        case 'activity_transaction':
        case 'activity_refund':
            return createMovement(transaction.sourceType, transaction.direction)
        case 'loan_origination':
            return createMovement(transaction.direction === 'incoming' ? 'loan_taken' : 'loan_given', transaction.direction)
        case 'sales_order': {
            if (transaction.metadata?.receivable) return null
            const sourceChannel = typeof transaction.metadata?.sourceChannel === 'string' ? transaction.metadata.sourceChannel.trim().toLowerCase() : null
            return createMovement(sourceChannel === 'marketplace' ? 'ecommerce_payment' : 'sales_order_payment', 'incoming')
        }
        case 'purchase_order':
            return createMovement('purchase_order_payment', 'outgoing')
        case 'expense_item':
            return createMovement('expense', 'outgoing')
        case 'payroll_status':
            return createMovement('payroll_payment', 'outgoing')
        case 'real_estate_payment':
        case 'real_estate_installment':
            return null
        case 'travel_booking_payment':
            return createMovement('travel_booking_profit', 'incoming')
        case 'real_estate_commission':
            return createMovement('real_estate_commission', 'incoming')
        case 'clinical_appointment':
            return createMovement('clinical_appointment_payment', 'incoming')
        case 'loan_installment':
        case 'loan_payment':
        case 'simple_loan': {
            const orderLoanCash = classifySalesOrderLoanCash(transaction, loan)
            return orderLoanCash
                ? createMovement(orderLoanCash.type, orderLoanCash.direction, orderLoanCash.amount)
                : createMovement(
                      transaction.direction === 'incoming'
                          ? transaction.sourceType === 'loan_installment'
                              ? 'installment_received'
                              : 'loan_repayment_received'
                          : transaction.sourceType === 'loan_installment'
                            ? 'installment_paid'
                            : 'loan_repayment_paid',
                      transaction.direction,
                  )
        }
        case 'order_return': {
            const orderLoanCash = classifySalesOrderLoanCash(transaction)
            return orderLoanCash ? createMovement(orderLoanCash.type, orderLoanCash.direction, orderLoanCash.amount) : null
        }
        case 'agent_commission_payout':
            return createMovement('agent_commission_payout', 'outgoing')
        default:
            return null
    }
}

export function getLedgerCashMovementEntries({
    sales = [],
    paymentTransactions = [],
    loans = [],
    exchangeTransactions = [],
}: {
    sales?: readonly SaleCashMovementSource[]
    paymentTransactions?: readonly PaymentTransaction[]
    loans?: readonly Pick<Loan, 'id' | 'source' | 'orderId' | 'orderType'>[]
    exchangeTransactions?: readonly ExchangeCashMovementSource[]
}) {
    const loanById = new Map(loans.map((loan) => [loan.id, loan]))

    return [
        ...sales.map(getLedgerCashMovementFromSale),
        ...paymentTransactions.map((transaction) => getLedgerCashMovementFromPayment(transaction, loanById.get(transaction.sourceRecordId))),
        ...exchangeTransactions.map(getLedgerCashMovementFromExchange),
    ].filter((entry): entry is LedgerCashMovementEntry => entry !== null)
}
