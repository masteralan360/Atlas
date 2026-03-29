const PUBLIC_ASSET_FOLDERS = new Set([
    'product-images',
    'workspace-logos',
    'profile-images'
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
    const path = sanitizeMarketplaceText(rawPath, 1024)
    if (!path) {
        return null
    }

    if (/^https?:\/\//i.test(path)) {
        return path
    }

    if (/^(data|blob|asset|file):/i.test(path)) {
        return null
    }

    if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\')) {
        return null
    }

    const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segments.length < 3) {
        return null
    }

    let r2Key: string | null = null

    if (PUBLIC_ASSET_FOLDERS.has(segments[0])) {
        r2Key = `${segments[1]}/${segments[0]}/${segments.slice(2).join('/')}`
    } else if (PUBLIC_ASSET_FOLDERS.has(segments[1])) {
        r2Key = `${segments[0]}/${segments[1]}/${segments.slice(2).join('/')}`
    }

    const baseUrl = (Deno.env.get('R2_PUBLIC_BASE_URL') ?? '').trim().replace(/\/+$/, '')
    if (!baseUrl || !r2Key) {
        return null
    }

    return `${baseUrl}/${normalizeR2Path(r2Key)}`
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
