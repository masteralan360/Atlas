import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getMessaging: vi.fn(() => ({ app: 'messaging' })),
    getToken: vi.fn(async () => 'firebase-token'),
    initializeApp: vi.fn(() => ({ app: 'firebase' })),
    isSupported: vi.fn(async () => true),
    onMessage: vi.fn(),
    register: vi.fn(async () => ({ scope: 'firebase-registration' }))
}))

vi.mock('firebase/app', () => ({
    initializeApp: mocks.initializeApp
}))

vi.mock('firebase/messaging', () => ({
    getMessaging: mocks.getMessaging,
    getToken: mocks.getToken,
    isSupported: mocks.isSupported,
    onMessage: mocks.onMessage
}))

describe('Firebase service-worker registration', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.stubGlobal('window', {})
        vi.stubEnv('VITE_FIREBASE_API_KEY', 'public-api-key')
        vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'project-id')
        vi.stubEnv('VITE_FIREBASE_MESSAGING_SENDER_ID', 'sender-id')
        vi.stubEnv('VITE_FIREBASE_APP_ID', 'app-id')
        vi.stubEnv('VITE_FIREBASE_VAPID_KEY', 'A'.repeat(87))

        vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') })
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0',
            serviceWorker: { register: mocks.register }
        })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    it('keeps Firebase messaging outside the Atlas navigation scope', async () => {
        const { requestFirebaseTokenSync } = await import('./firebase')

        await expect(requestFirebaseTokenSync()).resolves.toBe('firebase-token')
        expect(mocks.register).toHaveBeenCalledWith(
            expect.stringContaining('/firebase-messaging-sw.js?'),
            { scope: '/firebase-cloud-messaging-push-scope/' }
        )
        expect(mocks.getToken).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                serviceWorkerRegistration: expect.objectContaining({
                    scope: 'firebase-registration'
                })
            })
        )
    })

    it('does not initialize web messaging or register a worker in desktop Tauri', async () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
        const { initMessaging, requestFirebaseTokenSync } = await import('./firebase')

        await expect(initMessaging()).resolves.toBeNull()
        await expect(requestFirebaseTokenSync()).resolves.toBeNull()
        expect(mocks.isSupported).not.toHaveBeenCalled()
        expect(mocks.register).not.toHaveBeenCalled()
        expect(mocks.getToken).not.toHaveBeenCalled()
    })

    it('keeps web messaging available in a mobile Tauri runtime', async () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Linux; Android 14)',
            serviceWorker: { register: mocks.register }
        })
        const { requestFirebaseTokenSync } = await import('./firebase')

        await expect(requestFirebaseTokenSync()).resolves.toBe('firebase-token')
        expect(mocks.register).toHaveBeenCalledOnce()
    })
})
