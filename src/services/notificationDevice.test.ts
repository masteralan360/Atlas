import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    isDesktop: vi.fn(() => false),
    isMobile: vi.fn(() => false),
    isTauri: vi.fn(() => false),
    requestFirebaseTokenSync: vi.fn(async () => 'web-token'),
    getSession: vi.fn(async () => ({ data: { session: { access_token: 'session-token' } } })),
    invoke: vi.fn(async (_command: string): Promise<string | string[] | null> => null),
    tauriFetch: vi.fn(async () => new Response(JSON.stringify({ registered: true }), { status: 200 }))
}))

vi.mock('@/lib/platform', () => ({
    isDesktop: mocks.isDesktop,
    isMobile: mocks.isMobile,
    isTauri: mocks.isTauri
}))
vi.mock('@/lib/firebase', () => ({ requestFirebaseTokenSync: mocks.requestFirebaseTokenSync }))
vi.mock('@/auth/supabase', () => ({
    isSupabaseConfigured: true,
    supabase: { auth: { getSession: mocks.getSession } }
}))
vi.mock('@/lib/network', () => ({ getActiveBusinessWorkspaceId: () => 'workspace-1' }))
vi.mock('@/workspace/workspaceMode', () => ({ isLocalWorkspaceMode: () => false }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.tauriFetch }))

describe('device token registration by platform', () => {
    const stored = new Map<string, string>()
    const browserFetch = vi.fn(async () => new Response(JSON.stringify({ registered: true }), { status: 200 }))

    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        stored.clear()
        mocks.isDesktop.mockReturnValue(false)
        mocks.isMobile.mockReturnValue(false)
        mocks.isTauri.mockReturnValue(false)
        mocks.requestFirebaseTokenSync.mockResolvedValue('web-token')
        mocks.invoke.mockResolvedValue(null)
        browserFetch.mockResolvedValue(new Response(JSON.stringify({ registered: true }), { status: 200 }))
        vi.stubGlobal('fetch', browserFetch)
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value)
        })
        vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-key')
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    it('skips Firebase and remote registration in desktop Tauri', async () => {
        mocks.isDesktop.mockReturnValue(true)
        const { registerDeviceTokenIfNeeded } = await import('./notificationDevice')

        await expect(registerDeviceTokenIfNeeded('user-1', 'en')).resolves.toBeUndefined()
        expect(mocks.requestFirebaseTokenSync).not.toHaveBeenCalled()
        expect(mocks.getSession).not.toHaveBeenCalled()
        expect(browserFetch).not.toHaveBeenCalled()
        expect(mocks.tauriFetch).not.toHaveBeenCalled()
        expect(stored.size).toBe(0)
    })

    it('keeps the browser token registration request and cache behavior', async () => {
        const { registerDeviceTokenIfNeeded } = await import('./notificationDevice')

        await registerDeviceTokenIfNeeded('user-1', 'en')

        expect(mocks.requestFirebaseTokenSync).toHaveBeenCalledOnce()
        expect(browserFetch).toHaveBeenCalledWith(
            'https://example.supabase.co/functions/v1/register-device-token',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer session-token',
                    apikey: 'public-key'
                }),
                body: JSON.stringify({ token: 'web-token', platform: 'web', language: 'en' })
            })
        )
        expect(JSON.parse(stored.get('atlas_device_token:web:user-1') ?? '')).toEqual({
            token: 'web-token', language: 'en'
        })
    })

    it('keeps the native Android FCM token path', async () => {
        mocks.isTauri.mockReturnValue(true)
        mocks.isMobile.mockReturnValue(true)
        mocks.invoke.mockImplementation(async (command: string) =>
            command === 'read_fcm_token' ? 'android-token' : []
        )
        const { registerDeviceTokenIfNeeded } = await import('./notificationDevice')

        await registerDeviceTokenIfNeeded('user-1', 'en')

        expect(mocks.requestFirebaseTokenSync).not.toHaveBeenCalled()
        expect(mocks.tauriFetch).toHaveBeenCalledWith(
            'https://example.supabase.co/functions/v1/register-device-token',
            expect.objectContaining({
                body: JSON.stringify({ token: 'android-token', platform: 'android', language: 'en' })
            })
        )
        expect(stored.has('atlas_device_token:android:user-1')).toBe(true)
    })

    it('leaves a failed browser registration uncached for a later retry', async () => {
        browserFetch.mockResolvedValue(new Response('Unavailable', { status: 503 }))
        const { registerDeviceTokenIfNeeded } = await import('./notificationDevice')

        await expect(registerDeviceTokenIfNeeded('user-1', 'en')).resolves.toBeUndefined()
        expect(stored.size).toBe(0)
        expect(console.warn).toHaveBeenCalledWith(
            '[Notifications] Edge function returned error:', 503, 'Unavailable'
        )
    })
})
