import { createAdminClient } from '../_shared/supabase.ts'
import { computeDiscountPrice, type ResolvedWorkspaceDiscountRow } from '../_shared/discounts.ts'
import { corsHeaders, errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import {
    getLocalizedMarketplaceOrderMessage,
    getRequesterIp,
    hashMarketplaceValue,
    isMarketplaceOriginAllowed,
    normalizeMarketplaceLanguage,
    resolvePublicAssetUrl,
    sanitizeMarketplaceText,
    sanitizeNullableMarketplaceText
} from '../_shared/marketplace.ts'

type PlaceInquiryOrderRequest = {
    store_slug?: string
    customer?: {
        name?: string
        phone?: string
        email?: string
        address?: string
        city?: string
        notes?: string
    }
    items?: Array<{
        product_id?: string
        quantity?: number
    }>
    lang?: string
}

type WorkspaceRow = {
    id: string
    name: string
    default_currency: string | null
}

type ProductRow = {
    id: string
    name: string
    sku: string
    price: number
    currency: string | null
    image_url: string | null
    storage_id: string | null
}

function countDigits(value: string) {
    return value.replace(/\D/g, '').length
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
        return errorResponse('Method not allowed', 405)
    }

    if (!isMarketplaceOriginAllowed(req.headers.get('Origin'))) {
        return errorResponse('Origin is not allowed', 403)
    }

    const body = await readJson<PlaceInquiryOrderRequest>(req)
    if (!body) {
        return errorResponse('Invalid request body')
    }

    try {
        const language = normalizeMarketplaceLanguage(body.lang)
        const storeSlug = sanitizeMarketplaceText(body.store_slug, 80).toLowerCase()
        const customerName = sanitizeMarketplaceText(body.customer?.name, 120)
        const customerPhone = sanitizeMarketplaceText(body.customer?.phone, 40)
        const customerEmail = sanitizeNullableMarketplaceText(body.customer?.email, 120)
        const customerAddress = sanitizeNullableMarketplaceText(body.customer?.address, 200)
        const customerCity = sanitizeNullableMarketplaceText(body.customer?.city, 80)
        const customerNotes = sanitizeNullableMarketplaceText(body.customer?.notes, 500)

        if (!storeSlug) {
            return errorResponse('Store slug is required')
        }

        if (!customerName) {
            return errorResponse('Customer name is required')
        }

        if (!customerPhone || countDigits(customerPhone) < 7) {
            return errorResponse('Customer phone is required')
        }

        const normalizedItems = new Map<string, number>()
        for (const item of body.items ?? []) {
            const productId = sanitizeMarketplaceText(item.product_id, 80)
            const quantity = Number(item.quantity)

            if (!productId || !Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
                return errorResponse('Order items are invalid')
            }

            normalizedItems.set(productId, (normalizedItems.get(productId) ?? 0) + quantity)
        }

        if (normalizedItems.size === 0) {
            return errorResponse('At least one order item is required')
        }

        const adminClient = createAdminClient()

        const { data: workspace, error: workspaceError } = await adminClient
            .from('workspaces')
            .select('id, name, default_currency')
            .eq('store_slug', storeSlug)
            .eq('visibility', 'public')
            .is('deleted_at', null)
            .maybeSingle()

        if (workspaceError) {
            return errorResponse(workspaceError.message, 500)
        }

        if (!workspace) {
            return errorResponse('Store not found', 404)
        }

        const requestFingerprintSource = getRequesterIp(req) ?? `unknown:${storeSlug}:${req.headers.get('Origin') ?? 'no-origin'}`
        const requestIpHash = await hashMarketplaceValue(requestFingerprintSource)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

        const { count: recentOrderCount, error: rateLimitError } = await adminClient
            .from('marketplace_orders')
            .select('id', { count: 'exact', head: true })
            .eq('request_ip_hash', requestIpHash)
            .gte('created_at', oneHourAgo)

        if (rateLimitError) {
            return errorResponse(rateLimitError.message, 500)
        }

        if ((recentOrderCount ?? 0) >= 5) {
            return errorResponse('Too many orders from this IP address. Please try again later.', 429)
        }

        const productIds = Array.from(normalizedItems.keys())
        const { data: products, error: productsError } = await adminClient
            .from('products')
            .select('id, name, sku, price, currency, image_url, storage_id')
            .eq('workspace_id', (workspace as WorkspaceRow).id)
            .eq('is_deleted', false)
            .in('id', productIds)

        if (productsError) {
            return errorResponse(productsError.message, 500)
        }

        const productsById = new Map<string, ProductRow>()
        for (const product of (products ?? []) as ProductRow[]) {
            productsById.set(product.id, product)
        }

        if (productsById.size !== productIds.length) {
            return errorResponse('Some products could not be found for this store')
        }

        const { data: activeDiscounts, error: discountsError } = await adminClient.rpc('get_active_discounts_for_workspace', {
            p_workspace_id: (workspace as WorkspaceRow).id
        })

        if (discountsError) {
            return errorResponse(discountsError.message, 500)
        }

        const discountByProductId = new Map<string, ResolvedWorkspaceDiscountRow>()
        for (const discount of (activeDiscounts ?? []) as ResolvedWorkspaceDiscountRow[]) {
            if (discount.is_stock_ok) {
                discountByProductId.set(discount.product_id, {
                    ...discount,
                    discount_value: Number(discount.discount_value ?? 0)
                })
            }
        }

        const currencies = new Set(
            Array.from(productsById.values()).map((product) => (product.currency ?? (workspace as WorkspaceRow).default_currency ?? 'iqd').toLowerCase())
        )

        if (currencies.size > 1) {
            return errorResponse('Marketplace orders currently require all products in the cart to use the same currency.')
        }

        let subtotal = 0
        const orderItems = productIds.map((productId) => {
            const product = productsById.get(productId)!
            const quantity = normalizedItems.get(productId) ?? 0
            const originalUnitPrice = Number(product.price ?? 0)
            const resolvedDiscount = discountByProductId.get(product.id)
            const unitPrice = resolvedDiscount
                ? computeDiscountPrice(originalUnitPrice, resolvedDiscount.discount_type, resolvedDiscount.discount_value)
                : originalUnitPrice
            const lineTotal = unitPrice * quantity
            subtotal += lineTotal

            return {
                product_id: product.id,
                name: product.name,
                sku: product.sku,
                unit_price: unitPrice,
                original_unit_price: originalUnitPrice,
                currency: (product.currency ?? (workspace as WorkspaceRow).default_currency ?? 'iqd').toLowerCase(),
                quantity,
                line_total: lineTotal,
                image_url: resolvePublicAssetUrl(product.image_url),
                storage_id: product.storage_id,
                discount_type: resolvedDiscount?.discount_type ?? null,
                discount_value: resolvedDiscount?.discount_value ?? null,
                discount_ends_at: resolvedDiscount?.ends_at ?? null,
                discount_source: resolvedDiscount?.source ?? null
            }
        })

        const orderCurrency = orderItems[0]?.currency ?? ((workspace as WorkspaceRow).default_currency ?? 'iqd').toLowerCase()

        const { data: insertedOrder, error: insertError } = await adminClient
            .from('marketplace_orders')
            .insert({
                workspace_id: (workspace as WorkspaceRow).id,
                customer_name: customerName,
                customer_phone: customerPhone,
                customer_email: customerEmail,
                customer_address: customerAddress,
                customer_city: customerCity,
                customer_notes: customerNotes,
                items: orderItems,
                subtotal,
                total: subtotal,
                currency: orderCurrency,
                request_ip_hash: requestIpHash
            })
            .select('order_number')
            .single()

        if (insertError || !insertedOrder) {
            return errorResponse(insertError?.message ?? 'Failed to create marketplace order', 500)
        }

        return jsonResponse(
            {
                order_number: insertedOrder.order_number,
                message: getLocalizedMarketplaceOrderMessage(language)
            },
            { status: 201 }
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
