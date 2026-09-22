import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function digest(value) {
    return createHash('sha256').update(value).digest('hex')
}

function memoryCaches() {
    const stores = new Map()
    const key = (request, ignoreSearch = false) => {
        const url = new URL(typeof request === 'string' ? request : request.url)
        if (ignoreSearch) url.search = ''
        return url.href
    }
    const open = async (name) => {
        if (!stores.has(name)) stores.set(name, new Map())
        const entries = stores.get(name)
        return {
            async put(request, response) { entries.set(key(request), response.clone()) },
            async match(request, options = {}) {
                const exact = entries.get(key(request))
                if (exact) return exact.clone()
                if (options.ignoreSearch) {
                    const target = key(request, true)
                    for (const [entryKey, response] of entries) {
                        if (key(entryKey, true) === target) return response.clone()
                    }
                }
                return undefined
            },
            async keys() { return [...entries.keys()].map((url) => new Request(url)) },
        }
    }
    return {
        stores,
        api: {
            open,
            async keys() { return [...stores.keys()] },
            async delete(name) { return stores.delete(name) },
            async match(request, options) {
                for (const name of stores.keys()) {
                    const response = await (await open(name)).match(request, options)
                    if (response) return response
                }
                return undefined
            },
        },
    }
}

function createHarness() {
    const listeners = new Map()
    const cacheStorage = memoryCaches()
    const shell = '<!doctype html><main>Atlas release</main>'
    let release = {
        schemaVersion: 1,
        updateProtocol: 2,
        channel: 'production',
        version: '1.1.0',
        buildId: `sha256-${'1'.repeat(64)}`,
        assets: [{ url: '/', bytes: Buffer.byteLength(shell), sha256: digest(shell) }],
    }
    const fetchMock = vi.fn(async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/pwa-release.json') return Response.json(release)
        if (url.pathname === '/') return new Response(shell, { status: 200 })
        return new Response('Not found', { status: 404 })
    })
    const serviceWorkerGlobal = {
        location: { origin: 'https://atlas.example' },
        clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => []) },
        skipWaiting: vi.fn(),
        addEventListener(type, listener) { listeners.set(type, listener) },
    }
    const context = vm.createContext({
        self: serviceWorkerGlobal,
        caches: cacheStorage.api,
        fetch: fetchMock,
        crypto: webcrypto,
        Request,
        Response,
        URL,
        console,
        setTimeout,
        clearTimeout,
    })
    vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context)

    async function message(data) {
        const messages = []
        let lifetime = Promise.resolve()
        listeners.get('message')({
            data,
            ports: [{ postMessage(value) { messages.push(value) } }],
            waitUntil(value) { lifetime = Promise.resolve(value) },
        })
        await lifetime
        return messages
    }

    return {
        cacheStorage,
        fetchMock,
        message,
        setRelease(value) { release = value },
        shell,
    }
}

describe('Atlas PWA service worker', () => {
    it('reports its updater protocol to installed clients', async () => {
        const harness = createHarness()
        await expect(harness.message({ type: 'GET_UPDATE_CAPABILITIES' })).resolves.toEqual([{
            type: 'UPDATE_CAPABILITIES',
            protocolVersion: 2,
            releaseSchemaVersion: 1,
        }])
    })

    it('activates a complete verified release and reports progress', async () => {
        const harness = createHarness()
        const messages = await harness.message({ type: 'PREPARE_RELEASE' })

        expect(messages.some((message) => message.type === 'PREPARE_RELEASE_PROGRESS')).toBe(true)
        expect(messages.at(-1)).toMatchObject({
            type: 'PREPARE_RELEASE_COMPLETE',
            status: 'updated',
            ready: true,
            buildId: `sha256-${'1'.repeat(64)}`,
        })
        const stateStore = harness.cacheStorage.stores.get('atlas-app-shell-state-v1')
        const stateResponse = [...stateStore.values()][0]
        await expect(stateResponse.json()).resolves.toMatchObject({
            version: 2,
            buildId: `sha256-${'1'.repeat(64)}`,
        })
    })

    it('upgrades an existing installation by reusing verified legacy-cache assets', async () => {
        const harness = createHarness()
        const legacyCache = await harness.cacheStorage.api.open('atlas-app-shell-v2')
        await legacyCache.put(new Request('https://atlas.example/'), new Response(harness.shell, { status: 200 }))

        const messages = await harness.message({ type: 'PREPARE_RELEASE' })

        expect(messages.at(-1)).toMatchObject({
            type: 'PREPARE_RELEASE_COMPLETE',
            status: 'updated',
            ready: true,
        })
        expect(harness.fetchMock.mock.calls.filter(([request]) => new URL(request.url).pathname === '/')).toHaveLength(0)
        const stateStore = harness.cacheStorage.stores.get('atlas-app-shell-state-v1')
        const stateResponse = [...stateStore.values()][0]
        await expect(stateResponse.json()).resolves.toMatchObject({
            previousCacheName: 'atlas-app-shell-v3',
            buildId: `sha256-${'1'.repeat(64)}`,
        })
    })

    it('keeps the active release unchanged when a new asset fails verification', async () => {
        const harness = createHarness()
        await harness.message({ type: 'PREPARE_RELEASE' })
        harness.setRelease({
            schemaVersion: 1,
            updateProtocol: 2,
            version: '1.2.0',
            buildId: `sha256-${'2'.repeat(64)}`,
            assets: [{ url: '/', bytes: Buffer.byteLength(harness.shell), sha256: '0'.repeat(64) }],
        })

        const messages = await harness.message({ type: 'PREPARE_RELEASE' })
        expect(messages.at(-1)).toMatchObject({ status: 'failed', ready: false })
        const stateStore = harness.cacheStorage.stores.get('atlas-app-shell-state-v1')
        const stateResponse = [...stateStore.values()][0]
        await expect(stateResponse.json()).resolves.toMatchObject({
            buildId: `sha256-${'1'.repeat(64)}`,
        })
    })

    it('reuses a verified background download and applies it only when requested', async () => {
        const harness = createHarness()

        await harness.message({ type: 'CHECK_FOR_UPDATE' })
        expect(harness.cacheStorage.stores.has('atlas-app-shell-v3-next')).toBe(true)
        expect(harness.cacheStorage.stores.get('atlas-app-shell-state-v1').size).toBe(0)

        const messages = await harness.message({ type: 'APPLY_UPDATE' })
        expect(messages).toEqual([
            expect.objectContaining({
                type: 'APPLY_UPDATE_COMPLETE',
                applied: true,
                buildId: `sha256-${'1'.repeat(64)}`,
            }),
        ])
        expect(harness.cacheStorage.stores.has('atlas-app-shell-state-v1')).toBe(true)
        expect(harness.fetchMock.mock.calls.filter(([request]) => new URL(request.url).pathname === '/')).toHaveLength(1)
    })

    it('keeps the existing offline-readiness message contract after activation', async () => {
        const harness = createHarness()
        await harness.message({ type: 'PREPARE_RELEASE' })

        await expect(harness.message({
            type: 'PREPARE_OFFLINE',
            allowUpdate: false,
        })).resolves.toEqual([
            expect.objectContaining({
                type: 'PREPARE_OFFLINE_COMPLETE',
                status: 'ready',
                ready: true,
            }),
        ])
    })
})
