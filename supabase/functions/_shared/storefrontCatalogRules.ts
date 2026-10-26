export type StorefrontCatalogRuleType = 'inclusion' | 'exclusion'
export type StorefrontCatalogRuleTargetType = 'native' | 'price_book' | 'storage'

export type StorefrontCatalogRule = {
    rule_type: StorefrontCatalogRuleType
    target_type: StorefrontCatalogRuleTargetType
    price_book_id: string | null
    storage_id: string | null
    override_prices: boolean
}

export type StorefrontInventorySourceRow = {
    product_id: string
    storage_id: string
    quantity?: number | string | null
    created_at?: string | null
}

export type StorefrontStorageAssignmentRow = {
    product_id: string
    storage_id: string
}

export function parseOptionalCatalogPriceMax(value: string | null) {
    if (value === null || value.trim() === '') return null

    const priceMax = Number(value)
    return Number.isFinite(priceMax) && priceMax >= 0 ? priceMax : null
}

/**
 * Resolves storage rules without changing the existing default source policy:
 * explicit storage inclusions replace the default Marketplace storages, while
 * exclusion-only rules subtract from those defaults.
 */
export function getStorefrontStorageIds(
    defaultStorageIds: string[],
    rules: StorefrontCatalogRule[]
) {
    const includedStorageIds = new Set(
        rules
            .filter((rule) => rule.target_type === 'storage' && rule.rule_type === 'inclusion')
            .map((rule) => rule.storage_id)
            .filter((storageId): storageId is string => Boolean(storageId))
    )
    const excludedStorageIds = new Set(
        rules
            .filter((rule) => rule.target_type === 'storage' && rule.rule_type === 'exclusion')
            .map((rule) => rule.storage_id)
            .filter((storageId): storageId is string => Boolean(storageId))
    )
    const baseStorageIds = includedStorageIds.size > 0
        ? Array.from(includedStorageIds)
        : defaultStorageIds

    const seen = new Set<string>()
    return baseStorageIds.filter((storageId) => {
        if (!storageId || seen.has(storageId) || excludedStorageIds.has(storageId)) return false
        seen.add(storageId)
        return true
    })
}

type StorefrontInventorySnapshot = {
    storageIdsByProductId: Map<string, Set<string>>
    stockQuantityByProductAndStorage: Map<string, number>
    sourceStorageIdByProductId: Map<string, string>
    marketplaceAddedAtByProductId: Map<string, string | null>
    stockQuantityByProductId: Map<string, number>
}

function getProductStorageKey(productId: string, storageId: string) {
    return `${productId}:${storageId}`
}

/**
 * Builds availability from active inventory rows and persistent storage
 * assignments. Assignments keep zero-stock products visible after the
 * inventory row is soft-deleted. When a product has stock in multiple allowed
 * storages, use the first stocked storage in storefront rule order; otherwise
 * use its first assigned storage so the catalog can show it as sold out.
 */
function buildStorefrontInventorySnapshot(
    storageIds: string[],
    inventoryRows: StorefrontInventorySourceRow[],
    assignmentRows: StorefrontStorageAssignmentRow[] = []
): StorefrontInventorySnapshot {
    const allowedStorageIds = new Set(storageIds)
    const storageIdsByProductId = new Map<string, Set<string>>()
    const stockQuantityByProductAndStorage = new Map<string, number>()
    const marketplaceAddedAtByProductId = new Map<string, string | null>()

    const addProductStorage = (productId: string, storageId: string) => {
        const productStorageIds = storageIdsByProductId.get(productId) ?? new Set<string>()
        productStorageIds.add(storageId)
        storageIdsByProductId.set(productId, productStorageIds)
    }

    for (const row of inventoryRows) {
        if (!allowedStorageIds.has(row.storage_id)) continue
        addProductStorage(row.product_id, row.storage_id)

        const key = getProductStorageKey(row.product_id, row.storage_id)
        const quantity = Number(row.quantity ?? 0)
        stockQuantityByProductAndStorage.set(
            key,
            (stockQuantityByProductAndStorage.get(key) ?? 0) + (Number.isFinite(quantity) ? quantity : 0)
        )

        const currentAddedAt = marketplaceAddedAtByProductId.get(row.product_id)
        if (!currentAddedAt || (row.created_at && row.created_at < currentAddedAt)) {
            marketplaceAddedAtByProductId.set(row.product_id, row.created_at ?? null)
        }
    }

    for (const assignment of assignmentRows) {
        if (allowedStorageIds.has(assignment.storage_id)) {
            addProductStorage(assignment.product_id, assignment.storage_id)
        }
    }

    const sourceStorageIdByProductId = new Map<string, string>()
    const stockQuantityByProductId = new Map<string, number>()
    for (const [productId, candidateStorageIds] of storageIdsByProductId) {
        const orderedStorageIds = storageIds.filter((storageId) => candidateStorageIds.has(storageId))
        const selectedStorageId = orderedStorageIds.find((storageId) =>
            (stockQuantityByProductAndStorage.get(getProductStorageKey(productId, storageId)) ?? 0) > 0
        ) ?? orderedStorageIds[0]
        if (!selectedStorageId) continue

        sourceStorageIdByProductId.set(productId, selectedStorageId)
        stockQuantityByProductId.set(
            productId,
            Math.max(0, stockQuantityByProductAndStorage.get(getProductStorageKey(productId, selectedStorageId)) ?? 0)
        )
    }

    return {
        storageIdsByProductId,
        stockQuantityByProductAndStorage,
        sourceStorageIdByProductId,
        marketplaceAddedAtByProductId,
        stockQuantityByProductId
    }
}

/**
 * Picks an eligible source and rejects order quantities above its current
 * stock. A requested source must remain assigned or stocked in the storefront.
 */
export function selectStorefrontProductSources(
    productIds: string[],
    storageIds: string[],
    inventoryRows: StorefrontInventorySourceRow[],
    requestedStorageIds: Map<string, string> = new Map(),
    assignmentRows: StorefrontStorageAssignmentRow[] = [],
    requestedQuantities: Map<string, number> = new Map()
) {
    const snapshot = buildStorefrontInventorySnapshot(storageIds, inventoryRows, assignmentRows)
    const sourceByProductId = new Map<string, string>()

    for (const productId of productIds) {
        const candidateStorageIds = snapshot.storageIdsByProductId.get(productId)
        if (!candidateStorageIds?.size) return null

        const requestedQuantity = requestedQuantities.get(productId) ?? 0
        const requestedStorageId = requestedStorageIds.get(productId)
        const sourceStorageId = requestedStorageId
            ? (candidateStorageIds.has(requestedStorageId) ? requestedStorageId : null)
            : storageIds.find((storageId) => candidateStorageIds.has(storageId)
                && (snapshot.stockQuantityByProductAndStorage.get(getProductStorageKey(productId, storageId)) ?? 0) >= requestedQuantity
            ) ?? snapshot.sourceStorageIdByProductId.get(productId) ?? null
        if (!sourceStorageId) return null

        const availableQuantity = Math.max(
            0,
            snapshot.stockQuantityByProductAndStorage.get(getProductStorageKey(productId, sourceStorageId)) ?? 0
        )
        if (availableQuantity < requestedQuantity) return null
        sourceByProductId.set(productId, sourceStorageId)
    }

    return sourceByProductId
}

/** Select a stable stocked source, or an assigned zero-stock source for display. */
export function selectStorefrontInventorySources(
    storageIds: string[],
    inventoryRows: StorefrontInventorySourceRow[],
    assignmentRows: StorefrontStorageAssignmentRow[] = []
) {
    const snapshot = buildStorefrontInventorySnapshot(storageIds, inventoryRows, assignmentRows)
    return {
        sourceStorageIdByProductId: snapshot.sourceStorageIdByProductId,
        marketplaceAddedAtByProductId: snapshot.marketplaceAddedAtByProductId,
        stockQuantityByProductId: snapshot.stockQuantityByProductId
    }
}
