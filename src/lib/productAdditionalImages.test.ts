import { beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({
    upload: vi.fn(),
    deleteAsset: vi.fn(),
    rpc: vi.fn()
}))

vi.mock('@/auth/supabase', () => ({ supabase: { rpc: dependencies.rpc } }))
vi.mock('@/lib/assetManager', () => ({ assetManager: { deleteAsset: dependencies.deleteAsset } }))
vi.mock('@/lib/productImageStorage', () => ({ storeProductImageFile: dependencies.upload }))
vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: async (_action: string, request: () => Promise<unknown>) => request()
}))

import { saveInitialProductAdditionalImages } from './productAdditionalImages'

function image(name: string) {
    return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

describe('initial additional product images', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        dependencies.upload.mockImplementation(async (file: File) => `product-images/${file.name}`)
        dependencies.deleteAsset.mockResolvedValue(undefined)
        dependencies.rpc.mockResolvedValue({ data: null, error: null })
    })

    it('uploads ordered gallery images and replaces the product image set', async () => {
        const files = [image('front.png'), image('side.png')]

        await saveInitialProductAdditionalImages('workspace-1', 'product-1', files)

        expect(dependencies.upload).toHaveBeenNthCalledWith(1, files[0], 'workspace-1', 'product-additional')
        expect(dependencies.upload).toHaveBeenNthCalledWith(2, files[1], 'workspace-1', 'product-additional')
        expect(dependencies.rpc).toHaveBeenCalledWith('replace_product_images', {
            p_workspace_id: 'workspace-1',
            p_product_id: 'product-1',
            p_images: [
                { image_url: 'product-images/front.png' },
                { image_url: 'product-images/side.png' }
            ]
        })
        expect(dependencies.deleteAsset).not.toHaveBeenCalled()
    })

    it('skips remote work when the product has no workspace, product id, or files', async () => {
        await saveInitialProductAdditionalImages('', 'product-1', [image('front.png')])
        await saveInitialProductAdditionalImages('workspace-1', '', [image('front.png')])
        await saveInitialProductAdditionalImages('workspace-1', 'product-1', [])

        expect(dependencies.upload).not.toHaveBeenCalled()
        expect(dependencies.rpc).not.toHaveBeenCalled()
    })

    it('removes earlier uploads when a later image cannot be stored', async () => {
        dependencies.upload
            .mockResolvedValueOnce('product-images/front.png')
            .mockResolvedValueOnce(null)

        await expect(saveInitialProductAdditionalImages('workspace-1', 'product-1', [
            image('front.png'), image('broken.png')
        ])).rejects.toThrow('Unable to store broken.png.')

        expect(dependencies.rpc).not.toHaveBeenCalled()
        expect(dependencies.deleteAsset).toHaveBeenCalledWith('product-images/front.png')
    })

    it('removes every uploaded image when replacing the gallery fails', async () => {
        dependencies.rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } })

        await expect(saveInitialProductAdditionalImages('workspace-1', 'product-1', [
            image('front.png'), image('side.png')
        ])).rejects.toMatchObject({ message: 'permission denied' })

        expect(dependencies.deleteAsset).toHaveBeenCalledTimes(2)
        expect(dependencies.deleteAsset).toHaveBeenCalledWith('product-images/front.png')
        expect(dependencies.deleteAsset).toHaveBeenCalledWith('product-images/side.png')
    })
})
