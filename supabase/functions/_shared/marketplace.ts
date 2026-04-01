const PUBLIC_ASSET_FOLDERS = new Set([
    'product-images',
    'workspace-logos',
    'profile-images'
])

const LEGACY_PUBLIC_ASSET_FOLDERS = new Set([
    'workspaces'
])

const MARKETPLACE_ASSET_FOLDERS = new Set([
    ...PUBLIC_ASSET_FOLDERS,
    ...LEGACY_PUBLIC_ASSET_FOLDERS
])

const ORDER_MESSAGES: Record<'en' | 'ar' | 'ku', string> = {
    en: 'Order submitted successfully. The store will contact you shortly.',
    ar: 'تم إرسال الطلب بنجاح. سيتواصل المتجر معك قريبًا.',
    ku: 'داواکاریەکەت بە سەرکەوتوویی نێردرا. فرۆشگا بە زوویی پەیوەندیت پێوە دەکات.'
}

function normalizeR2Path(path: string) {
    return path
        .split('/')
        .filter(Boolean)
        .map((segment) => {
            try {
                return encodeURIComponent(decodeURIComponent(segment))
            } catch {
                return encodeURIComponent(segment)
            }
        })
        .join('/')
}

type ResolvedMarketplaceAsset = {
    canonicalPath: string
    r2Key: string
}

function resolveMarketplaceAsset(path: string): ResolvedMarketplaceAsset | null {
    const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
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

function getMarketplaceAssetBaseUrl() {
    for (const key of ['R2_PUBLIC_BASE_URL', 'R2_WORKER_PUBLIC_BASE_URL', 'R2_WORKER_URL', 'VITE_R2_WORKER_URL']) {
        const value = (Deno.env.get(key) ?? '').trim().replace(/\/+$/, '')
        if (value) {
            return value
        }
    }

    return ''
}

export function normalizeMarketplaceLanguage(value?: string | null): 'en' | 'ar' | 'ku' {
    const normalized = (value ?? '').trim().toLowerCase()
    if (normalized === 'ar' || normalized === 'ku') {
        return normalized
    }

    return 'en'
}

export function getLocalizedMarketplaceOrderMessage(language?: string | null) {
    return ORDER_MESSAGES[normalizeMarketplaceLanguage(language)]
}

export function sanitizeMarketplaceText(value: unknown, maxLength = 240) {
    if (typeof value !== 'string') {
        return ''
    }

    return value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
}

export function sanitizeNullableMarketplaceText(value: unknown, maxLength = 240) {
    const sanitized = sanitizeMarketplaceText(value, maxLength)
    return sanitized.length > 0 ? sanitized : null
}

export function resolvePublicAssetUrl(rawPath?: string | null): string | null {
    const path = sanitizeMarketplaceText(rawPath, 4096)
    if (!path) {
        return null
    }

    if (/^https?:\/\//i.test(path) || /^data:image\//i.test(path)) {
        return path
    }

    let normalizedPath = path.replace(/\\/g, '/')

    if (/^file:\/\//i.test(normalizedPath)) {
        try {
            normalizedPath = decodeURIComponent(new URL(normalizedPath).pathname)
        } catch {
            return null
        }
    } else if (/^(data|blob):/i.test(normalizedPath)) {
        return null
    }

    const resolvedAsset = resolveMarketplaceAsset(normalizedPath)
    if (!resolvedAsset) {
        return null
    }

    const baseUrl = getMarketplaceAssetBaseUrl()
    if (!baseUrl) {
        return resolvedAsset.canonicalPath
    }

    return `${baseUrl}/${normalizeR2Path(resolvedAsset.r2Key)}`
}

export function getRequesterIp(req: Request) {
    const forwardedFor = req.headers.get('x-forwarded-for')
    if (forwardedFor) {
        const firstIp = forwardedFor.split(',')[0]?.trim()
        if (firstIp) {
            return firstIp
        }
    }

    return sanitizeNullableMarketplaceText(
        req.headers.get('cf-connecting-ip')
        ?? req.headers.get('x-real-ip')
        ?? req.headers.get('fly-client-ip')
        ?? req.headers.get('x-vercel-forwarded-for'),
        128
    )
}

export async function hashMarketplaceValue(value: string) {
    const bytes = new TextEncoder().encode(value)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('')
}

export function isMarketplaceOriginAllowed(origin: string | null) {
    const allowlist = (Deno.env.get('MARKETPLACE_ALLOWED_ORIGINS') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)

    if (allowlist.length === 0) {
        return true
    }

    if (!origin) {
        return false
    }

    return allowlist.includes(origin)
}
