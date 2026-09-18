const PRODUCT_IMAGE_PATH_PATTERN = /^product-images\/[0-9a-f-]{36}\/[^/?#\\]+$/i

/**
 * Marketplace order records retain a product-image snapshot. Keep that
 * snapshot as the canonical product-image storage path, never as a rendered
 * public URL. The browser resolves the path to the configured R2 origin only
 * at display time.
 */
export function getCanonicalProductImagePath(value?: string | null): string | null {
    if (typeof value !== 'string') return null

    const normalized = value
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')

    if (!normalized || /^(?:https?|data|blob|file):/i.test(normalized)) return null
    return PRODUCT_IMAGE_PATH_PATTERN.test(normalized) ? normalized : null
}
