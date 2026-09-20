import { afterEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock, fetchExternalProductImageMock, mediaStoreMock } = vi.hoisted(() => ({
    isTauriMock: vi.fn(() => false),
    fetchExternalProductImageMock: vi.fn(),
    mediaStoreMock: vi.fn()
}))

vi.mock('@/lib/platform', () => ({ isTauri: isTauriMock }))
vi.mock('@/services/platformService', () => ({
    platformService: {
        convertFileSrc: (path: string) => `file://${path}`,
    }
}))
vi.mock('@/services/r2Service', () => ({
    r2Service: {
        getUrl: (path: string) => `https://r2.example/${path}`,
        getObjectKeyFromPublicUrl: (url: string) => url.startsWith('https://r2.example/')
            ? url.slice('https://r2.example/'.length)
            : null,
        isConfigured: () => true,
        fetchExternalProductImage: fetchExternalProductImageMock
    }
}))
vi.mock('@/services/mediaUploadService', () => ({
    mediaUploadService: { storeImageFile: mediaStoreMock },
    MediaUploadError: class MediaUploadError extends Error {
        constructor(public code: string) { super(code) }
    },
}))
vi.mock('@/workspace/workspaceMode', () => ({ isLocalWorkspaceMode: () => false }))

import {
    detectSupportedProductImageMime,
    getProductImageDisplayUrl,
    isProductImagePath,
    ProductImageStorageError,
    importProductImageFromUrl,
    validateExternalProductImageUrl
} from './productImageStorage'

describe('product image storage policy', () => {
    afterEach(() => {
        isTauriMock.mockReturnValue(false)
        fetchExternalProductImageMock.mockReset()
        mediaStoreMock.mockReset()
        vi.unstubAllGlobals()
    })

    it('recognizes only supported raster image signatures', () => {
        expect(detectSupportedProductImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
        expect(detectSupportedProductImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
        expect(detectSupportedProductImageMime(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull()
    })

    it('accepts only credential-free HTTP(S) source URLs', () => {
        expect(validateExternalProductImageUrl('https://images.example.com/item.png')).toBe('https://images.example.com/item.png')
        expect(() => validateExternalProductImageUrl('ftp://images.example.com/item.png')).toThrow(ProductImageStorageError)
        expect(() => validateExternalProductImageUrl('https://user:secret@images.example.com/item.png')).toThrow(ProductImageStorageError)
    })

    it('renders canonical paths and re-resolves only a trusted R2 URL without hotlinking it', () => {
        const canonicalPath = 'product-images/6f8cf944-4663-4eb8-bdf0-6dd35e68b6c1/image.webp'
        const r2Key = '6f8cf944-4663-4eb8-bdf0-6dd35e68b6c1/product-images/image.webp'
        expect(isProductImagePath(canonicalPath)).toBe(true)
        expect(getProductImageDisplayUrl(canonicalPath)).toBe(`https://r2.example/${r2Key}`)
        expect(getProductImageDisplayUrl(`https://r2.example/${r2Key}`)).toBe(`https://r2.example/${r2Key}`)
        expect(getProductImageDisplayUrl('https://external.example/image.png')).toBe('')
        expect(getProductImageDisplayUrl('data:image/png;base64,abc')).toBe('')
    })

    it('imports a verified URL image into Tauri local product storage instead of retaining its source URL', async () => {
        isTauriMock.mockReturnValue(true)
        const sourceUrl = 'https://images.example.com/item.png'
        const localPath = 'product-images/workspace-id/123.webp'
        const sourceBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        fetchExternalProductImageMock.mockResolvedValue(new Blob([sourceBytes], { type: 'image/png' }))
        mediaStoreMock.mockResolvedValue({ path: localPath })

        await expect(importProductImageFromUrl(sourceUrl, 'workspace-id', 'product-primary')).resolves.toBe(localPath)
        expect(fetchExternalProductImageMock).toHaveBeenCalledWith(sourceUrl)
        expect(mediaStoreMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'image/png' }),
            'workspace-id',
            'product-images',
            'product-primary',
        )
    })

    it('rejects a Tauri URL import when its verified local image cannot be uploaded to R2', async () => {
        isTauriMock.mockReturnValue(true)
        const sourceBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        fetchExternalProductImageMock.mockResolvedValue(new Blob([sourceBytes], { type: 'image/png' }))
        mediaStoreMock.mockRejectedValue(new Error('R2 is unavailable'))

        await expect(importProductImageFromUrl('https://images.example.com/item.png', 'workspace-id', 'product-primary'))
            .rejects.toMatchObject({ code: 'upload_failed' })
    })
})
