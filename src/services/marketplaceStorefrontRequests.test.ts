import { describe, expect, it, vi } from 'vitest'

import {
    canAddAdditionalMarketplaceStorefront,
    createAdditionalMarketplaceStorefront,
    fetchAdditionalMarketplaceStorefronts,
    isAdditionalMarketplaceStorefrontSlugAvailable,
    MAX_ADDITIONAL_STOREFRONTS,
    removeAdditionalMarketplaceStorefront,
    saveAdditionalMarketplaceStorefront
} from './marketplaceStorefrontRequests'
import type { supabase as SupabaseClientValue } from '@/auth/supabase'

type MockResult = { data: unknown; error: Error | null }

function createRequestClient(result: MockResult) {
    const builder = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        update: vi.fn(),
        single: vi.fn()
    } as unknown as Record<string, ReturnType<typeof vi.fn>> & {
        then: Promise<MockResult>['then']
    }

    for (const method of ['select', 'eq', 'order', 'insert', 'delete', 'update']) {
        builder[method].mockImplementation(() => builder)
    }
    builder.single.mockResolvedValue(result)
    builder.then = (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected)

    const client = {
        from: vi.fn(() => builder),
        rpc: vi.fn().mockResolvedValue(result)
    } as unknown as typeof SupabaseClientValue

    return { client, builder }
}

describe('additional marketplace storefront request contract', () => {
    it('permits up to five additional storefronts and rejects counts at or above the limit', () => {
        expect(MAX_ADDITIONAL_STOREFRONTS).toBe(5)
        expect(canAddAdditionalMarketplaceStorefront(0)).toBe(true)
        expect(canAddAdditionalMarketplaceStorefront(1)).toBe(true)
        expect(canAddAdditionalMarketplaceStorefront(4)).toBe(true)
        expect(canAddAdditionalMarketplaceStorefront(5)).toBe(false)
        expect(canAddAdditionalMarketplaceStorefront(6)).toBe(false)
        expect(canAddAdditionalMarketplaceStorefront(-1)).toBe(false)
    })

    it('loads all workspace storefronts in creation order', async () => {
        const rows = [
            { id: 'storefront-a', visibility: 'private', slug: '', description: null },
            { id: 'storefront-b', visibility: 'public', slug: 'second', description: null }
        ]
        const { client, builder } = createRequestClient({ data: rows, error: null })

        await expect(fetchAdditionalMarketplaceStorefronts('workspace-a', client)).resolves.toEqual(rows)

        expect(client.from).toHaveBeenCalledWith('workspace_storefronts')
        expect(builder.eq).toHaveBeenCalledWith('workspace_id', 'workspace-a')
        expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: true })
    })

    it('creates an empty private storefront and returns its record', async () => {
        const row = { id: 'storefront-a', visibility: 'private', slug: '', description: null }
        const { client, builder } = createRequestClient({ data: row, error: null })

        await expect(createAdditionalMarketplaceStorefront('workspace-a', client)).resolves.toEqual(row)

        expect(builder.insert).toHaveBeenCalledWith({
            workspace_id: 'workspace-a',
            visibility: 'private',
            slug: '',
            description: null
        })
        expect(builder.select).toHaveBeenCalledWith('id, visibility, slug, description')
        expect(builder.single).toHaveBeenCalledOnce()
    })

    it('saves only the storefront in the supplied workspace', async () => {
        const row = { id: 'storefront-b', visibility: 'link_only', slug: 'winter', description: 'Winter offers' }
        const { client, builder } = createRequestClient({ data: row, error: null })

        await expect(saveAdditionalMarketplaceStorefront('workspace-a', 'storefront-b', {
            visibility: 'link_only',
            slug: 'winter',
            description: 'Winter offers'
        }, client)).resolves.toEqual(row)

        expect(builder.update).toHaveBeenCalledWith({
            visibility: 'link_only',
            slug: 'winter',
            description: 'Winter offers'
        })
        expect(builder.eq).toHaveBeenCalledWith('workspace_id', 'workspace-a')
        expect(builder.eq).toHaveBeenCalledWith('id', 'storefront-b')
    })

    it('removes a storefront using both its id and workspace scope', async () => {
        const { client, builder } = createRequestClient({ data: null, error: null })

        await expect(removeAdditionalMarketplaceStorefront('workspace-a', 'storefront-b', client)).resolves.toBeUndefined()

        expect(builder.delete).toHaveBeenCalledOnce()
        expect(builder.eq).toHaveBeenCalledWith('workspace_id', 'workspace-a')
        expect(builder.eq).toHaveBeenCalledWith('id', 'storefront-b')
    })

    it('checks the slug while excluding the storefront being edited', async () => {
        const { client } = createRequestClient({ data: true, error: null })

        await expect(isAdditionalMarketplaceStorefrontSlugAvailable('winter', 'storefront-b', client)).resolves.toBe(true)

        expect(client.rpc).toHaveBeenCalledWith('check_storefront_slug_available', {
            p_slug: 'winter',
            p_exclude_storefront_id: 'storefront-b'
        })
    })

    it('propagates backend failures for the manager to show a localized message', async () => {
        const backendError = new Error('permission denied')
        const { client } = createRequestClient({ data: null, error: backendError })

        await expect(fetchAdditionalMarketplaceStorefronts('workspace-a', client)).rejects.toBe(backendError)
        await expect(createAdditionalMarketplaceStorefront('workspace-a', client)).rejects.toBe(backendError)
        await expect(saveAdditionalMarketplaceStorefront('workspace-a', 'storefront-a', {
            visibility: 'private', slug: '', description: null
        }, client)).rejects.toBe(backendError)
        await expect(removeAdditionalMarketplaceStorefront('workspace-a', 'storefront-a', client)).rejects.toBe(backendError)
        await expect(isAdditionalMarketplaceStorefrontSlugAvailable('winter', 'storefront-a', client)).rejects.toBe(backendError)
    })
})
