import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/auth/supabase', () => ({
    resolvedSupabaseAnonKey: 'test-anon-key',
    resolvedSupabaseUrl: 'https://test-project.supabase.co'
}))

const { getStoreCatalog, placeInquiryOrder } = await import('./marketplaceApi')

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('marketplace catalog request contract', () => {
    it('returns source-storage stock quantities with the storefront product unit', async () => {
        const catalog = {
            store: {
                workspace_id: 'workspace-a',
                name: 'Khalid Store',
                slug: 'khalid',
                description: null,
                logo_url: null,
                currency: 'iqd',
                contacts: []
            },
            categories: [],
            products: [{
                id: 'product-a',
                name: 'Water Bottle',
                sku: 'WB-1',
                description: '',
                price: 1500,
                currency: 'iqd',
                unit: 'Box',
                category_id: null,
                category_name: null,
                image_url: null,
                discount_price: null,
                discount_type: null,
                discount_value: null,
                discount_ends_at: null,
                marketplace_added_at: null,
                source_storage_id: 'storage-a',
                stock_quantity: 12
            }],
            total_products: 1,
            has_more: false,
            next_cursor: null
        }
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(getStoreCatalog({ slug: 'khalid', language: 'en' })).resolves.toEqual(catalog)
        expect(fetchMock).toHaveBeenCalledWith(
            'https://test-project.supabase.co/functions/v1/get-store-catalog?slug=khalid&lang=en',
            expect.objectContaining({ signal: undefined })
        )
    })

    it('returns a storefront-friendly message when catalog loading fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            error: 'This storefront is temporarily unavailable'
        }), { status: 503, headers: { 'Content-Type': 'application/json' } })))

        await expect(getStoreCatalog({ slug: 'ibrahim', language: 'ku' })).rejects.toMatchObject({
            name: 'MarketplaceApiError',
            status: 503,
            message: 'This storefront is temporarily unavailable'
        })
    })
})

describe('marketplace inquiry order request contract', () => {
    it('sends the catalog storage snapshot and handles a successful response', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            order_number: 'MK-1001',
            message: 'Order received'
        }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(placeInquiryOrder({
            store_slug: 'tools',
            customer: { name: 'Customer', phone: '07700000000' },
            items: [{ product_id: 'product-a', quantity: 2, storage_id: 'storage-b' }],
            lang: 'en'
        })).resolves.toEqual({ order_number: 'MK-1001', message: 'Order received' })

        expect(fetchMock).toHaveBeenCalledWith(
            'https://test-project.supabase.co/functions/v1/place-inquiry-order',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    store_slug: 'tools',
                    customer: { name: 'Customer', phone: '07700000000' },
                    items: [{ product_id: 'product-a', quantity: 2, storage_id: 'storage-b' }],
                    lang: 'en'
                })
            })
        )
    })

    it('returns the storefront error message for a failed order request', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            error: 'Some products are no longer available in this store'
        }), { status: 409, headers: { 'Content-Type': 'application/json' } })))

        await expect(placeInquiryOrder({
            store_slug: 'tools',
            customer: { name: 'Customer', phone: '07700000000' },
            items: [{ product_id: 'product-a', quantity: 1, storage_id: 'old-storage' }],
            lang: 'en'
        })).rejects.toMatchObject({
            name: 'MarketplaceApiError',
            status: 409,
            message: 'Some products are no longer available in this store'
        })
    })
})
