import i18n from '@/i18n/config'
import { formatCurrency } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { supabase } from '@/auth/supabase'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import type { CurrencyCode, UserRole } from './models'
import { db } from './database'

export type MinimumSellingPriceCheckItem = {
    productId: string
    /** The effective line price converted to the product's selling-price currency. */
    effectiveSellingPrice: number
    /** Number of product selling units represented by one line item unit. */
    unitFactor?: number | null
    currency?: CurrencyCode
}

export type MinimumSellingPriceViolation = {
    lineIndex: number
    productId: string
    productName: string
    minimumSellingPrice?: number
    currency: CurrencyCode
    reason?: 'currency_unavailable'
}

export class MinimumSellingPriceViolationError extends Error {
    readonly violations: MinimumSellingPriceViolation[]

    constructor(violations: MinimumSellingPriceViolation[]) {
        const first = violations[0]
        const formattedMinimum = first?.minimumSellingPrice == null
            ? ''
            : formatCurrency(first.minimumSellingPrice, first.currency)
        super(first?.reason === 'currency_unavailable'
            ? i18n.t('products.minimumSellingPrice.currencyUnavailable', {
                productName: first.productName,
                defaultValue: 'Could not verify the selling currency for {{productName}}. Refresh exchange rates and try again.'
            })
            : i18n.t('products.minimumSellingPrice.staffViolation', {
                productName: first?.productName || '',
                minimumPrice: formattedMinimum,
                defaultValue: 'Price for {{productName}} cannot be lower than {{minimumPrice}}.'
            }))
        this.name = 'MinimumSellingPriceViolationError'
        this.violations = violations
    }
}

type RemoteMinimumSellingPriceViolation = {
    line_index: number
    product_id: string
    product_name: string
    minimum_selling_price: number | string
    validation_error?: string | null
}

/**
 * Checks current product minimums before a selling transaction is persisted.
 * Cloud and Hybrid workspaces ask Supabase to re-read the current role and
 * product floors; Local mode checks the device's authoritative SQLite cache.
 */
export async function assertStaffMinimumSellingPrices(input: {
    workspaceId: string
    items: MinimumSellingPriceCheckItem[]
    actingUserRole?: UserRole
}) {
    if (input.items.length === 0) return

    if (isLocalWorkspaceMode(input.workspaceId)) {
        if (input.actingUserRole !== 'staff') return
        const products = await db.products.bulkGet(input.items.map((item) => item.productId))
        const violations = input.items.flatMap<MinimumSellingPriceViolation>((item, lineIndex) => {
            const product = products[lineIndex]
            const minimum = product?.minimumSellingPrice
            const factor = Number.isFinite(item.unitFactor) && Number(item.unitFactor) > 0
                ? Number(item.unitFactor)
                : 1
            if (product && minimum != null && item.currency && item.currency !== product.currency) {
                return [{
                    lineIndex,
                    productId: product.id,
                    productName: product.name,
                    currency: product.currency,
                    reason: 'currency_unavailable' as const
                }]
            }
            return product && minimum != null && item.effectiveSellingPrice < minimum * factor
                ? [{
                    lineIndex,
                    productId: product.id,
                    productName: product.name,
                    minimumSellingPrice: minimum * factor,
                    currency: product.currency
                }]
                : []
        })
        if (violations.length > 0) throw new MinimumSellingPriceViolationError(violations)
        return
    }

    const response = await runSupabaseAction('minimumSellingPrice.validate', () => supabase.rpc(
        'validate_staff_minimum_selling_prices',
        {
            p_workspace_id: input.workspaceId,
            p_items: input.items.map((item) => ({
                product_id: item.productId,
                effective_selling_price: item.effectiveSellingPrice,
                unit_factor: item.unitFactor ?? 1,
                currency: item.currency ?? null
            }))
        }
    ))
    if (response.error) throw normalizeSupabaseActionError(response.error)

    const rows = (response.data || []) as RemoteMinimumSellingPriceViolation[]
    if (rows.length > 0) {
        throw new MinimumSellingPriceViolationError(rows.map((row) => ({
            lineIndex: Number(row.line_index),
            productId: row.product_id,
            productName: row.product_name,
            ...(row.validation_error === 'currency_unavailable'
                ? { reason: 'currency_unavailable' as const }
                : {
                    minimumSellingPrice: Number(row.minimum_selling_price)
                        * (Number(input.items[Number(row.line_index)]?.unitFactor) || 1)
                }),
            currency: input.items[Number(row.line_index)]?.currency ?? 'usd'
        })))
    }
}
