import { createAdminClient } from '../_shared/supabase.ts'
import { computeDiscountPrice, type ResolvedWorkspaceDiscountRow } from '../_shared/discounts.ts'
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/http.ts'
import {
    fetchStorefrontPriceOverride,
    listMarketplaceAssetUrls,
    resolvePublicAssetUrl,
    resolveStorefrontVisibleProductIds,
    sanitizeMarketplaceText
} from '../_shared/marketplace.ts'

const PRODUCT_PAGE_SIZE = 48

type WorkspaceRow = {
    id: string
    name: string
    store_slug: string | null
    store_description: string | null
    logo_url: string | null
    default_currency: string | null
}
type ProductRow = {
    id: string
    name: string
    sku: string
    description: string | null
    price: number
    currency: string | null
    unit: string | null
    category_id: string | null
    image_url: string | null
    created_at: string | null
}
type CategoryRow = { id: string; name: string }
type ContactRow = { type: string; value: string; label: string | null; is_primary: boolean | null }
type InventoryRow = { product_id: string; created_at: string | null }
type StorefrontRow = { id: string; workspace_id: string; slug: string; description: string | null; visibility: string }
type CatalogSort = 'featured' | 'newest'
type ProductCursor = { sort: CatalogSort; name: string; id: string; addedAt: number }
type MappedProduct = {
    id: string
    name: string
    sku: string
    description: string
    price: number
    currency: string
    unit: string
    category_id: string | null
    category_name: string | null
    image_url: string | null
    discount_price: number | null
    discount_type: string | null
    discount_value: number | null
    discount_ends_at: string | null
    marketplace_added_at: string | null
    addedAt: number
}

function buildStorePayload(workspace: WorkspaceRow, description: string | null, logoUrl: string | null, contacts: ContactRow[]) {
    return {
        workspace_id: workspace.id,
        name: workspace.name,
        slug: workspace.store_slug,
        description,
        logo_url: logoUrl,
        currency: workspace.default_currency ?? 'iqd',
        contacts: contacts.map((contact) => ({
            type: contact.type,
            value: contact.value,
            label: contact.label,
            is_primary: Boolean(contact.is_primary)
        }))
    }
}

function getTimestamp(value: string | null) {
    if (!value) return 0
    const timestamp = new Date(value).getTime()
    return Number.isFinite(timestamp) ? timestamp : 0
}

function getEffectivePrice(product: Pick<MappedProduct, 'price' | 'discount_price'>) {
    return typeof product.discount_price === 'number' && product.discount_price < product.price
        ? product.discount_price
        : product.price
}

function encodeCursor(cursor: ProductCursor) {
    const bytes = new TextEncoder().encode(JSON.stringify(cursor))
    const encoded = btoa(String.fromCharCode(...bytes))
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(value: string | null): ProductCursor | null {
    if (!value) return null
    try {
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
        const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
        const cursor = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ProductCursor>
        if ((cursor.sort !== 'featured' && cursor.sort !== 'newest') || typeof cursor.name !== 'string' || typeof cursor.id !== 'string' || typeof cursor.addedAt !== 'number') return null
        return cursor as ProductCursor
    } catch {
        return null
    }
}

function compareProducts(left: Pick<MappedProduct, 'name' | 'id' | 'addedAt'>, right: Pick<ProductCursor, 'name' | 'id' | 'addedAt'>, sort: CatalogSort) {
    if (sort === 'newest') {
        const dateComparison = right.addedAt - left.addedAt
        if (dateComparison) return dateComparison
    }
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

async function resolveStorefront(
    adminClient: ReturnType<typeof createAdminClient>,
    slug: string
): Promise<{ workspace: WorkspaceRow; storefrontId: string | null; description: string | null } | { error: string; status: number }> {
    const { data: primaryWorkspace, error: workspaceError } = await adminClient
        .from('workspaces')
        .select('id, name, store_slug, store_description, logo_url, default_currency')
        .eq('store_slug', slug)
        .in('visibility', ['public', 'link_only'])
        .is('deleted_at', null)
        .maybeSingle()
    if (workspaceError) return { error: workspaceError.message, status: 500 }
    if (primaryWorkspace) {
        const workspace = primaryWorkspace as WorkspaceRow
        return { workspace, storefrontId: null, description: workspace.store_description }
    }

    const { data: storefront, error: storefrontError } = await adminClient
        .from('workspace_storefronts')
        .select('id, workspace_id, slug, description, visibility')
        .eq('slug', slug)
        .in('visibility', ['public', 'link_only'])
        .maybeSingle()
    if (storefrontError) return { error: storefrontError.message, status: 500 }
    if (!storefront) return { error: 'Store not found', status: 404 }

    const resolvedStorefront = storefront as StorefrontRow
    const { data: workspace, error: storefrontWorkspaceError } = await adminClient
        .from('workspaces')
        .select('id, name, store_slug, store_description, logo_url, default_currency')
        .eq('id', resolvedStorefront.workspace_id)
        .is('deleted_at', null)
        .maybeSingle()
    if (storefrontWorkspaceError) return { error: storefrontWorkspaceError.message, status: 500 }
    if (!workspace) return { error: 'Store not found', status: 404 }
    return { workspace: workspace as WorkspaceRow, storefrontId: resolvedStorefront.id, description: resolvedStorefront.description }
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

    try {
        const url = new URL(req.url)
        const slug = sanitizeMarketplaceText(url.searchParams.get('slug'), 80).toLowerCase()
        if (!slug) return errorResponse('Store slug is required')

        const sort: CatalogSort = url.searchParams.get('sort') === 'newest' ? 'newest' : 'featured'
        const search = sanitizeMarketplaceText(url.searchParams.get('q'), 120).toLocaleLowerCase()
        const categoryId = sanitizeMarketplaceText(url.searchParams.get('category_id'), 80) || null
        const priceMaxInput = Number(url.searchParams.get('price_max'))
        const priceMax = Number.isFinite(priceMaxInput) && priceMaxInput >= 0 ? priceMaxInput : null
        const currency = sanitizeMarketplaceText(url.searchParams.get('currency'), 16).toLowerCase() || null
        const includeProducts = url.searchParams.get('include_products') !== 'false'
        const rawCursor = url.searchParams.get('cursor')
        const cursor = decodeCursor(rawCursor)
        if (rawCursor && (!cursor || cursor.sort !== sort)) return errorResponse('Invalid pagination cursor')

        const adminClient = createAdminClient()
        const resolved = await resolveStorefront(adminClient, slug)
        if ('error' in resolved) return errorResponse(resolved.error, resolved.status)

        const [{ data: contacts, error: contactsError }, { data: marketplaceStorageId, error: marketplaceStorageError }] = await Promise.all([
            adminClient.from('workspace_contacts').select('type, value, label, is_primary').eq('workspace_id', resolved.workspace.id).order('is_primary', { ascending: false }).order('created_at', { ascending: true }),
            adminClient.rpc('ensure_marketplace_storage', { p_workspace_id: resolved.workspace.id })
        ])
        if (contactsError) return errorResponse(contactsError.message, 500)
        if (marketplaceStorageError) return errorResponse(marketplaceStorageError.message, 500)

        const storeContacts = (contacts ?? []) as ContactRow[]
        const logoUrl = resolvePublicAssetUrl(resolved.workspace.logo_url)
            ?? (await listMarketplaceAssetUrls([`${resolved.workspace.id}/workspace-logos/`, `${resolved.workspace.id}/workspaces/`], 1))[0]
            ?? null
        const store = buildStorePayload(resolved.workspace, resolved.description, logoUrl, storeContacts)
        const emptyPayload = { store, categories: [], products: [], total_products: 0, has_more: false, next_cursor: null }
        if (!includeProducts || !marketplaceStorageId) {
            return jsonResponse(emptyPayload, { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=120' } })
        }

        const [{ data: inventoryRows, error: inventoryError }, { data: activeDiscounts, error: discountsError }] = await Promise.all([
            adminClient.from('inventory').select('product_id, created_at').eq('workspace_id', resolved.workspace.id).eq('storage_id', marketplaceStorageId).eq('is_deleted', false),
            adminClient.rpc('get_active_discounts_for_marketplace_storage', { p_workspace_id: resolved.workspace.id, p_storage_id: marketplaceStorageId })
        ])
        if (inventoryError) return errorResponse(inventoryError.message, 500)
        if (discountsError) return errorResponse(discountsError.message, 500)

        let visibleProductIds = Array.from(new Set(((inventoryRows ?? []) as InventoryRow[]).map((row) => row.product_id).filter(Boolean)))
        const storefrontVisibility = await resolveStorefrontVisibleProductIds(adminClient, resolved.workspace.id, visibleProductIds, { storefrontId: resolved.storefrontId })
        if (storefrontVisibility) visibleProductIds = visibleProductIds.filter((productId) => storefrontVisibility.has(productId))
        if (visibleProductIds.length === 0) {
            return jsonResponse(emptyPayload, { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=120' } })
        }

        const { data: products, error: productsError } = await adminClient
            .from('products')
            .select('id, name, sku, description, price, currency, unit, category_id, image_url, created_at')
            .eq('workspace_id', resolved.workspace.id)
            .eq('is_deleted', false)
            .in('id', visibleProductIds)
        if (productsError) return errorResponse(productsError.message, 500)

        const productRows = (products ?? []) as ProductRow[]
        const categoryIds = Array.from(new Set(productRows.map((product) => product.category_id).filter((value): value is string => Boolean(value))))
        const [{ data: categories, error: categoryError }, priceOverride] = await Promise.all([
            categoryIds.length > 0
                ? adminClient.from('categories').select('id, name').in('id', categoryIds).eq('is_deleted', false).order('name', { ascending: true })
                : Promise.resolve({ data: [], error: null }),
            fetchStorefrontPriceOverride(adminClient, resolved.workspace.id, resolved.storefrontId)
        ])
        if (categoryError) return errorResponse(categoryError.message, 500)

        const categoryNameById = new Map(((categories ?? []) as CategoryRow[]).map((category) => [category.id, category.name] as const))
        const categoryCoverUrlById = new Map<string, string>()
        for (const product of productRows) {
            if (product.category_id && !categoryCoverUrlById.has(product.category_id)) {
                const imageUrl = resolvePublicAssetUrl(product.image_url)
                if (imageUrl) categoryCoverUrlById.set(product.category_id, imageUrl)
            }
        }
        const marketplaceAddedAtByProductId = new Map(((inventoryRows ?? []) as InventoryRow[]).map((row) => [row.product_id, row.created_at] as const))
        const discountByProductId = new Map<string, ResolvedWorkspaceDiscountRow>()
        for (const discount of (activeDiscounts ?? []) as ResolvedWorkspaceDiscountRow[]) {
            if (discount.is_stock_ok) discountByProductId.set(discount.product_id, { ...discount, discount_value: Number(discount.discount_value ?? 0) })
        }

        const mappedProducts: MappedProduct[] = productRows.map((product) => {
            const overrideItem = priceOverride?.items.get(product.id)
            const basePrice = overrideItem?.price ?? Number(product.price ?? 0)
            const resolvedDiscount = discountByProductId.get(product.id)
            const marketplaceAddedAt = marketplaceAddedAtByProductId.get(product.id) ?? product.created_at ?? null
            return {
                id: product.id,
                name: product.name,
                sku: product.sku,
                description: product.description ?? '',
                price: basePrice,
                currency: overrideItem?.currency ?? product.currency ?? resolved.workspace.default_currency ?? 'iqd',
                unit: product.unit ?? 'pcs',
                category_id: product.category_id,
                category_name: product.category_id ? categoryNameById.get(product.category_id) ?? null : null,
                image_url: resolvePublicAssetUrl(product.image_url),
                discount_price: resolvedDiscount ? computeDiscountPrice(basePrice, resolvedDiscount.discount_type, resolvedDiscount.discount_value) : null,
                discount_type: resolvedDiscount?.discount_type ?? null,
                discount_value: resolvedDiscount?.discount_value ?? null,
                discount_ends_at: resolvedDiscount?.ends_at ?? null,
                marketplace_added_at: marketplaceAddedAt,
                addedAt: getTimestamp(marketplaceAddedAt)
            }
        })
        const matches = mappedProducts
            .filter((product) => !categoryId || product.category_id === categoryId)
            .filter((product) => !search || `${product.name} ${product.sku} ${product.description} ${product.category_name ?? ''}`.toLocaleLowerCase().includes(search))
            .filter((product) => {
                if (priceMax === null) return true
                if (currency && product.currency.toLowerCase() !== currency) return false
                return getEffectivePrice(product) <= priceMax
            })
            .sort((left, right) => compareProducts(left, right, sort))
        const afterCursor = cursor ? matches.filter((product) => compareProducts(product, cursor, sort) > 0) : matches
        const pageProducts = afterCursor.slice(0, PRODUCT_PAGE_SIZE)
        const hasMore = afterCursor.length > pageProducts.length
        const missingImageCount = pageProducts.filter((product) => !product.image_url).length
        const fallbackImageUrls = missingImageCount > 0 ? await listMarketplaceAssetUrls([`${resolved.workspace.id}/product-images/`], missingImageCount) : []
        let fallbackImageIndex = 0
        const responseProducts = pageProducts.map(({ addedAt: _addedAt, ...product }) => ({
            ...product,
            image_url: product.image_url ?? fallbackImageUrls[fallbackImageIndex++] ?? logoUrl
        }))
        const lastProduct = pageProducts.at(-1)

        return jsonResponse({
            store,
            categories: ((categories ?? []) as CategoryRow[]).map((category) => ({
                id: category.id,
                name: category.name,
                cover_url: categoryCoverUrlById.get(category.id) ?? null
            })),
            products: responseProducts,
            total_products: matches.length,
            has_more: hasMore,
            next_cursor: hasMore && lastProduct
                ? encodeCursor({ sort, name: lastProduct.name, id: lastProduct.id, addedAt: lastProduct.addedAt })
                : null
        }, { headers: { 'Cache-Control': 'public, max-age=30, s-maxage=120' } })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
