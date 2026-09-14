import { assetManager } from '@/lib/assetManager'
import { isTauri } from '@/lib/platform'
import { platformService } from '@/services/platformService'

/**
 * Stores one product image using the exact location and fallback strategy used
 * by products.image_url. The caller owns when the upload starts and whether the
 * returned path is persisted as a primary or additional image.
 */
export async function storeProductImageFile(file: File, workspaceId: string): Promise<string | null> {
    if (isTauri()) {
        const targetPath = await platformService.saveImageFile(file, workspaceId)
        if (targetPath) {
            // Keep the desktop upload behavior aligned with the primary image:
            // the local image is usable immediately while it syncs to storage.
            assetManager.uploadFromPath(targetPath).catch(console.error)
        }
        return targetPath
    }

    return platformService.saveImageFile(file, workspaceId, 'product-images')
}

export function getProductImageDisplayUrl(url?: string | null): string {
    if (!url) return ''
    if (/^(https?:|data:|blob:)/i.test(url)) return url
    return platformService.convertFileSrc(url)
}
