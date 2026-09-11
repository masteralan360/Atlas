const JUMLA_KHALEEJ_ORIGIN = (import.meta.env.VITE_JUMLA_KHALEEJ_ORIGIN || 'https://khaleejcosmetic.com').replace(/\/+$/, '')

/**
 * The canonical generator caches images by storefront mode. A generation-only
 * suffix gives every Atlas regeneration fresh product/logo assets; the suffix
 * is removed again before the public JumlaKhaleej image request is sent.
 */
export function createFreshStorefrontPdfAssetMode(mode: 'retail' | 'wholesale') {
  return `${mode}:${crypto.randomUUID()}` as 'retail' | 'wholesale'
}

/**
 * Compatibility adapter used by the vendored JumlaKhaleej PDF generator.
 * Its public image route is CORS-enabled and supplies the generator's built-in
 * product/logo fallbacks without exposing Atlas authentication.
 */
export function storefrontApiUrl(path: string) {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, JUMLA_KHALEEJ_ORIGIN)
  const runtimeMode = url.searchParams.get('mode')
  const storefrontMode = runtimeMode?.split(':', 1)[0]
  if (storefrontMode === 'retail' || storefrontMode === 'wholesale') {
    url.searchParams.set('mode', storefrontMode)
  }
  return url.toString()
}
