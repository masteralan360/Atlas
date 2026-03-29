/**
 * Offline-First Sale Verification Service
 * 
 * This module provides a pure, synchronous verification function that operates
 * entirely on immutable snapshot data captured at checkout time.
 * 
 * PRINCIPLES:
 * - Never blocks checkout
 * - Never modifies sale or inventory
 * - Uses only data passed in (no network, no DB calls)
 * - Results are immutable once recorded
 */

export type SystemReviewStatus = 'approved' | 'flagged' | 'inconsistent'

export interface VerificationResult {
    verified: boolean
    status: SystemReviewStatus
    reason: string | null
}

export interface VerificationItem {
    quantity: number
    unitPrice: number
    totalPrice: number
    convertedTotalPrice: number
    originalUnitPrice: number
    negotiatedPrice?: number | null
    inventorySnapshot: number
    originalCurrency: string
    settlementCurrency: string
}

export interface VerificationSale {
    totalAmount: number
    exchangeRate: number | null
    exchangeSource: string | null
    exchangeRates?: Array<{
        rate?: number | null
        source?: string | null
    }> | null
    settlementCurrency: string
    items: VerificationItem[]
}

export interface VerificationConfig {
    maxDiscountPercent: number // 0-100, default 100 (no limit)
}

const EPSILON = 0.01 // Tolerance for floating point comparison

/**
 * Verifies a sale using immutable snapshot data.
 * This function is pure and synchronous - it has no side effects.
 */
export function verifySale(
    sale: VerificationSale,
    config: VerificationConfig
): VerificationResult {
    const flags: string[] = []

    // 1. Math Integrity: sum(items.convertedTotalPrice) should closely match sale.totalAmount
    const itemsTotal = sale.items.reduce((sum, item) => sum + item.convertedTotalPrice, 0)
    if (Math.abs(itemsTotal - sale.totalAmount) > EPSILON) {
        flags.push(`Total mismatch: items sum to ${itemsTotal.toFixed(2)}, sale total is ${sale.totalAmount.toFixed(2)}`)
    }

    // 2. Quantity Validity: no zero or negative quantities
    for (let i = 0; i < sale.items.length; i++) {
        const item = sale.items[i]
        if (item.quantity <= 0) {
            flags.push(`Item ${i + 1}: Invalid quantity (${item.quantity})`)
        }
    }

    // 3. Negotiated Price Integrity
    for (let i = 0; i < sale.items.length; i++) {
        const item = sale.items[i]
        if (item.negotiatedPrice != null) {
            // Check for negative negotiated price
            if (item.negotiatedPrice < 0) {
                flags.push(`Item ${i + 1}: Negative negotiated price`)
                continue
            }

            // Check discount percentage against workspace limit
            const originalPrice = item.originalUnitPrice
            if (originalPrice > 0) {
                const discountPercent = ((originalPrice - item.negotiatedPrice) / originalPrice) * 100
                if (discountPercent > config.maxDiscountPercent) {
                    flags.push(`Item ${i + 1}: Discount ${discountPercent.toFixed(1)}% exceeds limit of ${config.maxDiscountPercent}%`)
                }
            }
        }
    }

    // 4. Exchange Rate Integrity: required for mixed currencies
    const hasMixedCurrency = sale.items.some(
        item => item.originalCurrency !== sale.settlementCurrency
    )
    if (hasMixedCurrency) {
        const hasSnapshotRate = sale.exchangeRates?.some(rate => (rate?.rate ?? 0) > 0) ?? false
        const hasSnapshotSource = sale.exchangeRates?.some(rate => !!rate?.source && rate.source !== 'none') ?? false

        if (!hasSnapshotRate && (!sale.exchangeRate || sale.exchangeRate === 0)) {
            flags.push('Missing exchange rate for multi-currency sale')
        }
        if (!hasSnapshotSource && (!sale.exchangeSource || sale.exchangeSource === 'none')) {
            flags.push('Missing exchange rate source')
        }
    }

    // 5. Inventory Integrity: quantity sold should not exceed snapshot
    for (let i = 0; i < sale.items.length; i++) {
        const item = sale.items[i]
        if (item.quantity > item.inventorySnapshot) {
            flags.push(`Item ${i + 1}: Quantity ${item.quantity} exceeds inventory snapshot ${item.inventorySnapshot}`)
        }
    }

    // Determine final status
    if (flags.length === 0) {
        return {
            verified: true,
            status: 'approved',
            reason: null
        }
    }

    return {
        verified: false,
        status: 'flagged',
        reason: flags.join('; ')
    }
}

/**
 * Creates a verification-ready sale object from checkout data.
 * This extracts only the immutable fields needed for verification.
 */
export function createVerificationSale(
    totalAmount: number,
    settlementCurrency: string,
    exchangeRate: number | null,
    exchangeSource: string | null,
    items: Array<{
        quantity: number
        unit_price: number
        total_price: number
        total: number // Converted total in settlement currency
        original_unit_price: number
        negotiated_price?: number | null
        inventory_snapshot: number
        original_currency: string
        settlement_currency: string
    }>,
    exchangeRates?: Array<{
        rate?: number | null
        source?: string | null
    }> | null
): VerificationSale {
    return {
        totalAmount,
        settlementCurrency,
        exchangeRate,
        exchangeSource,
        exchangeRates: exchangeRates ?? null,
        items: items.map(item => ({
            quantity: item.quantity,
            unitPrice: item.unit_price,
            totalPrice: item.total_price,
            convertedTotalPrice: item.total,
            originalUnitPrice: item.original_unit_price,
            negotiatedPrice: item.negotiated_price,
            inventorySnapshot: item.inventory_snapshot,
            originalCurrency: item.original_currency,
            settlementCurrency: item.settlement_currency
        }))
    }
}
