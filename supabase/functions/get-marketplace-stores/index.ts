import { createAdminClient } from '../_shared/supabase.ts'
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/http.ts'
import {
    listMarketplaceAssetUrls,
    resolvePublicAssetUrl,
    resolveStorefrontVisibleProductIds,
    sanitizeMarketplaceText,
    type StorefrontCatalogRule
} from '../_shared/marketplace.ts'
import { getStorefrontStorageIds } from '../_shared/storefrontCatalogRules.ts'

const STORE_PAGE_SIZE = 30

type WorkspaceRow = {
    id: string
    name: string
    visibility: string | null
    store_slug: string | null
    store_description: string | null
    logo_url: string | null
    default_currency: string | null
}

type StorefrontRow = { id: string; workspace_id: string; slug: string; description: string | null }
type StorefrontEntry = {
    workspaceId: string
    name: string
    slug: string
    description: string | null
    logo_url: string | null
    default_currency: string | null
    storefrontId: string | null
}
type WorkspaceStorageRow = { id: string; workspace_id: string; is_marketplace: boolean | null }
type ProductSummaryRow = { id: string; workspace_id: string; category_id: string | null }
type InventoryRow = { workspace_id: string; storage_id: string; product_id: string }
type StoreCursor = { name: string; slug: string }

function encodeCursor(cursor: StoreCursor) {
    const bytes = new TextEncoder().encode(JSON.stringify(cursor))
    const encoded = btoa(String.fromCharCode(...bytes))
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(value: string | null): StoreCursor | null {
    if (!value) return null

    try {
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
        const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
        const cursor = JSON.parse(new TextDecoder().decode(bytes)) as Partial<StoreCursor>
        if (typeof cursor.name !== 'string' || typeof cursor.slug !== 'string') return null
        return { name: cursor.name, slug: cursor.slug }
    } catch {
        return null
    }
}

function compareEntries(left: Pick<StorefrontEntry, 'name' | 'slug'>, right: StoreCursor) {
    return left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug)
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    if (req.method !== 'GET') return errorResponse('Method not allowed', 405)

    try {
        const url = new URL(req.url)
        const search = sanitizeMarketplaceText(url.searchParams.get('q'), 120).toLocaleLowerCase()
        const rawCursor = url.searchParams.get('cursor')
        const cursor = decodeCursor(rawCursor)
        if (rawCursor && !cursor) return errorResponse('Invalid pagination cursor')

        const adminClient = createAdminClient()
        const [{ data: workspaces, error: workspaceError }, { data: storefronts, error: storefrontsError }] = await Promise.all([
            adminClient
                .from('workspaces')
                .select('id, name, visibility, store_slug, store_description, logo_url, default_currency')
                .is('deleted_at', null),
            adminClient
                .from('workspace_storefronts')
                .select('id, workspace_id, slug, description')
                .eq('visibility', 'public')
        ])
        if (workspaceError) return errorResponse(workspaceError.message, 500)
        if (storefrontsError) return errorResponse(storefrontsError.message, 500)

        const workspaceRows = (workspaces ?? []) as WorkspaceRow[]
        const workspaceById = new Map(workspaceRows.map((workspace) => [workspace.id, workspace] as const))
        const entries: StorefrontEntry[] = []
        for (const workspace of workspaceRows) {
            if (workspace.visibility === 'public' && workspace.store_slug) {
                entries.push({
                    workspaceId: workspace.id,
                    name: workspace.name,
                    slug: workspace.store_slug,
                    description: workspace.store_description,
                    logo_url: workspace.logo_url,
                    default_currency: workspace.default_currency,
                    storefrontId: null
                })
            }
        }
        for (const storefront of (storefronts ?? []) as StorefrontRow[]) {
            const workspace = workspaceById.get(storefront.workspace_id)
            if (!workspace || !storefront.slug) continue
            entries.push({
                workspaceId: workspace.id,
                name: workspace.name,
                slug: storefront.slug,
                description: storefront.description,
                logo_url: workspace.logo_url,
                default_currency: workspace.default_currency,
                storefrontId: storefront.id
            })
        }

        const matchingEntries = entries
            .filter((entry) => !search || `${entry.name} ${entry.description ?? ''}`.toLocaleLowerCase().includes(search))
            .sort((left, right) => compareEntries(left, right))
            .filter((entry) => !cursor || compareEntries(entry, cursor) > 0)
        const pageEntries = matchingEntries.slice(0, STORE_PAGE_SIZE)
        const hasMore = matchingEntries.length > pageEntries.length
        if (pageEntries.length === 0) {
            return jsonResponse({ stores: [], has_more: false, next_cursor: null }, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' } })
        }

        const workspaceIds = Array.from(new Set(pageEntries.map((entry) => entry.workspaceId)))
        const [{ data: storageRows, error: storageError }, { data: products, error: productError }, { data: ruleRows, error: rulesError }] = await Promise.all([
            adminClient.from('storages').select('id, workspace_id, is_marketplace').in('workspace_id', workspaceIds).eq('is_deleted', false),
            adminClient.from('products').select('id, workspace_id, category_id').in('workspace_id', workspaceIds).eq('is_deleted', false),
            adminClient.from('workspace_storefront_catalog_rules').select('workspace_id, storefront_id, rule_type, target_type, price_book_id, storage_id, override_prices').in('workspace_id', workspaceIds)
        ])
        if (storageError) return errorResponse(storageError.message, 500)
        if (productError) return errorResponse(productError.message, 500)
        if (rulesError) return errorResponse(rulesError.message, 500)

        const activeStorageIdsByWorkspace = new Map<string, string[]>()
        const defaultStorageIdsByWorkspace = new Map<string, string[]>()
        for (const row of (storageRows ?? []) as WorkspaceStorageRow[]) {
            const activeStorageIds = activeStorageIdsByWorkspace.get(row.workspace_id) ?? []
            activeStorageIds.push(row.id)
            activeStorageIdsByWorkspace.set(row.workspace_id, activeStorageIds)
            if (row.is_marketplace) {
                const defaultStorageIds = defaultStorageIdsByWorkspace.get(row.workspace_id) ?? []
                defaultStorageIds.push(row.id)
                defaultStorageIdsByWorkspace.set(row.workspace_id, defaultStorageIds)
            }
        }
        const productById = new Map(((products ?? []) as ProductSummaryRow[]).map((product) => [product.id, product] as const))
        const rulesByKey = new Map<string, StorefrontCatalogRule[]>()
        for (const row of (ruleRows ?? []) as {
            workspace_id: string
            storefront_id: string | null
            rule_type: string
            target_type: string | null
            price_book_id: string | null
            storage_id: string | null
            override_prices: boolean | null
        }[]) {
            const key = `${row.workspace_id}:${row.storefront_id ?? ''}`
            const rules = rulesByKey.get(key) ?? []
            rules.push({
                rule_type: row.rule_type === 'exclusion' ? 'exclusion' : 'inclusion',
                target_type: row.target_type === 'storage'
                    ? 'storage'
                    : row.target_type === 'price_book' || row.price_book_id
                        ? 'price_book'
                        : 'native',
                price_book_id: row.price_book_id,
                storage_id: row.storage_id,
                override_prices: Boolean(row.override_prices)
            })
            rulesByKey.set(key, rules)
        }

        const storageIdsByStorefrontKey = new Map<string, string[]>()
        for (const entry of pageEntries) {
            const key = `${entry.workspaceId}:${entry.storefrontId ?? ''}`
            const rules = rulesByKey.get(key) ?? []
            const activeIds = new Set(activeStorageIdsByWorkspace.get(entry.workspaceId) ?? [])
            const storageIds = getStorefrontStorageIds(defaultStorageIdsByWorkspace.get(entry.workspaceId) ?? [], rules)
                .filter((storageId) => activeIds.has(storageId))
            storageIdsByStorefrontKey.set(key, storageIds)
        }

        const sourceStorageIds = Array.from(new Set(Array.from(storageIdsByStorefrontKey.values()).flat()))
        const productIdsByStorageId = new Map<string, Set<string>>()
        if (sourceStorageIds.length > 0) {
            const { data: inventoryRows, error: inventoryError } = await adminClient
                .from('inventory')
                .select('workspace_id, storage_id, product_id')
                .in('workspace_id', workspaceIds)
                .in('storage_id', sourceStorageIds)
                .eq('is_deleted', false)
                .gt('quantity', 0)
            if (inventoryError) return errorResponse(inventoryError.message, 500)
            for (const row of (inventoryRows ?? []) as InventoryRow[]) {
                if (!(activeStorageIdsByWorkspace.get(row.workspace_id) ?? []).includes(row.storage_id)) continue
                const product = productById.get(row.product_id)
                if (!product || product.workspace_id !== row.workspace_id) continue
                const current = productIdsByStorageId.get(row.storage_id) ?? new Set<string>()
                current.add(product.id)
                productIdsByStorageId.set(row.storage_id, current)
            }
        }

        const logoUrlByWorkspace = new Map<string, string | null>()
        const getLogoUrl = async (workspaceId: string, rawLogoUrl: string | null) => {
            if (logoUrlByWorkspace.has(workspaceId)) return logoUrlByWorkspace.get(workspaceId) ?? null
            const logoUrl = resolvePublicAssetUrl(rawLogoUrl)
                ?? (await listMarketplaceAssetUrls([`${workspaceId}/workspace-logos/`, `${workspaceId}/workspaces/`], 1))[0]
                ?? null
            logoUrlByWorkspace.set(workspaceId, logoUrl)
            return logoUrl
        }

        const stores = await Promise.all(pageEntries.map(async (entry) => {
            const key = `${entry.workspaceId}:${entry.storefrontId ?? ''}`
            const rules = rulesByKey.get(key) ?? []
            const sourceStorageIds = storageIdsByStorefrontKey.get(key) ?? []
            const candidateProductIds = new Set(sourceStorageIds.flatMap((storageId) => Array.from(productIdsByStorageId.get(storageId) ?? [])))
            const visibleProductIds = await resolveStorefrontVisibleProductIds(
                adminClient,
                entry.workspaceId,
                Array.from(candidateProductIds),
                { storefrontId: entry.storefrontId, rules }
            )
            const visibleIds = visibleProductIds
                ? Array.from(candidateProductIds).filter((productId) => visibleProductIds.has(productId))
                : Array.from(candidateProductIds)
            const productCount = visibleIds.length
            const categoryCount = new Set(visibleIds.map((productId) => productById.get(productId)?.category_id).filter(Boolean)).size
            return {
                name: entry.name,
                slug: entry.slug,
                description: entry.description,
                logo_url: await getLogoUrl(entry.workspaceId, entry.logo_url),
                default_currency: entry.default_currency ?? 'iqd',
                product_count: productCount,
                category_count: categoryCount
            }
        }))
        const lastEntry = pageEntries.at(-1)!
        return jsonResponse({
            stores,
            has_more: hasMore,
            next_cursor: hasMore ? encodeCursor({ name: lastEntry.name, slug: lastEntry.slug }) : null
        }, { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300' } })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unexpected error'
        return errorResponse(message, 500)
    }
})
