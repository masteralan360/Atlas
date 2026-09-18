import type { CurrencyCode, Product, SalesOrder } from '@/local-db/models'
import type { createSalesOrder } from '@/local-db/orders'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'

export const TEST_WORKSPACE_ID = 'a7100000-0000-4000-8000-000000000001'
export const TEST_TIME = '2026-09-18T09:00:00.000Z'

export function saleOrderInput(
    customerId: string,
    product: Product,
    storageId: string,
    method: SalesOrder['paymentMethod'],
    { currency = 'usd', quantity = 1, unitPrice = 100, paid = false, initialPayment = 0 }: {
        currency?: CurrencyCode
        quantity?: number
        unitPrice?: number
        paid?: boolean
        initialPayment?: number
    } = {}
): Parameters<typeof createSalesOrder>[1] {
    const total = Math.round(quantity * unitPrice * 1000) / 1000
    const financed = method === 'loan' || method === 'installments'
    const paidAmount = paid ? total : initialPayment
    return {
        businessPartnerId: customerId, customerId, customerName: 'Scenario Customer',
        sourceStorageId: storageId,
        commissionEnabled: false,
        items: [{
            id: crypto.randomUUID(), productId: product.id, storageId,
            productName: product.name, productSku: product.sku,
            quantity, lineTotal: total, originalCurrency: currency,
            originalUnitPrice: unitPrice, convertedUnitPrice: unitPrice,
            settlementCurrency: currency, costPrice: 40, convertedCostPrice: 40,
            reservedQuantity: 0, fulfilledQuantity: 0, batchAllocations: null
        }],
        subtotal: total, discount: 0, tax: 0, total, currency,
        exchangeRate: null, exchangeRateSource: null, exchangeRateTimestamp: null, exchangeRates: null,
        status: 'draft', expectedDeliveryDate: null, actualDeliveryDate: null,
        isPaid: paid, paymentStatus: paid ? 'paid' : paidAmount ? 'partial' : 'unpaid',
        paidAmount, balanceAmount: total - paidAmount, paidAt: paidAmount ? TEST_TIME : null,
        paymentMethod: method, initialPaymentAmount: financed ? initialPayment : 0,
        linkedLoanId: null, isInstallmentBased: method === 'installments',
        installmentCount: method === 'installments' ? 2 : 0,
        installmentFrequency: financed ? 'monthly' : null,
        firstDueDate: financed ? '2026-10-18T09:00:00.000Z' : null,
        nextDueDate: financed ? '2026-10-18T09:00:00.000Z' : null,
        reservedAt: null, shippingAddress: '', notes: 'Isolated developer scenario',
        isLocked: false, sourceChannel: 'manual', marketplaceOrderId: null, createdBy: null
    }
}

/** Reproducible inputs; the seed is also saved in every controller report. */
export function seededCases(seed: number, count: number) {
    let state = seed >>> 0
    const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state
    }
    return Array.from({ length: count }, (_, index) => ({
        index, methodIndex: (next() >>> 16) % STANDARD_PAYMENT_METHODS.length,
        quantity: ((next() >>> 8) % 19 + 1) / 2,
        unitPrice: ((next() >>> 4) % 100_000 + 1) / 1000,
        currency: (next() >>> 16) % 2 ? 'usd' as const : 'iqd' as const
    }))
}
