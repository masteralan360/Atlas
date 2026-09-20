import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    compressImage: vi.fn(),
    isTauri: vi.fn(() => false),
    isLocal: vi.fn(() => false),
    isDemo: vi.fn(() => false),
    persist: vi.fn(),
    remove: vi.fn(),
    isConfigured: vi.fn(() => true),
    upload: vi.fn(),
}))

vi.mock('@/lib/imageCompression', () => ({ compressImage: mocks.compressImage }))
vi.mock('@/lib/platform', () => ({ isTauri: mocks.isTauri }))
vi.mock('@/workspace/workspaceMode', () => ({
    isLocalWorkspaceMode: mocks.isLocal,
    isDemoWorkspaceMode: mocks.isDemo,
}))
vi.mock('@/services/platformService', () => ({
    platformService: { persistImageFile: mocks.persist, removeFile: mocks.remove },
}))
vi.mock('@/services/r2Service', () => ({
    r2Service: { isConfigured: mocks.isConfigured, uploadCompressedImage: mocks.upload },
}))

import { mediaUploadService } from '@/services/mediaUploadService'

function artifact() {
    const file = new File(['compressed'], 'id--atlas-product-primary-v1.webp', { type: 'image/webp' })
    return {
        kind: 'atlas-compressed-image' as const,
        file,
        source: 'product-primary' as const,
        profileVersion: 1 as const,
        width: 800,
        height: 600,
        originalBytes: 2000,
        outputBytes: file.size,
        attempts: 2,
    }
}

describe('central media upload service', () => {
    beforeEach(() => {
        Object.values(mocks).forEach((mock) => mock.mockReset())
        mocks.isTauri.mockReturnValue(false)
        mocks.isLocal.mockReturnValue(false)
        mocks.isDemo.mockReturnValue(false)
        mocks.isConfigured.mockReturnValue(true)
        mocks.remove.mockResolvedValue(true)
        mocks.upload.mockResolvedValue('https://r2.example/object')
    })

    it('uploads the exact compressed artifact and returns canonical paths in cloud mode', async () => {
        const compressed = artifact()
        mocks.compressImage.mockResolvedValue(compressed)
        const source = new File(['original'], 'photo.jpg', { type: 'image/jpeg' })

        const stored = await mediaUploadService.storeImageFile(source, 'workspace-id', 'product-images', 'product-primary')

        expect(mocks.compressImage).toHaveBeenCalledWith(source, 'product-primary')
        expect(mocks.upload).toHaveBeenCalledWith('workspace-id/product-images/id--atlas-product-primary-v1.webp', compressed)
        expect(stored.path).toBe('product-images/workspace-id/id--atlas-product-primary-v1.webp')
        expect(stored.artifact.file).toBe(compressed.file)
    })

    it('persists the same compressed bytes locally and skips R2 in Tauri Local mode', async () => {
        const compressed = artifact()
        mocks.isTauri.mockReturnValue(true)
        mocks.isLocal.mockReturnValue(true)
        mocks.persist.mockResolvedValue('product-images/workspace-id/id--atlas-product-primary-v1.webp')

        const stored = await mediaUploadService.storeCompressedImage(compressed, 'workspace-id', 'product-images')

        expect(mocks.persist).toHaveBeenCalledWith(compressed.file, 'workspace-id', 'product-images')
        expect(mocks.upload).not.toHaveBeenCalled()
        expect(stored.r2Key).toBeNull()
    })

    it('removes an offline copy if the required R2 upload fails', async () => {
        const compressed = artifact()
        mocks.isTauri.mockReturnValue(true)
        mocks.persist.mockResolvedValue('product-images/workspace-id/id--atlas-product-primary-v1.webp')
        mocks.upload.mockRejectedValue(new Error('R2 unavailable'))

        await expect(mediaUploadService.storeCompressedImage(compressed, 'workspace-id', 'product-images'))
            .rejects.toMatchObject({ code: 'upload_failed' })
        expect(mocks.remove).toHaveBeenCalledWith('product-images/workspace-id/id--atlas-product-primary-v1.webp')
    })

    it('rejects a source artifact routed to the wrong storage root', async () => {
        await expect(mediaUploadService.storeCompressedImage(artifact(), 'workspace-id', 'workspace-logos'))
            .rejects.toMatchObject({ code: 'upload_failed' })
        expect(mocks.upload).not.toHaveBeenCalled()
    })
})
