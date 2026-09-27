import { describe, expect, it, vi } from 'vitest'

import {
    addStorefrontCatalogRule,
    fetchStorefrontCatalogRules,
    removeStorefrontCatalogRule,
    setStorefrontCatalogRulePriceOverride
} from './storefrontCatalogRuleRequests'
import type { supabase as SupabaseClientValue } from '@/auth/supabase'

type MockResult = { data: unknown; error: Error | null }

function createRequestClient(result: MockResult) {
    const builder = {
        select: vi.fn(),
        eq: vi.fn(),
        is: vi.fn(),
        order: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        update: vi.fn(),
        single: vi.fn()
    } as unknown as Record<string, ReturnType<typeof vi.fn>> & {
        then: Promise<MockResult>['then']
    }

    for (const method of ['select', 'eq', 'is', 'order', 'insert', 'delete', 'update']) {
        builder[method].mockImplementation(() => builder)
    }
    builder.single.mockResolvedValue(result)
    builder.then = (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected)

    const client = {
        from: vi.fn(() => builder)
    } as unknown as typeof SupabaseClientValue

    return { client, builder }
}

describe('storefront catalog rule request contract', () => {
    it('loads the selected storefront rules including storage targets', async () => {
        const rows = [{
            id: 'rule-1',
            rule_type: 'inclusion',
            target_type: 'storage',
            price_book_id: null,
            storage_id: 'storage-a',
            override_prices: false
        }]
        const { client, builder } = createRequestClient({ data: rows, error: null })

        await expect(fetchStorefrontCatalogRules('workspace-a', 'storefront-a', client)).resolves.toEqual(rows)

        expect(client.from).toHaveBeenCalledWith('workspace_storefront_catalog_rules')
        expect(builder.select).toHaveBeenCalledWith('id, rule_type, target_type, price_book_id, storage_id, override_prices')
        expect(builder.eq).toHaveBeenCalledWith('workspace_id', 'workspace-a')
        expect(builder.eq).toHaveBeenCalledWith('storefront_id', 'storefront-a')
    })

    it('loads primary storefront rules using a null storefront scope', async () => {
        const { client, builder } = createRequestClient({ data: [], error: null })

        await expect(fetchStorefrontCatalogRules('workspace-a', null, client)).resolves.toEqual([])

        expect(builder.is).toHaveBeenCalledWith('storefront_id', null)
    })

    it('writes a storage target with a workspace and storefront scope', async () => {
        const row = {
            id: 'rule-1',
            rule_type: 'exclusion',
            target_type: 'storage',
            price_book_id: null,
            storage_id: 'storage-a',
            override_prices: false
        }
        const { client, builder } = createRequestClient({ data: row, error: null })

        await expect(addStorefrontCatalogRule({
            workspaceId: 'workspace-a',
            storefrontId: 'storefront-a',
            ruleType: 'exclusion',
            targetType: 'storage',
            storageId: 'storage-a'
        }, client)).resolves.toEqual(row)

        expect(builder.insert).toHaveBeenCalledWith({
            workspace_id: 'workspace-a',
            storefront_id: 'storefront-a',
            rule_type: 'exclusion',
            target_type: 'storage',
            price_book_id: null,
            storage_id: 'storage-a'
        })
    })

    it('keeps native and price-book targets mutually exclusive in the write payload', async () => {
        const { client, builder } = createRequestClient({ data: { id: 'rule-2' }, error: null })

        await addStorefrontCatalogRule({
            workspaceId: 'workspace-a',
            storefrontId: null,
            ruleType: 'inclusion',
            targetType: 'price_book',
            priceBookId: 'book-a'
        }, client)

        expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
            target_type: 'price_book',
            price_book_id: 'book-a',
            storage_id: null
        }))
    })

    it('propagates backend failures so Settings can show its localized friendly error', async () => {
        const backendError = new Error('row-level policy rejected the rule')
        const { client } = createRequestClient({ data: null, error: backendError })

        await expect(fetchStorefrontCatalogRules('workspace-a', null, client)).rejects.toBe(backendError)
        await expect(addStorefrontCatalogRule({
            workspaceId: 'workspace-a',
            storefrontId: null,
            ruleType: 'inclusion',
            targetType: 'storage',
            storageId: 'storage-a'
        }, client)).rejects.toBe(backendError)
        await expect(removeStorefrontCatalogRule('rule-a', 'workspace-a', client)).rejects.toBe(backendError)
        await expect(setStorefrontCatalogRulePriceOverride('rule-a', 'workspace-a', true, client)).rejects.toBe(backendError)
    })
})
