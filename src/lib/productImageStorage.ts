import { isTauri } from '@/lib/platform'
import { platformService } from '@/services/platformService'
import { r2Service } from '@/services/r2Service'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import {
    compressImage,
    detectSupportedImageMime,
    ImageCompressionError,
    type SupportedImageMime,
} from '@/lib/imageCompression'
import type { ImageUploadSource } from '@/lib/imageUploadProfiles'
import { mediaUploadService, MediaUploadError } from '@/services/mediaUploadService'

export type ProductImageStorageErrorCode =
    | 'invalid_url'
    | 'cloud_required'
    | 'unsupported_image'
    | 'animated_image'
    | 'empty_image'
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

/** Checks file signatures instead of trusting a browser or remote MIME type. */
export function detectSupportedProductImageMime(bytes: Uint8Array): SupportedImageMime | null {
    return detectSupportedImageMime(bytes)
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

/** Shared validation, decode, resize, and WebP encoding pipeline for every product image. */
export async function optimizeProductImageFile(file: File, source: ImageUploadSource = 'product-primary'): Promise<File> {
    try {
        return (await compressImage(file, source)).file
    } catch (error) {
        throw toProductImageStorageError(error)
    }
}

function toProductImageStorageError(error: unknown): ProductImageStorageError {
    if (error instanceof ProductImageStorageError) return error
    if (error instanceof ImageCompressionError) return new ProductImageStorageError(error.code)
    if (error instanceof MediaUploadError) return new ProductImageStorageError(error.code)
    return new ProductImageStorageError('upload_failed')
}

/**
 * Browser uploads have no data-URL or local-path fallback: they are decoded,
 * optimized, and written to R2 before a product can reference them. Tauri
 * retains its local file for offline display, while Cloud and Hybrid modes
 * also require its corresponding R2 object to exist first.
 */
export async function storeProductImageFile(file: File, workspaceId: string, source: ImageUploadSource): Promise<string | null> {
    try {
        return (await mediaUploadService.storeImageFile(file, workspaceId, 'product-images', source)).path
    } catch (error) {
        throw toProductImageStorageError(error)
    }
}

/**
 * Downloads through the authenticated Worker, then persists the verified
 * image through the normal product-image storage path. Browser images are
 * optimized and written to R2; Tauri writes the image to AppData, including
 * for Local workspaces. The supplied source URL is never stored or rendered.
 */
export async function importProductImageFromUrl(sourceUrl: string, workspaceId: string, source: ImageUploadSource): Promise<string> {
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
    const storedPath = await storeProductImageFile(downloadedFile, workspaceId, source)
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
