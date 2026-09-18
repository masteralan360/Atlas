import { isTauri } from '@/lib/platform'
import { platformService } from '@/services/platformService'
import { r2Service } from '@/services/r2Service'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PRODUCT_IMAGE_DIMENSION = 2048
const MAX_PRODUCT_IMAGE_PIXELS = 24_000_000

export type ProductImageStorageErrorCode =
    | 'invalid_url'
    | 'cloud_required'
    | 'unsupported_image'
    | 'image_too_large'
    | 'image_decode_failed'
    | 'image_processing_failed'
    | 'upload_failed'
    | 'import_failed'

export class ProductImageStorageError extends Error {
    constructor(public readonly code: ProductImageStorageErrorCode) {
        super(code)
        this.name = 'ProductImageStorageError'
    }
}

type SupportedProductImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif'

function isByteSequence(bytes: Uint8Array, expected: number[], offset = 0): boolean {
    return expected.every((value, index) => bytes[offset + index] === value)
}

/** Checks file signatures instead of trusting a browser or remote MIME type. */
export function detectSupportedProductImageMime(bytes: Uint8Array): SupportedProductImageMime | null {
    if (isByteSequence(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
    if (isByteSequence(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
    if (isByteSequence(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || isByteSequence(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
    if (isByteSequence(bytes, [0x52, 0x49, 0x46, 0x46]) && isByteSequence(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
    if (isByteSequence(bytes, [0x66, 0x74, 0x79, 0x70], 4)
        && (isByteSequence(bytes, [0x61, 0x76, 0x69, 0x66], 8) || isByteSequence(bytes, [0x61, 0x76, 0x69, 0x73], 8))) {
        return 'image/avif'
    }
    return null
}

export function validateExternalProductImageUrl(value: string): string {
    let url: URL
    try {
        url = new URL(value.trim())
    } catch {
        throw new ProductImageStorageError('invalid_url')
    }

    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new ProductImageStorageError('invalid_url')
    }
    return url.toString()
}

function assertSupportedProductImageFile(file: File): void {
    if (file.size <= 0 || file.size > MAX_PRODUCT_IMAGE_BYTES) {
        throw new ProductImageStorageError('image_too_large')
    }
}

function getProductImageOutputExtension(type: string): string {
    switch (type) {
        case 'image/jpeg': return 'jpg'
        case 'image/png': return 'png'
        case 'image/webp': return 'webp'
        default: return 'webp'
    }
}

/** Shared validation, decode, resize, and WebP encoding pipeline for every product image. */
export async function optimizeProductImageFile(file: File): Promise<File> {
    assertSupportedProductImageFile(file)
    const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer())
    if (!detectSupportedProductImageMime(bytes)) {
        throw new ProductImageStorageError('unsupported_image')
    }

    const previewUrl = URL.createObjectURL(file)
    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const element = new Image()
            element.decoding = 'async'
            element.onload = () => resolve(element)
            element.onerror = () => reject(new ProductImageStorageError('image_decode_failed'))
            element.src = previewUrl
        })
        const sourceWidth = image.naturalWidth
        const sourceHeight = image.naturalHeight
        if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_PRODUCT_IMAGE_PIXELS) {
            throw new ProductImageStorageError('image_decode_failed')
        }

        const scale = Math.min(1, MAX_PRODUCT_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight))
        const width = Math.max(1, Math.round(sourceWidth * scale))
        const height = Math.max(1, Math.round(sourceHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) throw new ProductImageStorageError('image_processing_failed')

        context.drawImage(image, 0, 0, width, height)
        const optimizedBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob)
                else reject(new ProductImageStorageError('image_processing_failed'))
            }, 'image/webp', 0.86)
        })
        if (!['image/webp', 'image/jpeg', 'image/png'].includes(optimizedBlob.type)) {
            throw new ProductImageStorageError('image_processing_failed')
        }

        const outputName = `${crypto.randomUUID()}.${getProductImageOutputExtension(optimizedBlob.type)}`
        return new File([optimizedBlob], outputName, { type: optimizedBlob.type })
    } finally {
        URL.revokeObjectURL(previewUrl)
    }
}

function createProductImageStoragePath(workspaceId: string, fileName: string): { path: string; r2Key: string } {
    return {
        path: `product-images/${workspaceId}/${fileName}`,
        r2Key: `${workspaceId}/product-images/${fileName}`
    }
}

/**
 * Browser uploads have no data-URL or local-path fallback: they are decoded,
 * optimized, and written to R2 before a product can reference them. Tauri
 * retains its local file for offline display, while Cloud and Hybrid modes
 * also require its corresponding R2 object to exist first.
 */
export async function storeProductImageFile(file: File, workspaceId: string): Promise<string | null> {
    if (isTauri()) {
        if (!isLocalWorkspaceMode(workspaceId) && !r2Service.isConfigured()) {
            throw new ProductImageStorageError('cloud_required')
        }

        const targetPath = await platformService.saveImageFile(file, workspaceId)
        if (!targetPath) {
            throw new ProductImageStorageError('upload_failed')
        }

        // Cloud and Hybrid desktop workspaces retain the local copy for
        // offline rendering, but the product may not reference it until the
        // matching R2 object has been stored successfully.
        if (!isLocalWorkspaceMode(workspaceId)) {
            try {
                const fileName = targetPath.replace(/\\/g, '/').split('/').pop()
                if (!fileName) throw new Error('Saved product image has no filename')
                const { r2Key } = createProductImageStoragePath(workspaceId, fileName)
                await r2Service.upload(r2Key, file, file.type || 'application/octet-stream')
            } catch (error) {
                console.error('[ProductImageStorage] Tauri R2 upload failed:', error)
                throw new ProductImageStorageError('upload_failed')
            }
        }
        return targetPath
    }
    if (isLocalWorkspaceMode(workspaceId) || !r2Service.isConfigured()) {
        throw new ProductImageStorageError('cloud_required')
    }

    const optimizedFile = await optimizeProductImageFile(file)
    const { path, r2Key } = createProductImageStoragePath(workspaceId, optimizedFile.name)
    try {
        await r2Service.upload(r2Key, optimizedFile, optimizedFile.type)
        return path
    } catch (error) {
        console.error('[ProductImageStorage] R2 upload failed:', error)
        throw new ProductImageStorageError('upload_failed')
    }
}

/**
 * Downloads through the authenticated Worker, then persists the verified
 * image through the normal product-image storage path. Browser images are
 * optimized and written to R2; Tauri writes the image to AppData, including
 * for Local workspaces. The supplied source URL is never stored or rendered.
 */
export async function importProductImageFromUrl(sourceUrl: string, workspaceId: string): Promise<string> {
    // Tauri still needs the authenticated Worker to make the untrusted fetch
    // safe, but persists the verified result locally. Browser Local mode has
    // no remote import path and remains file-only.
    if ((!isTauri() && isLocalWorkspaceMode(workspaceId)) || !r2Service.isConfigured()) {
        throw new ProductImageStorageError('cloud_required')
    }

    const validatedUrl = validateExternalProductImageUrl(sourceUrl)
    let downloadedImage: Blob
    try {
        downloadedImage = await r2Service.fetchExternalProductImage(validatedUrl)
    } catch (error) {
        console.error('[ProductImageStorage] External image import failed:', error)
        throw new ProductImageStorageError('import_failed')
    }

    const downloadedFile = new File([downloadedImage], 'external-image', { type: downloadedImage.type })
    // Tauri normally keeps upload files in their original local format. URL
    // imports are different: they must use the same validation and optimization
    // pipeline as browser imports before being persisted to AppData.
    const fileToStore = isTauri()
        ? await optimizeProductImageFile(downloadedFile)
        : downloadedFile
    const storedPath = await storeProductImageFile(fileToStore, workspaceId)
    if (!storedPath) throw new ProductImageStorageError('upload_failed')
    return storedPath
}

export function isProductImagePath(value?: string | null): value is string {
    if (!value || /^(https?:|data:|blob:|file:)/i.test(value)) return false
    const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
    return /^product-images\/[0-9a-f-]+\/[^/]+/i.test(normalized)
        || /^[0-9a-f-]+\/product-images\/[^/]+/i.test(normalized)
}

function toProductImageR2Key(value: string): string | null {
    const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
    const canonicalPath = normalized.match(/^product-images\/([0-9a-f-]+)\/(.+)$/i)
    if (canonicalPath) return `${canonicalPath[1]}/product-images/${canonicalPath[2]}`
    return /^[0-9a-f-]+\/product-images\/.+/i.test(normalized) ? normalized : null
}

/** Browser product images must resolve from R2; Tauri may render local files. */
export function getProductImageDisplayUrl(value?: string | null): string {
    if (!value) return ''

    if (isProductImagePath(value)) {
        if (isTauri()) return platformService.convertFileSrc(value)
        const r2Key = toProductImageR2Key(value)
        return r2Key ? r2Service.getUrl(r2Key) : ''
    }

    // Old marketplace payloads stored the application's own public R2 URL.
    // Re-resolve only an exact configured R2 Worker URL to its key; never
    // render the supplied URL or permit an arbitrary HTTP(S) image source.
    if (isTauri()) return ''
    const r2Key = r2Service.getObjectKeyFromPublicUrl(value)
    if (!r2Key || !/^[0-9a-f-]+\/product-images\/[^/]+$/i.test(r2Key)) return ''
    return r2Key ? r2Service.getUrl(r2Key) : ''
}
