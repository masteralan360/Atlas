import { createAdminClient } from '../_shared/supabase.ts'
import { errorResponse, jsonResponse, readJson } from '../_shared/http.ts'
import { hashMarketplaceValue, resolvePublicAssetUrl } from '../_shared/marketplace.ts'
import { getCanonicalProductImagePath } from '../_shared/productImagePath.ts'
import {
    getTrustedStorefrontClientIp,
    isWebsiteStorefrontGatewayRequest,
    JUMLA_KHALEEJ_SITE_KEY,
    loadWebsiteStorefrontContext,
    parseWebsiteStorefrontMode
} from '../_shared/websiteStorefront.ts'

type TrackingRequest = { codes?: unknown }
type StoredItem = Record<string, unknown>

function asText(value: unknown, maxLength = 300) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function asNumber(value: unknown) {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
}

function privateJsonResponse(payload: unknown) {
    return jsonResponse(payload, {
        headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'Referrer-Policy': 'no-referrer'
        }
    })
}

Deno.serve(async (req) => {
    if (req.method !== 'POST') return errorResponse('Method not allowed', 405)
    if (!isWebsiteStorefrontGatewayRequest(req)) return errorResponse('Unauthorized', 401)

    const body = await readJson<TrackingRequest>(req)
    const codes = body?.codes
    if (!Array.isArray(codes) || codes.length < 1 || codes.length > 20
        || codes.some((code) => typeof code !== 'string' || !/^[1-9][0-9]{8}$/.test(code))) {
        return errorResponse('Invalid tracking codes', 400)
    }
    const uniqueCodes = [...new Set(codes as string[])]

    try {
        const adminClient = createAdminClient()
        const context = await loadWebsiteStorefrontContext(adminClient, req)
        if ('error' in context) return errorResponse(context.error, context.status)

        const requesterIp = getTrustedStorefrontClientIp(req) ?? `unknown:${JUMLA_KHALEEJ_SITE_KEY}`
        const requesterHash = await hashMarketplaceValue(requesterIp)
        const { data: allowed, error: limitError } = await adminClient.rpc('consume_storefront_tracking_lookups', {
            p_requester_hash: requesterHash,
            p_count: 1
        })
        if (limitError) return errorResponse('Tracking is temporarily unavailable', 503)
        if (!allowed) return errorResponse('Too many tracking requests. Try again later.', 429)

        const { data, error } = await adminClient
            .from('marketplace_orders')
            .select('tracking_code, status, created_at, storefront_mode, items, subtotal, currency')
            .eq('workspace_id', context.workspace.id)
            .eq('website_storefront_key', JUMLA_KHALEEJ_SITE_KEY)
            .eq('is_deleted', false)
            .in('tracking_code', uniqueCodes)

        if (error) return errorResponse('Tracking is temporarily unavailable', 503)

        const orders = (data ?? []).flatMap((order) => {
            const mode = parseWebsiteStorefrontMode(order.storefront_mode) ?? 'retail'
            const rawItems = Array.isArray(order.items) ? order.items as StoredItem[] : []
            const delivery = rawItems.find((item) => item.metadata_type === 'jumla_khaleej_delivery_fee')
            const items = new Map<string, { name: string; image_url: string | null; quantity: number; line_total: number }>()
            for (const item of rawItems) {
                if (item.metadata_type === 'jumla_khaleej_delivery_fee') continue
                const name = asText(item.name)
                const groupId = asText(item.allocation_group_id, 100) || asText(item.product_id, 100)
                if (!name || !groupId) continue
                const current = items.get(groupId)
                if (current) {
                    current.quantity += asNumber(item.quantity)
                    current.line_total += asNumber(item.line_total)
                } else {
                    items.set(groupId, {
                        name,
                        image_url: resolvePublicAssetUrl(getCanonicalProductImagePath(asText(item.image_url, 500))),
                        quantity: asNumber(item.quantity),
                        line_total: asNumber(item.line_total)
                    })
                }
            }
            const subtotal = asNumber(order.subtotal)
            const deliveryFee = asNumber(delivery?.delivery_fee)
            const currency = asText(order.currency, 16).toLowerCase() || 'iqd'
            const deliveryCurrency = asText(delivery?.delivery_currency, 16).toLowerCase() || currency
            return [{
                tracking_code: order.tracking_code,
                status: order.status,
                created_at: order.created_at,
                mode,
                items: [...items.values()],
                subtotal,
                delivery_fee: deliveryFee,
                delivery_currency: deliveryCurrency,
                total_with_delivery: currency === deliveryCurrency ? subtotal + deliveryFee : null,
                currency
            }]
        })

        return privateJsonResponse({ orders })
    } catch (error) {
        console.error('[get-bound-storefront-order-tracking]', error instanceof Error ? error.message : error)
        return errorResponse('Tracking is temporarily unavailable', 503)
    }
})
