import { createAdminClient } from '../_shared/supabase.ts'
import { computeDiscountPrice, type ResolvedWorkspaceDiscountRow } from '../_shared/discounts.ts'
import { corsHeaders, errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import {
    fetchStorefrontPriceOverride,
    getLocalizedMarketplaceOrderMessage,
    getRequesterIp,
    hashMarketplaceValue,
    isMarketplaceOriginAllowed,
    normalizeMarketplaceLanguage,
    resolveStorefrontVisibleProductIds,
    sanitizeMarketplaceText,
    sanitizeNullableMarketplaceText
} from '../_shared/marketplace.ts'
import { getCanonicalProductImagePath } from '../_shared/productImagePath.ts'

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
    cost_price: number | null
    currency: string | null
    image_url: string | null
}

type InventoryRow = {
    product_id: string
    quantity: number | null
}

const WORKSPACE_WITHOUT_MARKETPLACE_EMAIL = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'

function countDigits(value: string) {
    return value.replace(/\D/g, '').length
}

function roundQuantity(value: number) {
    const rounded = Math.round(value * 1_000_000) / 1_000_000
    return Object.is(rounded, -0) ? 0 : rounded
}

function resolveFunctionsBaseUrl() {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    if (!supabaseUrl) {
        return ''
    }

    try {
        const url = new URL(supabaseUrl)
        if (!url.hostname.endsWith('.supabase.co')) {
            return ''
        }

        return `${url.protocol}//${url.hostname.replace('.supabase.co', '.functions.supabase.co')}`
    } catch {
        return ''
    }
}

async function triggerNotificationDispatch() {
    const cronSecret = Deno.env.get('NOTIFICATION_CRON_SECRET') ?? ''
    const functionsBaseUrl = resolveFunctionsBaseUrl()

    if (!cronSecret || !functionsBaseUrl) {
        return
    }

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
            console.error(
                '[place-inquiry-order] Failed to trigger notification dispatch',
                response.status,
                await response.text()
            )
        }
    } catch (error) {
        console.error('[place-inquiry-order] Failed to trigger notification dispatch', error)
    }
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
        const requestedCustomerEmail = sanitizeNullableMarketplaceText(body.customer?.email, 120)
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

            if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
                return errorResponse('Order items are invalid')
            }

            normalizedItems.set(productId, roundQuantity((normalizedItems.get(productId) ?? 0) + quantity))
        }

        if (normalizedItems.size === 0) {
            return errorResponse('At least one order item is required')
        }

        const adminClient = createAdminClient()

        let resolvedWorkspace: WorkspaceRow
        let storefrontId: string | null = null

        const { data: workspace, error: workspaceError } = await adminClient
            .from('workspaces')
            .select('id, name, default_currency')
            .eq('store_slug', storeSlug)
            .in('visibility', ['public', 'link_only'])
            .is('deleted_at', null)
            .maybeSingle()

        if (workspaceError) {
            return errorResponse(workspaceError.message, 500)
        }

        if (workspace) {
            resolvedWorkspace = workspace as WorkspaceRow
        } else {
            const { data: storefront, error: storefrontError } = await adminClient
                .from('workspace_storefronts')
                .select('id, workspace_id')
                .eq('slug', storeSlug)
                .in('visibility', ['public', 'link_only'])
                .maybeSingle()

            if (storefrontError) {
                return errorResponse(storefrontError.message, 500)
            }

            if (!storefront) {
                return errorResponse('Store not found', 404)
            }

            const { data: storefrontWorkspace, error: storefrontWorkspaceError } = await adminClient
                .from('workspaces')
                .select('id, name, default_currency')
                .eq('id', (storefront as { workspace_id: string }).workspace_id)
                .is('deleted_at', null)
                .maybeSingle()

            if (storefrontWorkspaceError) {
                return errorResponse(storefrontWorkspaceError.message, 500)
            }

            if (!storefrontWorkspace) {
                return errorResponse('Store not found', 404)
            }

            resolvedWorkspace = storefrontWorkspace as WorkspaceRow
            storefrontId = (storefront as { id: string }).id
        }

        // This storefront accepts phone as its required contact method and
        // deliberately does not collect or retain customer email addresses.
        const customerEmail = resolvedWorkspace.id === WORKSPACE_WITHOUT_MARKETPLACE_EMAIL
            ? null
            : requestedCustomerEmail

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

        const { data: marketplaceStorageId, error: marketplaceStorageError } = await adminClient.rpc('ensure_marketplace_storage', {
            p_workspace_id: resolvedWorkspace.id
        })

        if (marketplaceStorageError) {
            return errorResponse(marketplaceStorageError.message, 500)
        }

        if (!marketplaceStorageId) {
            return errorResponse('Marketplace storage is not configured for this store', 409)
        }

        const productIds = Array.from(normalizedItems.keys())
        const [
            { data: inventoryRows, error: inventoryError },
            { data: products, error: productsError },
            { data: activeDiscounts, error: discountsError }
        ] = await Promise.all([
            adminClient
                .from('inventory')
                .select('product_id, quantity')
                .eq('workspace_id', resolvedWorkspace.id)
                .eq('storage_id', marketplaceStorageId)
                .eq('is_deleted', false)
                .in('product_id', productIds),
            adminClient
                .from('products')
                .select('id, name, sku, price, cost_price, currency, image_url')
                .eq('workspace_id', resolvedWorkspace.id)
                .eq('is_deleted', false)
                .in('id', productIds),
            adminClient.rpc('get_active_discounts_for_marketplace_storage', {
                p_workspace_id: resolvedWorkspace.id,
                p_storage_id: marketplaceStorageId
            })
        ])

        if (inventoryError) {
            return errorResponse(inventoryError.message, 500)
        }

        if (productsError) {
            return errorResponse(productsError.message, 500)
        }

        if (discountsError) {
            return errorResponse(discountsError.message, 500)
        }

        const inventoryProductIds = new Set(
            ((inventoryRows ?? []) as InventoryRow[])
                .map((row) => row.product_id)
                .filter(Boolean)
        )
        if (inventoryProductIds.size !== productIds.length) {
            return errorResponse('Some products could not be found for this store')
        }

        const productsById = new Map<string, ProductRow>()
        for (const product of (products ?? []) as ProductRow[]) {
            if (inventoryProductIds.has(product.id)) {
                productsById.set(product.id, product)
            }
        }

        if (productsById.size !== productIds.length) {
            return errorResponse('Some products could not be found for this store')
        }

        const storefrontVisibility = await resolveStorefrontVisibleProductIds(
            adminClient,
            resolvedWorkspace.id,
            productIds,
            { storefrontId }
        )
        if (storefrontVisibility) {
            const hiddenProductIds = productIds.filter((productId) => !storefrontVisibility.has(productId))
            if (hiddenProductIds.length > 0) {
                return errorResponse('Some products are no longer available in this store')
            }
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
            Array.from(productsById.values()).map((product) => (product.currency ?? resolvedWorkspace.default_currency ?? 'iqd').toLowerCase())
        )

        if (currencies.size > 1) {
            return errorResponse('Marketplace orders currently require all products in the cart to use the same currency.')
        }

        const priceOverride = await fetchStorefrontPriceOverride(adminClient, resolvedWorkspace.id, storefrontId)

        let subtotal = 0
        const orderItems = productIds.map((productId) => {
            const product = productsById.get(productId)!
            const quantity = normalizedItems.get(productId) ?? 0
            const overrideItem = priceOverride?.items.get(product.id)
            const originalUnitPrice = overrideItem?.price ?? Number(product.price ?? 0)
            const orderCurrency = (overrideItem?.currency
                ?? product.currency
                ?? resolvedWorkspace.default_currency
                ?? 'iqd').toLowerCase()
            const resolvedCostPrice = overrideItem?.cost_price != null
                ? overrideItem.cost_price
                : (product.cost_price != null ? Number(product.cost_price) : null)
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
                currency: orderCurrency,
                quantity,
                line_total: lineTotal,
                cost_price: resolvedCostPrice,
                image_url: getCanonicalProductImagePath(product.image_url),
                storage_id: marketplaceStorageId,
                discount_type: resolvedDiscount?.discount_type ?? null,
                discount_value: resolvedDiscount?.discount_value ?? null,
                discount_ends_at: resolvedDiscount?.ends_at ?? null,
                discount_source: resolvedDiscount?.source ?? null
            }
        })

        const orderCurrency = orderItems[0]?.currency ?? (resolvedWorkspace.default_currency ?? 'iqd').toLowerCase()

        const { data: insertedOrder, error: insertError } = await adminClient
            .from('marketplace_orders')
            .insert({
                workspace_id: resolvedWorkspace.id,
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
            .select('id, order_number')
            .single()

        if (insertError || !insertedOrder) {
            return errorResponse(insertError?.message ?? 'Failed to create marketplace order', 500)
        }

        const { error: queueNotificationError } = await adminClient.rpc('queue_marketplace_pending_order_notifications', {
            p_order_id: insertedOrder.id
        })

        if (queueNotificationError) {
            console.error(
                '[place-inquiry-order] Failed to queue marketplace pending-order notifications',
                queueNotificationError
            )
        } else {
            await triggerNotificationDispatch()
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
