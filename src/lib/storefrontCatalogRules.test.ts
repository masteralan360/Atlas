import { describe, expect, it } from 'vitest'

import {
    getStorefrontStorageIds,
    parseOptionalCatalogPriceMax,
    selectStorefrontInventorySources,
    selectStorefrontProductSources,
    type StorefrontCatalogRule
} from '../../supabase/functions/_shared/storefrontCatalogRules'

function rule(
    ruleType: StorefrontCatalogRule['rule_type'],
    targetType: StorefrontCatalogRule['target_type'],
    storageId: string | null = null
): StorefrontCatalogRule {
    return {
        rule_type: ruleType,
        target_type: targetType,
        price_book_id: null,
        storage_id: storageId,
        override_prices: false
    }
}

describe('storefront storage catalog rules', () => {
    it('leaves the catalog price ceiling unset when the query parameter is omitted', () => {
        expect(parseOptionalCatalogPriceMax(null)).toBeNull()
        expect(parseOptionalCatalogPriceMax('')).toBeNull()
        expect(parseOptionalCatalogPriceMax('   ')).toBeNull()
    })

    it('accepts zero and valid nonnegative catalog price ceilings only', () => {
        expect(parseOptionalCatalogPriceMax('0')).toBe(0)
        expect(parseOptionalCatalogPriceMax('1250.5')).toBe(1250.5)
        expect(parseOptionalCatalogPriceMax('-1')).toBeNull()
        expect(parseOptionalCatalogPriceMax('not-a-number')).toBeNull()
        expect(parseOptionalCatalogPriceMax('Infinity')).toBeNull()
    })

    it('keeps the designated Marketplace storage when no storage rule exists', () => {
        expect(getStorefrontStorageIds(['marketplace', 'marketplace'], [rule('inclusion', 'native')]))
            .toEqual(['marketplace'])
    })

    it('uses included storages instead of the default sources and lets exclusions win', () => {
        expect(getStorefrontStorageIds(['marketplace'], [
            rule('inclusion', 'storage', 'east'),
            rule('inclusion', 'storage', 'west'),
            rule('exclusion', 'storage', 'west')
        ])).toEqual(['east'])
    })

    it('applies exclusion-only rules to the default Marketplace sources', () => {
        expect(getStorefrontStorageIds(['marketplace', 'reserve'], [
            rule('exclusion', 'storage', 'marketplace')
        ])).toEqual(['reserve'])
    })

    it('returns no sources when all selected defaults are excluded', () => {
        expect(getStorefrontStorageIds(['marketplace'], [
            rule('exclusion', 'storage', 'marketplace')
        ])).toEqual([])
    })

    it('chooses an eligible source per product in configured priority order', () => {
        const result = selectStorefrontProductSources(
            ['p1', 'p2'],
            ['east', 'west'],
            [
                { product_id: 'p1', storage_id: 'west' },
                { product_id: 'p1', storage_id: 'east' },
                { product_id: 'p2', storage_id: 'west' }
            ]
        )

        expect(Array.from(result ?? [])).toEqual([['p1', 'east'], ['p2', 'west']])
    })

    it('honors a catalog source snapshot and rejects stale or disallowed sources', () => {
        const rows = [
            { product_id: 'p1', storage_id: 'east' },
            { product_id: 'p1', storage_id: 'west' }
        ]

        expect(selectStorefrontProductSources(['p1'], ['east', 'west'], rows, new Map([['p1', 'east']])))
            .toEqual(new Map([['p1', 'east']]))
        expect(selectStorefrontProductSources(['p1'], ['east', 'west'], rows, new Map([['p1', 'west']])))
            .toBeNull()
        expect(selectStorefrontProductSources(['p1'], ['east'], rows, new Map([['p1', 'west']])))
            .toBeNull()
        expect(selectStorefrontProductSources(['missing'], ['east', 'west'], rows)).toBeNull()
    })

    it('keeps source selection deterministic and tracks the earliest marketplace-added date', () => {
        expect(selectStorefrontInventorySources(['east', 'west'], [
            { product_id: 'p1', storage_id: 'west', created_at: '2026-02-03T00:00:00Z' },
            { product_id: 'p1', storage_id: 'east', quantity: 12, created_at: '2026-02-05T00:00:00Z' },
            { product_id: 'p1', storage_id: 'east', quantity: 12, created_at: '2026-02-01T00:00:00Z' },
            { product_id: 'p2', storage_id: 'unused', created_at: '2026-01-01T00:00:00Z' }
        ])).toEqual({
            sourceStorageIdByProductId: new Map([['p1', 'east']]),
            marketplaceAddedAtByProductId: new Map([['p1', '2026-02-01T00:00:00Z']]),
            stockQuantityByProductId: new Map([['p1', 12]])
        })
    })

    it('uses the selected source storage quantity for each product', () => {
        expect(selectStorefrontInventorySources(['east', 'west'], [
            { product_id: 'p1', storage_id: 'west', quantity: 25 },
            { product_id: 'p1', storage_id: 'east', quantity: 8 }
        ]).stockQuantityByProductId).toEqual(new Map([['p1', 8]]))
    })
})
