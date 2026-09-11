import { createAdminClient } from '../_shared/supabase.ts'
import { computeDiscountPrice, type ResolvedWorkspaceDiscountRow } from '../_shared/discounts.ts'
import { errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import {
    getLocalizedMarketplaceOrderMessage,
    hashMarketplaceValue,
    normalizeMarketplaceLanguage,
    resolvePublicAssetUrl,
    sanitizeMarketplaceText,
    sanitizeNullableMarketplaceText
} from '../_shared/marketplace.ts'
import {
    getTrustedStorefrontClientIp,
    isWebsiteStorefrontGatewayRequest,
    JUMLA_KHALEEJ_SITE_KEY,
    JUMLA_KHALEEJ_WHOLESALE_MINIMUM_QUANTITY,
    allocateVisibleProductQuantity,
    loadVisibleModeProducts,
    loadWebsiteStorefrontContext,
    parseWebsiteStorefrontMode,
    resolveModePrice
} from '../_shared/websiteStorefront.ts'
import {
    createJumlaKhaleejDeliveryMetadata,
    getJumlaKhaleejDeliveryCity,
} from '../_shared/jumlaKhaleejDelivery.ts'

type PlaceStorefrontOrderRequest = {
    mode?: string
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
    checkout_request_id?: string
    lang?: string
}

function countDigits(value: string) {
    return value.replace(/\D/g, '').length
}

function roundQuantity(value: number) {
    const rounded = Math.round(value * 1_000_000) / 1_000_000
    return Object.is(rounded, -0) ? 0 : rounded
}

function isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function privateJsonResponse(payload: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('Cache-Control', 'private, no-store')
    return jsonResponse(payload, { ...init, headers })
}

function resolveFunctionsBaseUrl() {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    if (!supabaseUrl) return ''

    try {
        const url = new URL(supabaseUrl)
        if (!url.hostname.endsWith('.supabase.co')) return ''
        return `${url.protocol}//${url.hostname.replace('.supabase.co', '.functions.supabase.co')}`
    } catch {
        return ''
    }
}

async function triggerNotificationDispatch() {
    const cronSecret = Deno.env.get('NOTIFICATION_CRON_SECRET') ?? ''
    const functionsBaseUrl = resolveFunctionsBaseUrl()
    if (!cronSecret || !functionsBaseUrl) return

    try {
        const response = await fetch(`${functionsBaseUrl}/dispatch-notifications`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Cron-Secret': cronSecret
            },
            body: '{}'
        })

        if (!response.ok) {
            console.error('[place-bound-storefront-order] notification dispatch failed', response.status)
        }
    } catch (error) {
        console.error('[place-bound-storefront-order] notification dispatch failed', error)
    }
}

Deno.serve(async (req) => {
    if (req.method !== 'POST') {
        return errorResponse('Method not allowed', 405)
    }

    if (!isWebsiteStorefrontGatewayRequest(req)) {
        return errorResponse('Unauthorized', 401)
    }

    const body = await readJson<PlaceStorefrontOrderRequest>(req)
    if (!body) {
        return errorResponse('Invalid request body')
    }

    try {
        const mode = parseWebsiteStorefrontMode(body.mode)
        if (!mode) {
            return errorResponse('A valid storefront mode is required')
        }

        const language = normalizeMarketplaceLanguage(body.lang)
        const customerName = sanitizeMarketplaceText(body.customer?.name, 120)
        const customerPhone = sanitizeMarketplaceText(body.customer?.phone, 40)
        const customerEmail = sanitizeNullableMarketplaceText(body.customer?.email, 120)
        const customerAddress = sanitizeNullableMarketplaceText(body.customer?.address, 200)
        const customerCityKey = sanitizeMarketplaceText(body.customer?.city, 80)
        const customerNotes = sanitizeNullableMarketplaceText(body.customer?.notes, 500)
        const checkoutRequestId = sanitizeMarketplaceText(body.checkout_request_id, 64).toLowerCase()

        if (!customerName) return errorResponse('Customer name is required')
        if (!customerPhone || countDigits(customerPhone) < 7) return errorResponse('Customer phone is required')
        const deliveryCity = getJumlaKhaleejDeliveryCity(customerCityKey)
        if (!deliveryCity) return errorResponse('A valid delivery city is required')
        if (!isUuid(checkoutRequestId)) return errorResponse('A valid checkout request id is required')

        const normalizedItems = new Map<string, number>()
        for (const item of body.items ?? []) {
            const productId = sanitizeMarketplaceText(item.product_id, 80)
            const quantity = Number(item.quantity)
            if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
                return errorResponse('Order items are invalid')
            }
            normalizedItems.set(productId, roundQuantity((normalizedItems.get(productId) ?? 0) + quantity))
        }

        if (normalizedItems.size === 0) return errorResponse('At least one order item is required')

        const adminClient = createAdminClient()
        const context = await loadWebsiteStorefrontContext(adminClient, req)
        if ('error' in context) return errorResponse(context.error, context.status)

        const { data: existingOrder, error: existingOrderError } = await adminClient
            .from('marketplace_orders')
            .select('id, order_number')
            .eq('workspace_id', context.workspace.id)
            .eq('checkout_request_id', checkoutRequestId)
            .maybeSingle()

        if (existingOrderError) return errorResponse(existingOrderError.message, 500)
        if (existingOrder) {
            return privateJsonResponse({
                id: (existingOrder as { id: string }).id,
                order_number: (existingOrder as { order_number: string }).order_number,
                message: getLocalizedMarketplaceOrderMessage(language)
            })
        }

        const requesterIp = getTrustedStorefrontClientIp(req) ?? `unknown:${context.config.site_key}`
        const requestIpHash = await hashMarketplaceValue(requesterIp)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        const { count: recentOrderCount, error: rateLimitError } = await adminClient
            .from('marketplace_orders')
            .select('id', { count: 'exact', head: true })
            .eq('request_ip_hash', requestIpHash)
            .gte('created_at', oneHourAgo)

        if (rateLimitError) return errorResponse(rateLimitError.message, 500)
        if ((recentOrderCount ?? 0) >= 5) {
            return errorResponse('Too many orders from this IP address. Please try again later.', 429)
        }

        const visibleProducts = await loadVisibleModeProducts(adminClient, context, mode)
        if (!visibleProducts.marketplaceStorageId) {
            return errorResponse('Marketplace storage is not configured for this store', 409)
        }

        const productIds = Array.from(normalizedItems.keys())
        const inventoryProductIds = new Set(visibleProducts.inventoryRows.map((row) => row.product_id))
        const productsById = new Map(visibleProducts.productRows.map((product) => [product.id, product] as const))
        if (productIds.some((productId) => !inventoryProductIds.has(productId) || !productsById.has(productId))) {
            return errorResponse('Some products could not be found for this store')
        }

        // A wholesale MOQ belongs to the parent product, not to each child
        // variant. This lets a customer meet the minimum with a mixed set of
        // variants, for example 1 + 1 + 1 from the same parent product.
        // Resolve the group from the server-side product record so requests
        // cannot forge their own parent grouping.
        if (mode === 'wholesale') {
            const quantitiesByParentProductId = new Map<string, number>()
            for (const productId of productIds) {
                const product = productsById.get(productId)!
                const parentProductId = product.parent_product_id ?? product.id
                const nextQuantity = roundQuantity(
                    (quantitiesByParentProductId.get(parentProductId) ?? 0)
                    + (normalizedItems.get(productId) ?? 0)
                )
                quantitiesByParentProductId.set(parentProductId, nextQuantity)
            }

            const belowMinimum = Array.from(quantitiesByParentProductId.values())
                .some((quantity) => quantity < JUMLA_KHALEEJ_WHOLESALE_MINIMUM_QUANTITY)
            if (belowMinimum) {
                return errorResponse(`Select at least ${JUMLA_KHALEEJ_WHOLESALE_MINIMUM_QUANTITY} items from each product's variants before continuing`, 409)
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
        // Follow the same source priority as fulfillment: maxzan 1 before
        // maxzan 2.  A product therefore has one stable storefront price even
        // if its ordered quantity is fulfilled by both source storages.
        for (const result of discountResults) {
            for (const discount of (result.data ?? []) as ResolvedWorkspaceDiscountRow[]) {
                if (discount.is_stock_ok && !discountByProductId.has(discount.product_id)) {
                    discountByProductId.set(discount.product_id, {
                        ...discount,
                        discount_value: Number(discount.discount_value ?? 0)
                    })
                }
            }
        }

        const currencies = new Set(productIds.map((productId) => {
            const product = productsById.get(productId)!
            return (resolveModePrice(product, mode, visibleProducts.priceBookItemsByProductId).currency
                ?? context.workspace.default_currency
                ?? 'iqd').toLowerCase()
        }))
        if (currencies.size > 1) {
            return errorResponse('Marketplace orders currently require all products in the cart to use the same currency.')
        }

        let subtotal = 0
        const orderItems: Array<Record<string, unknown>> = []
        for (const productId of productIds) {
            const product = productsById.get(productId)!
            const quantity = normalizedItems.get(productId) ?? 0
            const allocation = allocateVisibleProductQuantity(visibleProducts, productId, quantity)
            if (allocation.unallocatedQuantity > 0.000001) {
                return errorResponse(`Insufficient available quantity for ${product.name}`, 409)
            }

            const resolvedPrice = resolveModePrice(product, mode, visibleProducts.priceBookItemsByProductId)
            const discount = discountByProductId.get(product.id)
            const unitPrice = discount
                ? computeDiscountPrice(resolvedPrice.price, discount.discount_type, discount.discount_value)
                : resolvedPrice.price

            // Store one immutable order-item snapshot per physical allocation.
            // The existing marketplace transition then locks and deducts each
            // exact inventory row and creates sales-order rows with the same
            // storage IDs, without changing generic Marketplace behavior.
            for (const source of allocation.allocations) {
                const allocatedQuantity = roundQuantity(source.quantity)
                if (allocatedQuantity <= 0) continue

                const lineTotal = unitPrice * allocatedQuantity
                subtotal += lineTotal
                orderItems.push({
                    product_id: product.id,
                    name: product.name,
                    sku: product.sku,
                    unit_price: unitPrice,
                    original_unit_price: resolvedPrice.price,
                    currency: (resolvedPrice.currency ?? context.workspace.default_currency ?? 'iqd').toLowerCase(),
                    quantity: allocatedQuantity,
                    line_total: lineTotal,
                    cost_price: resolvedPrice.costPrice,
                    image_url: resolvePublicAssetUrl(product.image_url),
                    unit: product.unit,
                    storage_id: source.storageId,
                    allocation_group_id: product.id,
                    allocation_group_quantity: quantity,
                    discount_type: discount?.discount_type ?? null,
                    discount_value: discount?.discount_value ?? null,
                    discount_ends_at: discount?.ends_at ?? null,
                    discount_source: discount?.source ?? null,
                    storefront_mode: mode,
                    price_book_id: mode === 'wholesale' ? context.config.wholesale_price_book_id : null
                })
            }
        }

        const currency = orderItems[0]?.currency ?? (context.workspace.default_currency ?? 'iqd').toLowerCase()
        // Delivery is immutable display metadata, never an item. Deliberately
        // append it only after subtotal has been calculated from product lines.
        // marketplace_orders.total and every downstream financial flow retain
        // the product-only subtotal value.
        orderItems.push(createJumlaKhaleejDeliveryMetadata(deliveryCity))
        const { data: insertedOrder, error: insertError } = await adminClient
            .from('marketplace_orders')
            .insert({
                workspace_id: context.workspace.id,
                customer_name: customerName,
                customer_phone: customerPhone,
                customer_email: customerEmail,
                customer_address: customerAddress,
                customer_city: deliveryCity.names[language],
                customer_notes: customerNotes,
                items: orderItems,
                subtotal,
                total: subtotal,
                currency,
                request_ip_hash: requestIpHash,
                website_storefront_key: JUMLA_KHALEEJ_SITE_KEY,
                storefront_mode: mode,
                price_book_id: mode === 'wholesale' ? context.config.wholesale_price_book_id : null,
                source_domain: context.config.primary_domain,
                checkout_request_id: checkoutRequestId
            })
            .select('id, order_number')
            .single()

        if (insertError || !insertedOrder) {
            if (insertError?.code === '23505') {
                const { data: duplicateOrder } = await adminClient
                    .from('marketplace_orders')
                    .select('id, order_number')
                    .eq('workspace_id', context.workspace.id)
                    .eq('checkout_request_id', checkoutRequestId)
                    .maybeSingle()
                if (duplicateOrder) {
                    return privateJsonResponse({
                        id: (duplicateOrder as { id: string }).id,
                        order_number: (duplicateOrder as { order_number: string }).order_number,
                        message: getLocalizedMarketplaceOrderMessage(language)
                    })
                }
            }
            return errorResponse(insertError?.message ?? 'Failed to create marketplace order', 500)
        }

        const { error: notificationError } = await adminClient.rpc('queue_marketplace_pending_order_notifications', {
            p_order_id: insertedOrder.id
        })
        if (notificationError) {
            console.error('[place-bound-storefront-order] Failed to queue notification', notificationError)
        } else {
            await triggerNotificationDispatch()
        }

        return privateJsonResponse({
            id: insertedOrder.id,
            order_number: insertedOrder.order_number,
            message: getLocalizedMarketplaceOrderMessage(language)
        }, { status: 201 })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        console.error('[place-bound-storefront-order]', error)
        return errorResponse(message, 500)
    }
})
