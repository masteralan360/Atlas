import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    loadVisibleModeProducts: vi.fn()
}))

vi.mock('../supabase/functions/_shared/supabase.ts', () => ({
    createAdminClient: () => ({ from: mocks.from })
}))

vi.mock('../supabase/functions/_shared/websiteStorefront.ts', async (importOriginal) => ({
    ...await importOriginal(),
    isWebsiteStorefrontGatewayRequest: () => true,
    loadWebsiteStorefrontContext: async () => ({
        workspace: { id: 'workspace' },
        config: { site_key: 'jumla-khaleej' }
    }),
    loadVisibleModeProducts: mocks.loadVisibleModeProducts
}))

let handleOrder

beforeAll(async () => {
    vi.stubGlobal('Deno', { serve: (handler) => { handleOrder = handler } })
    await import('../supabase/functions/place-bound-storefront-order/index.ts')
})

afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
    vi.clearAllMocks()
    const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: async () => ({ data: null, error: null }),
        gte: async () => ({ count: 0, error: null })
    }
    mocks.from.mockReturnValue(query)
})

function request(items, mode = 'retail') {
    return new Request('https://atlas.test/functions/v1/place-bound-storefront-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode,
            customer: { name: 'Test Customer', phone: '07700000000', city: 'erbil' },
            checkout_request_id: '00000000-0000-4000-8000-000000000001',
            items
        })
    })
}

describe('Jumla Khaleej unavailable order products', () => {
    it.each(['retail', 'wholesale'])('returns all affected IDs and excludes eligible products in %s', async (mode) => {
        mocks.loadVisibleModeProducts.mockResolvedValue({
            marketplaceStorageId: 'source',
            inventoryRows: [{ product_id: 'eligible' }, { product_id: 'removed-product' }],
            productRows: [{ id: 'eligible' }, { id: 'missing-inventory' }]
        })

        const response = await handleOrder(request([
            { product_id: 'eligible', quantity: 3 },
            { product_id: 'missing-inventory', quantity: 3 },
            { product_id: 'removed-product', quantity: 3 },
            { product_id: 'removed-product', quantity: 3 },
            { product_id: 'missing-variant', quantity: 3 }
        ], mode))

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Some products could not be found for this store',
            code: 'STOREFRONT_PRODUCTS_UNAVAILABLE',
            unavailable_product_ids: ['missing-inventory', 'removed-product', 'missing-variant']
        })
        expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(['marketplace_orders', 'marketplace_orders'])
    })

    it('preserves the separate wholesale minimum error for eligible products', async () => {
        mocks.loadVisibleModeProducts.mockResolvedValue({
            marketplaceStorageId: 'source',
            inventoryRows: [{ product_id: 'eligible' }],
            productRows: [{ id: 'eligible', parent_product_id: null }]
        })

        const response = await handleOrder(request([{ product_id: 'eligible', quantity: 1 }], 'wholesale'))
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: "Select at least 3 items from each product's variants before continuing" })
    })

    it('preserves the separate missing storage configuration error', async () => {
        mocks.loadVisibleModeProducts.mockResolvedValue({ marketplaceStorageId: '' })
        const response = await handleOrder(request([{ product_id: 'product', quantity: 1 }]))
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Marketplace storage is not configured for this store' })
    })
})
