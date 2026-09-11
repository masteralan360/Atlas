import { createAdminClient } from '../_shared/supabase.ts'
import { errorResponse, jsonResponse } from '../_shared/http.ts'
import { listMarketplaceAssetUrls, resolvePublicAssetUrl } from '../_shared/marketplace.ts'
import {
    isWebsiteStorefrontGatewayRequest,
    JUMLA_KHALEEJ_SITE_KEY,
    loadWebsiteStorefrontContext,
    parseWebsiteStorefrontMode,
    type WebsiteStorefrontMode
} from '../_shared/websiteStorefront.ts'

type ContactRow = {
    type: string
    value: string
    is_primary: boolean | null
}

type StoredInquiryItem = {
    product_id?: unknown
    allocation_group_id?: unknown
    name?: unknown
    image_url?: unknown
    unit_price?: unknown
    currency?: unknown
    unit?: unknown
    quantity?: unknown
    line_total?: unknown
    metadata_type?: unknown
    delivery_fee?: unknown
    delivery_currency?: unknown
    delivery_city_key?: unknown
}

type ProductUnitRow = {
    id: string
    unit: string | null
}

function text(value: unknown, maxLength = 500) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function nullableText(value: unknown, maxLength = 500) {
    const result = text(value, maxLength)
    return result || null
}

function finiteNumber(value: unknown) {
    const number = Number(value)
    return Number.isFinite(number) ? number : 0
}

function isMarketplaceNumber(value: string) {
    return /^MKT-[0-9]{5,}$/.test(value)
}

function isOrderId(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function privateJsonResponse(payload: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('Cache-Control', 'private, no-store, max-age=0')
    headers.set('Referrer-Policy', 'no-referrer')
    return jsonResponse(payload, { ...init, headers })
}

/**
 * Returns the minimum immutable order snapshot needed by the public document
 * viewer. It is gateway-only: browser clients never receive the storefront
 * gateway secret or a Supabase service credential.
 */
Deno.serve(async (req) => {
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405)
    if (!isWebsiteStorefrontGatewayRequest(req)) return errorResponse('Unauthorized', 401)

    const requestUrl = new URL(req.url)
    const documentNumber = requestUrl.searchParams.get('documentNumber')?.trim() ?? ''
    const orderId = requestUrl.searchParams.get('orderId')?.trim() ?? ''
    if (!isMarketplaceNumber(documentNumber)) return errorResponse('Document not found', 404)
    if (orderId && !isOrderId(orderId)) return errorResponse('Document not found', 404)

    try {
        const adminClient = createAdminClient()
        const context = await loadWebsiteStorefrontContext(adminClient, req)
        if ('error' in context) return errorResponse(context.error, context.status)

        let orderQuery = adminClient
            .from('marketplace_orders')
            .select('id, order_number, customer_name, customer_phone, customer_email, customer_address, customer_city, customer_notes, items, currency, storefront_mode, created_at')
            .eq('workspace_id', context.workspace.id)
            .eq('website_storefront_key', JUMLA_KHALEEJ_SITE_KEY)
            .eq('source_domain', context.config.primary_domain)
            .eq('order_number', documentNumber)
            .eq('is_deleted', false)
        if (orderId) orderQuery = orderQuery.eq('id', orderId)
        const { data: order, error: orderError } = await orderQuery.maybeSingle()

        if (orderError) return errorResponse(orderError.message, 500)
        if (!order) return errorResponse('Document not found', 404)

        const mode = parseWebsiteStorefrontMode(order.storefront_mode) as WebsiteStorefrontMode | null
        if (!mode) return errorResponse('Document not found', 404)

        const rawItems = Array.isArray(order.items) ? order.items as StoredInquiryItem[] : []
        const itemRows = rawItems.filter((item) => text(item.metadata_type) !== 'jumla_khaleej_delivery_fee')
        const productIdsMissingUnit = Array.from(new Set(itemRows
            .filter((item) => !text(item.unit, 80))
            .map((item) => text(item.product_id, 80))
            .filter(Boolean)))

        const [{ data: contacts, error: contactsError }, unitResult, resolvedLogoUrl] = await Promise.all([
            adminClient
                .from('workspace_contacts')
                .select('type, value, is_primary')
                .eq('workspace_id', context.workspace.id)
                .order('is_primary', { ascending: false })
                .order('created_at', { ascending: true }),
            productIdsMissingUnit.length > 0
                ? adminClient
                    .from('products')
                    .select('id, unit')
                    .eq('workspace_id', context.workspace.id)
                    .eq('is_deleted', false)
                    .in('id', productIdsMissingUnit)
                : Promise.resolve({ data: [] as ProductUnitRow[], error: null }),
            (async () => resolvePublicAssetUrl(context.workspace.logo_url)
                ?? (await listMarketplaceAssetUrls([
                    `${context.workspace.id}/workspace-logos/`,
                    `${context.workspace.id}/workspaces/`
                ], 1))[0]
                ?? null)()
        ])

        if (contactsError || unitResult.error) return errorResponse(contactsError?.message ?? unitResult.error?.message ?? 'Document unavailable', 500)

        const unitByProductId = new Map((unitResult.data as ProductUnitRow[]).map((row) => [row.id, row.unit ?? ''] as const))
        const groupedItems = new Map<string, {
            product_id: string
            name: string
            image_url: string | null
            price: number
            currency: string
            unit: string
            quantity: number
            line_total: number
        }>()

        for (const item of itemRows) {
            const productId = text(item.product_id, 80)
            const name = text(item.name, 300)
            const quantity = finiteNumber(item.quantity)
            if (!productId || !name || quantity <= 0) continue
            const groupId = text(item.allocation_group_id, 80) || productId
            const current = groupedItems.get(groupId)
            const lineTotal = finiteNumber(item.line_total)
            if (current) {
                current.quantity += quantity
                current.line_total += lineTotal
                continue
            }
            groupedItems.set(groupId, {
                product_id: productId,
                name,
                image_url: nullableText(item.image_url, 2_000),
                price: finiteNumber(item.unit_price),
                currency: text(item.currency, 16).toLowerCase() || text(order.currency, 16).toLowerCase() || 'iqd',
                unit: text(item.unit, 80) || unitByProductId.get(productId) || '',
                quantity,
                line_total: lineTotal
            })
        }

        if (groupedItems.size === 0) return errorResponse('Document not found', 404)
        const deliveryMetadata = rawItems.find((item) => text(item.metadata_type) === 'jumla_khaleej_delivery_fee')

        return privateJsonResponse({
            documentNumber: order.order_number,
            createdAt: order.created_at,
            mode,
            customer: {
                name: text(order.customer_name, 120),
                phone: text(order.customer_phone, 40),
                email: text(order.customer_email, 120),
                address: text(order.customer_address, 200),
                city: text(deliveryMetadata?.delivery_city_key, 80),
                cityLabel: text(order.customer_city, 120),
                notes: text(order.customer_notes, 500)
            },
            items: Array.from(groupedItems.values()),
            deliveryFee: finiteNumber(deliveryMetadata?.delivery_fee),
            deliveryCurrency: text(deliveryMetadata?.delivery_currency, 16).toLowerCase() || 'iqd',
            store: {
                name: context.workspace.name,
                logo_url: resolvedLogoUrl,
                contacts: ((contacts ?? []) as ContactRow[]).map((contact) => ({
                    type: text(contact.type, 40),
                    value: text(contact.value, 240),
                    is_primary: Boolean(contact.is_primary)
                })).filter((contact) => contact.type && contact.value)
            }
        })
    } catch (error) {
        console.error('[get-bound-storefront-inquiry-pdf]', error instanceof Error ? error.message : error)
        return errorResponse('Document unavailable', 500)
    }
})
