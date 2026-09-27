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
    created_at?: string | null
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

/**
 * Picks one eligible storage per product, preserving configured source order.
 * The selected storage is snapshotted on the inquiry-order item so delivery
 * deducts inventory from the same source used by the storefront catalog.
 */
export function selectStorefrontProductSources(
    productIds: string[],
    storageIds: string[],
    inventoryRows: StorefrontInventorySourceRow[],
    requestedStorageIds: Map<string, string> = new Map()
) {
    const allowedStorageIds = new Set(storageIds)
    const storageRank = new Map(storageIds.map((storageId, index) => [storageId, index] as const))
    const bestRowByProductId = new Map<string, StorefrontInventorySourceRow>()

    for (const row of inventoryRows) {
        const rank = storageRank.get(row.storage_id)
        if (rank === undefined) continue
        const current = bestRowByProductId.get(row.product_id)
        if (!current || rank < (storageRank.get(current.storage_id) ?? Number.MAX_SAFE_INTEGER)) {
            bestRowByProductId.set(row.product_id, row)
        }
    }

    const sourceByProductId = new Map<string, string>()
    for (const productId of productIds) {
        const requestedStorageId = requestedStorageIds.get(productId)
        if (requestedStorageId) {
            if (!allowedStorageIds.has(requestedStorageId)) return null
            const selected = bestRowByProductId.get(productId)
            if (!selected || requestedStorageId !== selected.storage_id) return null
            sourceByProductId.set(productId, requestedStorageId)
            continue
        }

        const selected = bestRowByProductId.get(productId)
        if (!selected) return null
        sourceByProductId.set(productId, selected.storage_id)
    }

    return sourceByProductId
}

/** Select a stable source row for each visible product and the earliest marketplace-added date. */
export function selectStorefrontInventorySources(
    storageIds: string[],
    inventoryRows: StorefrontInventorySourceRow[]
) {
    const storageRank = new Map(storageIds.map((storageId, index) => [storageId, index] as const))
    const sourceStorageIdByProductId = new Map<string, string>()
    const marketplaceAddedAtByProductId = new Map<string, string | null>()

    for (const row of inventoryRows) {
        if (!storageRank.has(row.storage_id)) continue

        const currentStorageId = sourceStorageIdByProductId.get(row.product_id)
        if (!currentStorageId || storageRank.get(row.storage_id)! < storageRank.get(currentStorageId)!) {
            sourceStorageIdByProductId.set(row.product_id, row.storage_id)
        }

        const currentAddedAt = marketplaceAddedAtByProductId.get(row.product_id)
        if (!currentAddedAt || (row.created_at && row.created_at < currentAddedAt)) {
            marketplaceAddedAtByProductId.set(row.product_id, row.created_at ?? null)
        }
    }

    return { sourceStorageIdByProductId, marketplaceAddedAtByProductId }
}
