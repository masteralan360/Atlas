import { db } from '@/local-db/database'
import type { CurrencyCode } from '@/local-db/models'
import type { PosCheckoutInput } from '@/local-db/posCheckout'
import { CASH_AND_DIGITAL_PAYMENT_METHODS } from '@/lib/paymentMethods'

export const POS_WORKSPACE = 'a7200000-0000-4000-8000-000000000001'
export const POS_PRODUCT = 'a7200000-0000-4000-8000-000000000002'
export const POS_STORAGE = 'a7200000-0000-4000-8000-000000000003'
export const POS_INVENTORY = 'a7200000-0000-4000-8000-000000000004'
export const POS_BATCH = 'a7200000-0000-4000-8000-000000000005'
export const POS_TIME = '2026-09-18T09:00:00.000Z'
export const POS_METHODS = CASH_AND_DIGITAL_PAYMENT_METHODS
export const POS_CURRENCIES = ['usd', 'iqd', 'eur', 'try'] as const

export async function seedPosStock(currency: CurrencyCode = 'usd', service = false) {
    const base = { workspaceId: POS_WORKSPACE, createdAt: POS_TIME, updatedAt: POS_TIME,
        version: 1, isDeleted: false, syncStatus: 'synced' as const, lastSyncedAt: POS_TIME }
    await db.storages.put({ id: POS_STORAGE, ...base, name: 'POS test storage',
        isSystem: false, isProtected: false, isPrimary: true, isMarketplace: false })
    await db.products.put({ id: POS_PRODUCT, ...base, sku: 'DEV-POS', name: 'POS scenario item',
        description: '', categoryId: null, price: 100, costPrice: service ? 0 : 40,
        quantity: service ? 0 : 20, minStockLevel: 0, unit: 'pcs', currency, canBeReturned: true, isService: service })
    if (!service) {
        await db.inventory.put({ id: POS_INVENTORY, ...base, productId: POS_PRODUCT, storageId: POS_STORAGE, quantity: 20 })
        await db.stock_batches.put({ id: POS_BATCH, ...base, productId: POS_PRODUCT, storageId: POS_STORAGE,
            batchNumber: 'POS-1', quantity: 20, price: 100, costPrice: 40, currency,
            expiryDate: null, manufacturingDate: null, notes: null, sourcePurchaseOrderId: null, sourcePurchaseOrderItemId: null })
    }
}

export function posCheckoutInput({ currency = 'usd', method = 'cash', service = false,
    quantity = 1, unitPrice = 100 }: {
        currency?: CurrencyCode; method?: PosCheckoutInput['payload']['payment_method']
        service?: boolean; quantity?: number; unitPrice?: number
    } = {}): PosCheckoutInput {
    const allocation = { batchId: POS_BATCH, batchNumber: 'POS-1', quantity, price: 100, costPrice: 40, currency }
    return {
        payload: { id: crypto.randomUUID(), workspace_id: POS_WORKSPACE, origin: 'pos',
            total_amount: unitPrice * quantity, settlement_currency: currency,
            currency_conversion_applied: false, sales_exchange: [], payment_method: method,
            items: [{ product_id: POS_PRODUCT, storage_id: service ? null : POS_STORAGE,
                product_name: 'POS scenario item', product_sku: 'DEV-POS', created_at: POS_TIME, updated_at: POS_TIME,
                quantity, unit_price: unitPrice, total_price: unitPrice * quantity,
                cost_price: service ? 0 : 40, converted_cost_price: service ? 0 : 40,
                original_currency: currency, original_unit_price: 100, converted_unit_price: unitPrice,
                settlement_currency: currency, price_book_id: null, total: unitPrice * quantity,
                inventory_snapshot: service ? null : 20, batch_allocations: service ? null : [{
                    batch_id: POS_BATCH, batch_number: 'POS-1', quantity, price: 100, cost_price: 40, currency,
                    expiry_date: null, manufacturing_date: null
                }] }] },
        user: { id: 'a7200000-0000-4000-8000-000000000006', name: 'POS test cashier' },
        timestamp: POS_TIME, exchangeRates: null, primaryRate: null, maxDiscountPercent: 100,
        batchPlans: service ? [] : [{ productId: POS_PRODUCT, storageId: POS_STORAGE, allocations: [allocation] }],
        atomicLoanPayload: null, account: null
    }
}

export function financePosInput(input: PosCheckoutInput, count = 1) {
    input.payload.payment_method = 'loan'
    input.loanRegistration = { borrowerName: 'POS test borrower', borrowerPhone: '07500000000',
        borrowerAddress: 'Test address', borrowerNationalId: 'TEST', installmentCount: count,
        installmentFrequency: 'monthly', firstDueDate: '2026-10-18T09:00:00.000Z' }
    input.atomicLoanPayload = { id: crypto.randomUUID(), workspace_id: POS_WORKSPACE, sale_id: input.payload.id,
        source: 'pos', loan_category: count > 1 ? 'standard' : 'simple', direction: 'lent',
        borrower_name: 'POS test borrower', borrower_phone: '07500000000', borrower_address: 'Test address',
        principal_amount: input.payload.total_amount, settlement_currency: input.payload.settlement_currency,
        installment_count: count, installment_frequency: 'monthly', first_due_date: input.loanRegistration.firstDueDate,
        created_by: input.user.id, installments: Array.from({ length: count }, () => ({ id: crypto.randomUUID() })) }
    return input
}

/** POS owns its generator; it is independent of the Sale Orders V1 fixture. */
export function seededPosCases(seed: number, count: number) {
    let state = seed >>> 0
    const next = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state >>> 8 }
    return Array.from({ length: count }, (_, index) => ({ index,
        method: POS_METHODS[next() % POS_METHODS.length], currency: POS_CURRENCIES[next() % POS_CURRENCIES.length],
        quantity: (next() % 75 + 1) / 4, unitPrice: (next() % 10000 + 1) / 4, service: next() % 3 === 0 }))
}
