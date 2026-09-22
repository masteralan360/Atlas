import { MessageChannel as NodeMessageChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const preference = vi.hoisted(() => ({ disabled: false }))

vi.mock('./updatePreference', () => ({
    UPDATE_PREFERENCE_CHANGED_EVENT: 'atlas-updates-preference-changed',
    areApplicationUpdatesDisabled: () => preference.disabled,
}))

describe('PWA startup update control', () => {
    beforeEach(() => {
        preference.disabled = false
        vi.resetModules()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('honors the device update preference without touching the worker', async () => {
        preference.disabled = true
        const register = vi.fn()
        vi.stubGlobal('navigator', { serviceWorker: { register } })
        const { preparePwaReleaseForStartup } = await import('./pwaUpdateControl')

        await expect(preparePwaReleaseForStartup()).resolves.toEqual({ status: 'disabled' })
        expect(register).not.toHaveBeenCalled()
    })

    it('registers the stable worker and waits for a verified release before resolving', async () => {
        const posted: string[] = []
        const worker = {
            postMessage(message: { type: string }, ports: MessagePort[] = []) {
                posted.push(message.type)
                if (message.type === 'GET_UPDATE_CAPABILITIES') {
                    ports[0].postMessage({ type: 'UPDATE_CAPABILITIES', protocolVersion: 2 })
                }
                if (message.type === 'PREPARE_RELEASE') {
                    ports[0].postMessage({
                        type: 'PREPARE_RELEASE_PROGRESS',
                        completed: 1,
                        total: 2,
                        completedBytes: 25,
                        totalBytes: 100,
                    })
                    ports[0].postMessage({
                        type: 'PREPARE_RELEASE_COMPLETE',
                        status: 'updated',
                        ready: true,
                        buildId: 'sha256-build',
                        version: '1.1.0',
                        cachedAssets: 2,
                    })
                }
            }
        }
        const registration = {
            active: worker,
            installing: null,
            waiting: null,
            update: vi.fn().mockResolvedValue(undefined),
        }
        const serviceWorker = {
            register: vi.fn().mockResolvedValue(registration),
            ready: Promise.resolve(registration),
            controller: worker,
            addEventListener: vi.fn(),
        }
        vi.stubGlobal('navigator', { serviceWorker })
        vi.stubGlobal('MessageChannel', NodeMessageChannel)
        const storage = new Map<string, string>()
        vi.stubGlobal('window', {
            location: { href: 'https://atlas.example/', origin: 'https://atlas.example' },
            addEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
            setTimeout,
            clearTimeout,
            setInterval: vi.fn(),
            localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
                removeItem: (key: string) => storage.delete(key),
            },
        })
        vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn() })
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([])
        const { preparePwaReleaseForStartup } = await import('./pwaUpdateControl')
        const progress = vi.fn()

        await expect(preparePwaReleaseForStartup(progress)).resolves.toEqual({
            status: 'updated',
            buildId: 'sha256-build',
            version: '1.1.0',
            cachedAssets: 2,
        })
        expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', {
            scope: '/',
            updateViaCache: 'none',
        })
        expect(posted).toContain('GET_UPDATE_CAPABILITIES')
        expect(posted).toContain('PREPARE_RELEASE')
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'downloading',
            completedBytes: 25,
            totalBytes: 100,
        }))
    })

    it('stages background updates without forcing an active session to reload', async () => {
        let workerMessageHandler: ((event: MessageEvent) => void) | undefined
        const postMessage = vi.fn()
        const worker = { postMessage }
        const registration = { active: worker }
        const serviceWorker = {
            ready: Promise.resolve(registration),
            controller: worker,
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
                if (type === 'message') workerMessageHandler = handler
            }),
        }
        const storage = new Map<string, string>()
        const dispatchEvent = vi.fn()
        const reload = vi.fn()
        vi.stubGlobal('navigator', { serviceWorker })
        vi.stubGlobal('window', {
            location: { reload },
            addEventListener: vi.fn(),
            dispatchEvent,
            setInterval: vi.fn(),
            localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value),
                removeItem: (key: string) => storage.delete(key),
            },
        })
        vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn() })
        const { getPendingPwaUpdate, initializePwaUpdateControl } = await import('./pwaUpdateControl')

        initializePwaUpdateControl()
        workerMessageHandler?.({
            data: { type: 'UPDATE_READY', buildId: 'sha256-next', version: '1.2.0' },
        } as MessageEvent)

        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'APPLY_UPDATE' }))
        expect(reload).not.toHaveBeenCalled()
        expect(getPendingPwaUpdate()).toEqual({ buildId: 'sha256-next', version: '1.2.0' })
        expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'atlas-pwa-update-ready',
        }))
    })
})
