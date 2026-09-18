import { afterEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock, saveImageFileMock, fetchExternalProductImageMock, r2UploadMock } = vi.hoisted(() => ({
    isTauriMock: vi.fn(() => false),
    saveImageFileMock: vi.fn(),
    fetchExternalProductImageMock: vi.fn(),
    r2UploadMock: vi.fn()
}))

vi.mock('@/lib/platform', () => ({ isTauri: isTauriMock }))
vi.mock('@/services/platformService', () => ({
    platformService: {
        convertFileSrc: (path: string) => `file://${path}`,
        saveImageFile: saveImageFileMock
    }
}))
vi.mock('@/services/r2Service', () => ({
    r2Service: {
        getUrl: (path: string) => `https://r2.example/${path}`,
        getObjectKeyFromPublicUrl: (url: string) => url.startsWith('https://r2.example/')
            ? url.slice('https://r2.example/'.length)
            : null,
        isConfigured: () => true,
        upload: r2UploadMock,
        fetchExternalProductImage: fetchExternalProductImageMock
    }
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
        saveImageFileMock.mockReset()
        fetchExternalProductImageMock.mockReset()
        r2UploadMock.mockReset()
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
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => ({ drawImage: vi.fn() })),
            toBlob: (callback: BlobCallback) => callback(new Blob([sourceBytes], { type: 'image/webp' }))
        }
        class TestImage {
            decoding = ''
            naturalWidth = 1
            naturalHeight = 1
            onload: (() => void) | null = null
            onerror: (() => void) | null = null

            set src(_value: string) {
                queueMicrotask(() => this.onload?.())
            }
        }
        vi.stubGlobal('Image', TestImage)
        vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
        fetchExternalProductImageMock.mockResolvedValue(new Blob([sourceBytes], { type: 'image/png' }))
        saveImageFileMock.mockResolvedValue(localPath)
        r2UploadMock.mockResolvedValue('https://r2.example/workspace-id/product-images/123.webp')

        await expect(importProductImageFromUrl(sourceUrl, 'workspace-id')).resolves.toBe(localPath)
        expect(fetchExternalProductImageMock).toHaveBeenCalledWith(sourceUrl)
        expect(saveImageFileMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/webp' }), 'workspace-id')
        expect(r2UploadMock).toHaveBeenCalledWith(
            'workspace-id/product-images/123.webp',
            expect.objectContaining({ type: 'image/webp' }),
            'image/webp'
        )
    })

    it('rejects a Tauri URL import when its verified local image cannot be uploaded to R2', async () => {
        isTauriMock.mockReturnValue(true)
        const sourceBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => ({ drawImage: vi.fn() })),
            toBlob: (callback: BlobCallback) => callback(new Blob([sourceBytes], { type: 'image/webp' }))
        }
        class TestImage {
            decoding = ''
            naturalWidth = 1
            naturalHeight = 1
            onload: (() => void) | null = null

            set src(_value: string) {
                queueMicrotask(() => this.onload?.())
            }
        }
        vi.stubGlobal('Image', TestImage)
        vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
        fetchExternalProductImageMock.mockResolvedValue(new Blob([sourceBytes], { type: 'image/png' }))
        saveImageFileMock.mockResolvedValue('product-images/workspace-id/123.webp')
        r2UploadMock.mockRejectedValue(new Error('R2 is unavailable'))

        await expect(importProductImageFromUrl('https://images.example.com/item.png', 'workspace-id'))
            .rejects.toMatchObject({ code: 'upload_failed' })
    })
})
