import { createAdminClient } from '../_shared/supabase.ts'
import { computeDiscountPrice, type ResolvedWorkspaceDiscountRow } from '../_shared/discounts.ts'
import { getJumlaKhaleejStorefrontDiscount } from '../_shared/jumlaKhaleejStorefrontDiscounts.ts'
import { errorResponse, readJson } from '../_shared/http.ts'
import {
    evaluateStorefrontPromoCode,
    normalizeStorefrontPromoCode,
    roundStorefrontOrderAmount,
    type StorefrontPromoCodeRow
} from '../_shared/storefrontPromoCodes.ts'
import {
    isWebsiteStorefrontGatewayRequest,
    loadVisibleModeProducts,
    loadWebsiteStorefrontContext,
    parseWebsiteStorefrontMode,
    resolveModePrice
} from '../_shared/websiteStorefront.ts'

type VerifyPromoRequest = {
    mode?: string
    promo_code?: string
    items?: Array<{ product_id?: string; quantity?: number }>
}

function privateJsonResponse(payload: unknown, status = 200) {
    return Response.json(payload, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

function roundQuantity(value: number) {
    const rounded = Math.round(value * 1_000_000) / 1_000_000
    return Object.is(rounded, -0) ? 0 : rounded
}

Deno.serve(async (req) => {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405)
    if (!isWebsiteStorefrontGatewayRequest(req)) return errorResponse('Unauthorized', 401)

    const body = await readJson<VerifyPromoRequest>(req)
    if (!body) return errorResponse('Invalid request body')

    try {
        const mode = parseWebsiteStorefrontMode(body.mode)
        const code = normalizeStorefrontPromoCode(body.promo_code)
        if (!mode || !Array.isArray(body.items)) {
            return errorResponse('A promo code and valid cart are required')
        }
        if (!code || code.length > 80) return privateJsonResponse({ status: 'invalid' })

        const quantitiesByProductId = new Map<string, number>()
        for (const item of body.items) {
            if (!item || typeof item !== 'object') return errorResponse('Order items are invalid')
            const productId = typeof item.product_id === 'string' ? item.product_id.trim() : ''
            const quantity = Number(item.quantity)
            if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
                return errorResponse('Order items are invalid')
            }
            quantitiesByProductId.set(productId, roundQuantity((quantitiesByProductId.get(productId) ?? 0) + quantity))
        }
        if (quantitiesByProductId.size === 0) return errorResponse('Add products before verifying a promo code')

        const adminClient = createAdminClient()
        const context = await loadWebsiteStorefrontContext(adminClient, req)
        if ('error' in context) return errorResponse(context.error, context.status)

        const { data: promoData, error: promoError } = await adminClient
            .from('storefront_promo_codes')
            .select('code, discount_type, discount_value, is_active, expires_at, max_uses, used_count')
            .eq('workspace_id', context.workspace.id)
            .eq('code', code)
            .maybeSingle()
        if (promoError) return errorResponse(promoError.message, 500)
        if (!promoData) return privateJsonResponse({ status: 'invalid' })

        const promo = promoData as StorefrontPromoCodeRow
        if (!promo.is_active) return privateJsonResponse({ status: 'inactive' })
        const expiration = promo.expires_at ? Date.parse(promo.expires_at) : null
        if (expiration !== null && (!Number.isFinite(expiration) || expiration <= Date.now())) {
            return privateJsonResponse({ status: 'expired' })
        }

        const visibleProducts = await loadVisibleModeProducts(adminClient, context, mode)
        const productIds = Array.from(quantitiesByProductId.keys())
        const productsById = new Map(visibleProducts.productRows.map((product) => [product.id, product] as const))
        const unavailable = productIds.some((productId) => !productsById.has(productId)
            || !visibleProducts.inventoryQuantityByProductId.has(productId))
        if (unavailable) return privateJsonResponse({ status: 'ineligible' })

        if (mode === 'wholesale') {
            const quantityByParent = new Map<string, number>()
            for (const productId of productIds) {
                const product = productsById.get(productId)!
                const parentId = product.parent_product_id ?? product.id
                quantityByParent.set(parentId, roundQuantity((quantityByParent.get(parentId) ?? 0) + (quantitiesByProductId.get(productId) ?? 0)))
            }
            if (Array.from(quantityByParent.values()).some((quantity) => quantity < 3)) {
                return privateJsonResponse({ status: 'ineligible' })
            }
        }

        const discountResults = await Promise.all(visibleProducts.marketplaceStorageIds.map((storageId) =>
            adminClient.rpc('get_active_discounts_for_marketplace_storage', {
                p_workspace_id: context.workspace.id,
                p_storage_id: storageId
            })
        ))
        for (const result of discountResults) {
            if (result.error) return errorResponse(result.error.message, 500)
        }

        const discountByProductId = new Map<string, ResolvedWorkspaceDiscountRow>()
        for (const result of discountResults) {
            for (const row of (result.data ?? []) as ResolvedWorkspaceDiscountRow[]) {
                if (row.is_stock_ok && !discountByProductId.has(row.product_id)) {
                    discountByProductId.set(row.product_id, { ...row, discount_value: Number(row.discount_value ?? 0) })
                }
            }
        }

        const currencies = new Set<string>()
        let subtotal = 0
        for (const productId of productIds) {
            const product = productsById.get(productId)!
            const price = resolveModePrice(product, mode, visibleProducts.priceBookItemsByProductId)
            const currency = (price.currency ?? context.workspace.default_currency ?? 'iqd').toLowerCase()
            currencies.add(currency)
            const activeDiscount = getJumlaKhaleejStorefrontDiscount(product, discountByProductId)
            const unitPrice = activeDiscount
                ? computeDiscountPrice(price.price, activeDiscount.discount_type, activeDiscount.discount_value)
                : price.price
            subtotal += unitPrice * (quantitiesByProductId.get(productId) ?? 0)
        }
        if (currencies.size !== 1) return privateJsonResponse({ status: 'ineligible' })
        subtotal = roundStorefrontOrderAmount(subtotal)

        const evaluation = evaluateStorefrontPromoCode(promo, subtotal)
        if (evaluation.status !== 'valid') return privateJsonResponse({ status: evaluation.status })

        return privateJsonResponse({
            status: 'valid',
            promo_code: promo.code,
            discount_amount: evaluation.discount_amount,
            subtotal,
            currency: Array.from(currencies)[0]
        })
    } catch (error) {
        console.error('[verify-bound-storefront-promo-code]', error)
        return errorResponse(error instanceof Error ? error.message : 'Unable to verify promo code', 500)
    }
})
