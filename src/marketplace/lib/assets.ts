import { platformService } from '@/services/platformService'

export function getMarketplaceAssetUrl(rawPath?: string | null) {
    const path = rawPath?.trim()
    if (!path) {
        return null
    }

    if (/^(https?:|data:image\/|blob:)/i.test(path)) {
        return path
    }

    return platformService.convertFileSrc(path)
}
