const origin = new URL(process.env.ATLAS_LIVE_SUPABASE_URL || 'https://invalid.local').origin
const originalFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('live_network_blocked')
    const timeout = AbortSignal.timeout(15_000)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const guardedFetch = () => originalFetch(input, { ...init, redirect: 'manual', signal })
    const hook = (globalThis as any)[Symbol.for('atlas.hosted.fetch')]
    const response = typeof hook === 'function'
        ? await hook(input, init, guardedFetch)
        : await guardedFetch()
    if (response.status >= 300 && response.status < 400) throw new Error('live_network_redirect_blocked')
    return response
}
