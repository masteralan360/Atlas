import { platformService } from '@/services/platformService'
import { r2Service } from '@/services/r2Service'

const MARKETPLACE_ASSET_FOLDERS = new Set([
    'product-images',
    'workspace-logos',
    'profile-images',
    'workspaces'
])

type ResolvedMarketplaceAsset = {
    canonicalPath: string
    r2Key: string
}

function resolveMarketplaceAsset(rawPath: string): ResolvedMarketplaceAsset | null {
    let normalizedPath = rawPath.replace(/\\/g, '/')

    if (/^file:\/\//i.test(normalizedPath)) {
        try {
            normalizedPath = decodeURIComponent(new URL(normalizedPath).pathname)
        } catch {
            return null
        }
    }

    const segments = normalizedPath.split('/').filter(Boolean)
    if (segments.length < 3) {
        return null
    }

    for (let index = 0; index <= segments.length - 3; index += 1) {
        const folder = segments[index]
        const workspaceId = segments[index + 1]
        const filePath = segments.slice(index + 2).join('/')

        if (!MARKETPLACE_ASSET_FOLDERS.has(folder) || !workspaceId || !filePath) {
            continue
        }

        return {
            canonicalPath: `${folder}/${workspaceId}/${filePath}`,
            r2Key: `${workspaceId}/${folder}/${filePath}`
        }
    }

    for (let index = 0; index <= segments.length - 3; index += 1) {
        const workspaceId = segments[index]
        const folder = segments[index + 1]
        const filePath = segments.slice(index + 2).join('/')

        if (!MARKETPLACE_ASSET_FOLDERS.has(folder) || !workspaceId || !filePath) {
            continue
        }

        return {
            canonicalPath: `${folder}/${workspaceId}/${filePath}`,
            r2Key: `${workspaceId}/${folder}/${filePath}`
        }
    }

    return null
}

export function getMarketplaceAssetUrl(rawPath?: string | null) {
    const path = rawPath?.trim()
    if (!path) {
        return null
    }

    if (/^(https?:|data:image\/|blob:)/i.test(path)) {
        return path
    }

    const resolvedAsset = resolveMarketplaceAsset(path)
    if (resolvedAsset) {
        const publicUrl = r2Service.getUrl(resolvedAsset.r2Key)
        if (publicUrl) {
            return publicUrl
        }

        return platformService.convertFileSrc(resolvedAsset.canonicalPath)
    }

    return platformService.convertFileSrc(path)
}
