import { createAdminClient } from './supabase.ts'

export const JUMLA_KHALEEJ_SITE_KEY = 'jumla-khaleej'
export const JUMLA_KHALEEJ_WHOLESALE_MINIMUM_QUANTITY = 3

export type WebsiteStorefrontMode = 'retail' | 'wholesale'

export type WebsiteStorefrontConfig = {
    site_key: string
    workspace_id: string
    wholesale_price_book_id: string
    primary_domain: string
    is_enabled: boolean
    featured_storage_ids: string[] | null
}

export type WebsiteWorkspace = {
    id: string
    name: string
    store_description: string | null
    logo_url: string | null
    default_currency: string | null
}

export type WebsiteStorefrontContext = {
    config: WebsiteStorefrontConfig
    workspace: WebsiteWorkspace
}

export type MarketplaceInventoryRow = {
    product_id: string
    storage_id: string
    quantity: number | null
    created_at: string | null
}

export type StorefrontInventoryAllocation = {
    storageId: string
    quantity: number
}

export type MarketplaceProductRow = {
    id: string
    parent_product_id: string | null
    name: string
    sku: string
    description: string | null
    price: number
    cost_price: number | null
    currency: string | null
    unit: string | null
    category_id: string | null
    image_url: string | null
    created_at: string | null
}

export type WebsitePriceBookItem = {
    product_id: string
    price: number
    cost_price: number | null
    currency: string | null
}

export type VisibleModeProducts = {
    marketplaceStorageId: string
    marketplaceStorageIds: string[]
    inventoryRows: MarketplaceInventoryRow[]
    inventoryQuantityByProductId: Map<string, number>
    inventoryAllocationsByProductId: Map<string, StorefrontInventoryAllocation[]>
    productRows: MarketplaceProductRow[]
    priceBookItemsByProductId: Map<string, WebsitePriceBookItem>
    marketplaceAddedAtByProductId: Map<string, string | null>
}

const ID_QUERY_BATCH_SIZE = 50
const ID_QUERY_BATCH_CONCURRENCY = 4

type BatchedRowsResult<Row> = {
    data: Row[] | null
    error: unknown
}

export async function loadRowsInBatches<Row>(
    ids: string[],
    loadBatch: (batchIds: string[]) => Promise<BatchedRowsResult<Row>>
): Promise<Row[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
    const rows: Row[] = []
    const batchWindowSize = ID_QUERY_BATCH_SIZE * ID_QUERY_BATCH_CONCURRENCY

    for (let offset = 0; offset < uniqueIds.length; offset += batchWindowSize) {
        const window = uniqueIds.slice(offset, offset + batchWindowSize)
        const batches: string[][] = []
        for (let batchOffset = 0; batchOffset < window.length; batchOffset += ID_QUERY_BATCH_SIZE) {
            batches.push(window.slice(batchOffset, batchOffset + ID_QUERY_BATCH_SIZE))
        }

        const results = await Promise.all(batches.map(loadBatch))
        for (const result of results) {
            if (result.error) throw result.error
            rows.push(...(result.data ?? []))
        }
    }

    return rows
}

function normalizeDomain(value: string | null | undefined) {
    return (value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '')
}

export function parseWebsiteStorefrontMode(value: string | null | undefined): WebsiteStorefrontMode | null {
    const mode = (value ?? '').trim().toLowerCase()
    return mode === 'retail' || mode === 'wholesale' ? mode : null
}

export function isWebsiteStorefrontGatewayRequest(req: Request) {
    const expected = Deno.env.get('WEBSITE_STOREFRONT_GATEWAY_SECRET') ?? ''
    const supplied = req.headers.get('x-storefront-gateway-secret') ?? ''

    if (!expected || !supplied || expected.length !== supplied.length) {
        return false
    }

    let mismatch = 0
    for (let index = 0; index < expected.length; index += 1) {
        mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index)
    }

    return mismatch === 0
}

export function getTrustedStorefrontClientIp(req: Request) {
    const value = req.headers.get('x-storefront-client-ip') ?? ''
    return value.slice(0, 128).trim() || null
}

export async function loadWebsiteStorefrontContext(
    adminClient: ReturnType<typeof createAdminClient>,
    req: Request
): Promise<WebsiteStorefrontContext | { error: string; status: number }> {
    const { data: config, error: configError } = await adminClient
        .from('website_storefront_configs')
        .select('site_key, workspace_id, wholesale_price_book_id, primary_domain, is_enabled, featured_storage_ids')
        .eq('site_key', JUMLA_KHALEEJ_SITE_KEY)
        .maybeSingle()

    if (configError) {
        return { error: configError.message, status: 500 }
    }

    if (!config || !(config as WebsiteStorefrontConfig).is_enabled) {
        return { error: 'Storefront is unavailable', status: 404 }
    }

    const resolvedConfig = config as WebsiteStorefrontConfig
    const requestDomain = normalizeDomain(req.headers.get('x-storefront-origin'))
    if (!requestDomain || requestDomain !== normalizeDomain(resolvedConfig.primary_domain)) {
        return { error: 'Storefront origin is not allowed', status: 403 }
    }

    const { data: workspace, error: workspaceError } = await adminClient
        .from('workspaces')
        .select('id, name, store_description, logo_url, default_currency')
        .eq('id', resolvedConfig.workspace_id)
        .in('visibility', ['public', 'link_only'])
        .is('deleted_at', null)
        .maybeSingle()

    if (workspaceError) {
        return { error: workspaceError.message, status: 500 }
    }

    if (!workspace) {
        return { error: 'Storefront is unavailable', status: 404 }
    }

    return {
        config: resolvedConfig,
        workspace: workspace as WebsiteWorkspace
    }
}

export async function loadMarketplaceStorageId(
    adminClient: ReturnType<typeof createAdminClient>,
    workspaceId: string
): Promise<string | null> {
    const { data, error } = await adminClient.rpc('ensure_marketplace_storage', {
        p_workspace_id: workspaceId
    })

    if (error) {
        throw error
    }

    return typeof data === 'string' && data ? data : null
}

function configuredStorageIds(value: string[] | null | undefined) {
    const seen = new Set<string>()
    const result: string[] = []

    for (const storageId of value ?? []) {
        if (typeof storageId !== 'string' || !storageId || seen.has(storageId)) continue
        seen.add(storageId)
        result.push(storageId)
    }

    return result
}

async function loadStorefrontStorageIds(
    adminClient: ReturnType<typeof createAdminClient>,
    context: WebsiteStorefrontContext
) {
    // This additional source list is intentionally limited to Jumla Khaleej.
    // Every other Marketplace consumer continues to use its one designated
    // Marketplace storage through ensure_marketplace_storage.
    const configuredIds = context.config.site_key === JUMLA_KHALEEJ_SITE_KEY
        ? configuredStorageIds(context.config.featured_storage_ids)
        : []

    if (configuredIds.length > 0) {
        const { data, error } = await adminClient
            .from('storages')
            .select('id')
            .eq('workspace_id', context.workspace.id)
            .eq('is_deleted', false)
            .in('id', configuredIds)

        if (error) throw error

        const validIds = new Set((data ?? []).map((storage) => String(storage.id)))
        return configuredIds.filter((storageId) => validIds.has(storageId))
    }

    const marketplaceStorageId = await loadMarketplaceStorageId(adminClient, context.workspace.id)
    return marketplaceStorageId ? [marketplaceStorageId] : []
}

export async function loadVisibleModeProducts(
    adminClient: ReturnType<typeof createAdminClient>,
    context: WebsiteStorefrontContext,
    mode: WebsiteStorefrontMode,
    options?: {
        // Catalogs need the parent as a display shell when its sellable
        // variants carry all of the inventory. Order placement deliberately
        // leaves this disabled so a parent can never be ordered directly.
        includeVariantParents?: boolean
    }
): Promise<VisibleModeProducts> {
    const marketplaceStorageIds = await loadStorefrontStorageIds(adminClient, context)
    const marketplaceStorageId = marketplaceStorageIds[0] ?? ''
    if (!marketplaceStorageId) {
        return {
            marketplaceStorageId: '',
            marketplaceStorageIds: [],
            inventoryRows: [],
            inventoryQuantityByProductId: new Map(),
            inventoryAllocationsByProductId: new Map(),
            productRows: [],
            priceBookItemsByProductId: new Map(),
            marketplaceAddedAtByProductId: new Map()
        }
    }

    const { data: inventoryRows, error: inventoryError } = await adminClient
        .from('inventory')
        .select('product_id, storage_id, quantity, created_at')
        .eq('workspace_id', context.workspace.id)
        .in('storage_id', marketplaceStorageIds)
        .eq('is_deleted', false)

    if (inventoryError) {
        throw inventoryError
    }

    const resolvedInventoryRows = (inventoryRows ?? []) as MarketplaceInventoryRow[]
    const inventoryQuantityByProductId = new Map<string, number>()
    const inventoryQuantityByProductAndStorage = new Map<string, Map<string, number>>()
    const marketplaceAddedAtByProductId = new Map<string, string | null>()
    for (const inventory of resolvedInventoryRows) {
        const quantity = Number(inventory.quantity ?? 0)
        inventoryQuantityByProductId.set(
            inventory.product_id,
            (inventoryQuantityByProductId.get(inventory.product_id) ?? 0) + quantity
        )

        const quantitiesByStorage = inventoryQuantityByProductAndStorage.get(inventory.product_id) ?? new Map<string, number>()
        quantitiesByStorage.set(
            inventory.storage_id,
            (quantitiesByStorage.get(inventory.storage_id) ?? 0) + quantity
        )
        inventoryQuantityByProductAndStorage.set(inventory.product_id, quantitiesByStorage)

        const currentAddedAt = marketplaceAddedAtByProductId.get(inventory.product_id)
        if (!currentAddedAt || (inventory.created_at && inventory.created_at < currentAddedAt)) {
            marketplaceAddedAtByProductId.set(inventory.product_id, inventory.created_at)
        }
    }

    const inventoryAllocationsByProductId = new Map<string, StorefrontInventoryAllocation[]>()
    for (const [productId, quantitiesByStorage] of inventoryQuantityByProductAndStorage) {
        inventoryAllocationsByProductId.set(productId, marketplaceStorageIds.map((storageId) => ({
            storageId,
            quantity: quantitiesByStorage.get(storageId) ?? 0
        })))
    }
    const inventoryProductIds = Array.from(new Set(
        resolvedInventoryRows.map((inventory) => inventory.product_id).filter(Boolean)
    ))

    if (inventoryProductIds.length === 0) {
        return {
            marketplaceStorageId,
            marketplaceStorageIds,
            inventoryRows: resolvedInventoryRows,
            inventoryQuantityByProductId,
            inventoryAllocationsByProductId,
            productRows: [],
            priceBookItemsByProductId: new Map(),
            marketplaceAddedAtByProductId: new Map()
        }
    }

    let priceBookRows: WebsitePriceBookItem[] = []
    if (mode === 'wholesale') {
        priceBookRows = await loadRowsInBatches<WebsitePriceBookItem>(inventoryProductIds, async (batchIds) => {
            const { data, error } = await adminClient
                .from('price_book_items')
                .select('product_id, price, cost_price, currency')
                .eq('workspace_id', context.workspace.id)
                .eq('price_book_id', context.config.wholesale_price_book_id)
                .eq('is_deleted', false)
                .in('product_id', batchIds)

            return { data: data as WebsitePriceBookItem[] | null, error }
        })
    }

    const resolvedPriceBookItems = new Map<string, WebsitePriceBookItem>()
    if (mode === 'wholesale') {
        for (const item of priceBookRows) {
            resolvedPriceBookItems.set(item.product_id, {
                product_id: item.product_id,
                price: Number(item.price ?? 0),
                cost_price: item.cost_price == null ? null : Number(item.cost_price),
                currency: item.currency
            })
        }
    }

    const visibleProductIds = mode === 'wholesale'
        ? inventoryProductIds.filter((productId) => resolvedPriceBookItems.has(productId))
        : inventoryProductIds

    if (visibleProductIds.length === 0) {
        return {
            marketplaceStorageId,
            marketplaceStorageIds,
            inventoryRows: resolvedInventoryRows,
            inventoryQuantityByProductId,
            inventoryAllocationsByProductId,
            productRows: [],
            priceBookItemsByProductId: resolvedPriceBookItems,
            marketplaceAddedAtByProductId: new Map()
        }
    }

    const visibleProducts = await loadRowsInBatches<MarketplaceProductRow>(visibleProductIds, async (batchIds) => {
        const { data, error } = await adminClient
            .from('products')
            .select('id, parent_product_id, name, sku, description, price, cost_price, currency, unit, category_id, image_url, created_at')
            .eq('workspace_id', context.workspace.id)
            .eq('is_deleted', false)
            .eq('is_service', false)
            .in('id', batchIds)
            .order('name', { ascending: true })

        return { data: data as MarketplaceProductRow[] | null, error }
    })
    visibleProducts.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    let productRows = visibleProducts

    if (options?.includeVariantParents) {
        const visibleProductIdSet = new Set(visibleProductIds)
        const missingParentIds = Array.from(new Set(
            visibleProducts
                .map((product) => product.parent_product_id)
                .filter((productId): productId is string => Boolean(productId && !visibleProductIdSet.has(productId)))
        ))

        if (missingParentIds.length > 0) {
            const parentProducts = await loadRowsInBatches<MarketplaceProductRow>(missingParentIds, async (batchIds) => {
                const { data, error } = await adminClient
                    .from('products')
                    .select('id, parent_product_id, name, sku, description, price, cost_price, currency, unit, category_id, image_url, created_at')
                    .eq('workspace_id', context.workspace.id)
                    .eq('is_deleted', false)
                    .eq('is_service', false)
                    .in('id', batchIds)
                    .order('name', { ascending: true })

                return { data: data as MarketplaceProductRow[] | null, error }
            })

            productRows = [...visibleProducts, ...parentProducts]
                .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
        }
    }

    return {
        marketplaceStorageId,
        marketplaceStorageIds,
        inventoryRows: resolvedInventoryRows,
        inventoryQuantityByProductId,
        inventoryAllocationsByProductId,
        productRows,
        priceBookItemsByProductId: resolvedPriceBookItems,
        marketplaceAddedAtByProductId
    }
}

export function allocateVisibleProductQuantity(
    visibleProducts: VisibleModeProducts,
    productId: string,
    requestedQuantity: number
) {
    let remaining = requestedQuantity
    const allocations: StorefrontInventoryAllocation[] = []

    for (const source of visibleProducts.inventoryAllocationsByProductId.get(productId) ?? []) {
        const availableQuantity = Math.max(0, Number(source.quantity ?? 0))
        if (availableQuantity <= 0 || remaining <= 0) continue

        const quantity = Math.min(availableQuantity, remaining)
        allocations.push({ storageId: source.storageId, quantity })
        remaining -= quantity
    }

    return {
        allocations,
        unallocatedQuantity: Math.max(0, remaining)
    }
}

export function resolveModePrice(
    product: MarketplaceProductRow,
    mode: WebsiteStorefrontMode,
    priceBookItemsByProductId: Map<string, WebsitePriceBookItem>
) {
    const priceBookItem = mode === 'wholesale'
        ? priceBookItemsByProductId.get(product.id)
        : null

    return {
        price: priceBookItem?.price ?? Number(product.price ?? 0),
        costPrice: priceBookItem?.cost_price ?? (product.cost_price == null ? null : Number(product.cost_price)),
        currency: priceBookItem?.currency ?? product.currency ?? null
    }
}
