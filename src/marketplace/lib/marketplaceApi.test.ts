import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/auth/supabase', () => ({
    resolvedSupabaseAnonKey: 'test-anon-key',
    resolvedSupabaseUrl: 'https://test-project.supabase.co'
}))

const { placeInquiryOrder } = await import('./marketplaceApi')

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
