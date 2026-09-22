/*
 * Atlas keeps one stable service-worker registration at /sw.js. Application
 * releases are downloaded into a separate cache, verified, and made active by
 * changing a small cache-state record only after every required asset exists.
 */
const UPDATE_PROTOCOL_VERSION = 2
const RELEASE_SCHEMA_VERSION = 1
const APP_CACHE = 'atlas-app-shell-v3'
const NEXT_APP_CACHE = 'atlas-app-shell-v3-next'
const LEGACY_APP_CACHES = ['atlas-app-shell-v1', 'atlas-app-shell-v2']
const PREPARED_CACHE_PREFIX = 'atlas-app-shell-prepared-v2-'
const LEGACY_PREPARED_CACHE_PREFIX = 'atlas-app-shell-prepared-v1-'
const CACHE_STATE = 'atlas-app-shell-state-v1'
const CACHE_STATE_URL = '/__atlas_pwa_cache_state__'
const STAGED_METADATA_URL = '/__atlas_pwa_staged_metadata__'
const RELEASE_URL = '/pwa-release.json'
const DEPLOYMENT_CHECK_QUERY_PARAM = '__atlas_deployment_check'
const MAX_CONCURRENT_ASSET_FETCHES = 4
let updatesEnabled = true
let updateToken = 0
let stagingPromise = null
let missingAssetRecoveryPromise = null

const absoluteUrl = (value) => new URL(value, self.location.origin).href
const appShellRequest = () => new Request(absoluteUrl('/'))
const cacheStateRequest = () => new Request(absoluteUrl(CACHE_STATE_URL))
const stagedMetadataRequest = () => new Request(absoluteUrl(STAGED_METADATA_URL))
const releaseRequest = () => new Request(absoluteUrl(RELEASE_URL))

function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' }
    })
}

function isCacheableRequest(request) {
    if (request.mode === 'navigate') return true
    const destination = request.destination
    if (['script', 'style', 'image', 'font', 'worker', 'manifest'].includes(destination)) return true
    return /\.(?:js|mjs|css|png|svg|ico|woff2?|wasm)$/i.test(new URL(request.url).pathname)
}

function isMissingBuildAsset(request) {
    const url = new URL(request.url)
    return request.destination === 'script' && /^\/assets\/[^/]+\.js$/i.test(url.pathname)
}

async function putResponse(cacheName, request, response) {
    if (!response || (!response.ok && response.type !== 'opaque')) return false
    const cache = await caches.open(cacheName)
    await cache.put(request, response.clone())
    return true
}

async function readJsonEntry(cacheName, request) {
    try {
        const cache = await caches.open(cacheName)
        const response = await cache.match(request, { ignoreVary: true })
        return response ? await response.json() : null
    } catch {
        return null
    }
}

async function readCacheState() {
    return readJsonEntry(CACHE_STATE, cacheStateRequest())
}

async function writeCacheState(state) {
    const cache = await caches.open(CACHE_STATE)
    await cache.put(cacheStateRequest(), jsonResponse(state))
}

async function getCacheCandidates({ includeLegacyWorkbox = true } = {}) {
    const state = await readCacheState()
    const names = await caches.keys()
    const legacyWorkbox = includeLegacyWorkbox
        ? names.filter((name) => name.startsWith('workbox-precache-') || name.startsWith('workbox-runtime-'))
        : []
    return [...new Set([
        state?.activeCacheName,
        state?.previousCacheName,
        APP_CACHE,
        ...LEGACY_APP_CACHES,
        ...legacyWorkbox,
    ].filter(Boolean))]
}

async function getCachedResponse(request) {
    const candidates = await getCacheCandidates()
    for (const cacheName of candidates) {
        const cache = await caches.open(cacheName)
        const match = await cache.match(request, {
            ignoreSearch: request.mode === 'navigate',
            ignoreVary: true,
        })
        if (match) return match
    }
    return undefined
}

function createFreshRequest(value, token) {
    const url = new URL(value, self.location.origin)
    url.searchParams.set(DEPLOYMENT_CHECK_QUERY_PARAM, `${Date.now()}-${token}`)
    return new Request(url.href, { cache: 'no-store' })
}

function normalizeRelease(value) {
    if (!value || typeof value !== 'object') return null
    if (value.schemaVersion !== RELEASE_SCHEMA_VERSION) return null
    if (!Number.isInteger(value.updateProtocol) || value.updateProtocol < 1) return null
    if (typeof value.buildId !== 'string' || !/^sha256-[a-f0-9]{64}$/i.test(value.buildId)) return null
    if (!Array.isArray(value.assets) || value.assets.length === 0) return null

    const seen = new Set()
    const assets = []
    for (const entry of value.assets) {
        if (!entry || typeof entry !== 'object') return null
        if (typeof entry.url !== 'string' || !entry.url.startsWith('/')) return null
        let url
        try {
            url = new URL(entry.url, self.location.origin)
        } catch {
            return null
        }
        if (url.origin !== self.location.origin || seen.has(url.href)) return null
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return null
        if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) return null
        seen.add(url.href)
        assets.push({ url: url.href, bytes: entry.bytes, sha256: entry.sha256.toLowerCase() })
    }

    if (!assets.some((asset) => new URL(asset.url).pathname === '/')) return null
    return {
        schemaVersion: value.schemaVersion,
        updateProtocol: value.updateProtocol,
        channel: typeof value.channel === 'string' ? value.channel : 'production',
        version: typeof value.version === 'string' ? value.version : '',
        buildId: value.buildId,
        commit: typeof value.commit === 'string' ? value.commit : '',
        releasedAt: typeof value.releasedAt === 'string' ? value.releasedAt : '',
        assets,
    }
}

async function fetchLatestRelease(token) {
    try {
        const response = await fetch(createFreshRequest(RELEASE_URL, token))
        if (!response.ok) return null
        const release = normalizeRelease(await response.clone().json())
        return release ? { release, response } : null
    } catch {
        return null
    }
}

function bytesToHex(buffer) {
    return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function responseMatchesAsset(response, asset) {
    if (!response || (!response.ok && response.type !== 'opaque') || response.type === 'opaque') return false
    try {
        const body = await response.clone().arrayBuffer()
        if (body.byteLength !== asset.bytes) return false
        const digest = await crypto.subtle.digest('SHA-256', body)
        return bytesToHex(digest) === asset.sha256
    } catch {
        return false
    }
}

async function findReusableAsset(asset) {
    const request = new Request(asset.url)
    for (const cacheName of await getCacheCandidates()) {
        const cache = await caches.open(cacheName)
        const response = await cache.match(request, { ignoreVary: true })
        if (response && await responseMatchesAsset(response, asset)) return response
    }
    return null
}

async function verifyCacheEntries(cacheName, assets) {
    const cache = await caches.open(cacheName)
    const missingUrls = []
    for (const asset of assets) {
        const response = await cache.match(new Request(asset.url), { ignoreVary: true })
        if (!response || (!response.ok && response.type !== 'opaque')) missingUrls.push(asset.url)
    }
    return missingUrls
}

async function cacheReleaseAssets(cacheName, release, token, onProgress) {
    const cache = await caches.open(cacheName)
    const failedUrls = []
    const totalBytes = release.assets.reduce((sum, asset) => sum + asset.bytes, 0)
    let nextIndex = 0
    let completed = 0
    let completedBytes = 0

    async function cacheNext() {
        while (true) {
            const index = nextIndex
            nextIndex += 1
            if (index >= release.assets.length) return
            const asset = release.assets[index]
            try {
                let response = await findReusableAsset(asset)
                if (!response) {
                    response = await fetch(createFreshRequest(asset.url, token))
                    if (!await responseMatchesAsset(response, asset)) {
                        throw new Error(`Release asset verification failed: ${asset.url}`)
                    }
                }
                await cache.put(new Request(asset.url), response.clone())
            } catch {
                failedUrls.push(asset.url)
            }
            completed += 1
            completedBytes += asset.bytes
            onProgress?.({
                completed,
                total: release.assets.length,
                completedBytes,
                totalBytes,
                url: asset.url,
            })
        }
    }

    await Promise.all(Array.from(
        { length: Math.min(MAX_CONCURRENT_ASSET_FETCHES, release.assets.length) },
        () => cacheNext(),
    ))
    return { failedUrls, completed, totalBytes }
}

async function stageLatestDeployment(token, options = {}) {
    const latest = await fetchLatestRelease(token)
    if (!latest) return { status: 'unavailable' }

    const state = await readCacheState()
    if (!options.force && state?.buildId === latest.release.buildId && state?.activeCacheName) {
        const missing = await verifyCacheEntries(state.activeCacheName, latest.release.assets)
        if (missing.length === 0) return { status: 'current', ...state, release: latest.release }
    }

    // A background check may already have downloaded and verified this exact
    // release. Reuse it on the next cold start instead of downloading the
    // bundle again before activation.
    const existingStaged = await readJsonEntry(NEXT_APP_CACHE, stagedMetadataRequest())
    if (!options.force && existingStaged?.buildId === latest.release.buildId) {
        const missing = await verifyCacheEntries(NEXT_APP_CACHE, latest.release.assets)
        if (missing.length === 0) {
            return {
                status: 'staged',
                ...existingStaged,
                release: latest.release,
            }
        }
    }

    await caches.delete(NEXT_APP_CACHE)
    const cache = await caches.open(NEXT_APP_CACHE)
    await cache.put(releaseRequest(), latest.response.clone())
    const cached = await cacheReleaseAssets(NEXT_APP_CACHE, latest.release, token, options.onProgress)
    const missingUrls = await verifyCacheEntries(NEXT_APP_CACHE, latest.release.assets)
    const unavailableUrls = [...new Set([...cached.failedUrls, ...missingUrls])]

    if (unavailableUrls.length > 0 || !updatesEnabled || token !== updateToken) {
        await caches.delete(NEXT_APP_CACHE)
        return { status: 'failed', failedUrls: unavailableUrls }
    }

    const metadata = {
        buildId: latest.release.buildId,
        version: latest.release.version,
        release: latest.release,
        cachedAssets: latest.release.assets.length,
        cachedBytes: cached.totalBytes,
        stagedAt: Date.now(),
    }
    await cache.put(stagedMetadataRequest(), jsonResponse(metadata))
    return { status: 'staged', ...metadata }
}

async function notifyClients(message) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    clients.forEach((client) => client.postMessage(message))
}

async function cleanupPreparedCaches(activeCacheName, previousCacheName) {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames
        .filter((name) => name.startsWith(PREPARED_CACHE_PREFIX) || name.startsWith(LEGACY_PREPARED_CACHE_PREFIX))
        .filter((name) => name !== activeCacheName && name !== previousCacheName)
        .map((name) => caches.delete(name)))
}

async function applyStagedDeployment(notify = true) {
    if (!updatesEnabled) return { applied: false }
    const next = await caches.open(NEXT_APP_CACHE)
    const metadataResponse = await next.match(stagedMetadataRequest(), { ignoreVary: true })
    if (!metadataResponse) return { applied: false }
    const metadata = await metadataResponse.json()
    if (!metadata?.buildId || !Array.isArray(metadata.release?.assets)) return { applied: false }

    const missingBeforeCopy = await verifyCacheEntries(NEXT_APP_CACHE, metadata.release.assets)
    if (missingBeforeCopy.length > 0) return { applied: false }

    const targetCacheName = `${PREPARED_CACHE_PREFIX}${metadata.buildId}`
    await caches.delete(targetCacheName)
    const target = await caches.open(targetCacheName)
    const keys = await next.keys()
    try {
        for (const request of keys) {
            if (request.url === stagedMetadataRequest().url) continue
            const response = await next.match(request, { ignoreVary: true })
            if (!response) throw new Error(`Missing staged response for ${request.url}`)
            await target.put(request, response)
        }
        const missingAfterCopy = await verifyCacheEntries(targetCacheName, metadata.release.assets)
        if (missingAfterCopy.length > 0) throw new Error('Prepared release is incomplete')
    } catch (error) {
        await caches.delete(targetCacheName)
        console.warn('[Atlas PWA] Prepared cache copy failed; the installed release remains active:', error)
        return { applied: false }
    }

    const currentState = await readCacheState()
    const previousCacheName = currentState?.activeCacheName || APP_CACHE
    await writeCacheState({
        version: 2,
        activeCacheName: targetCacheName,
        previousCacheName,
        buildId: metadata.buildId,
        releaseVersion: metadata.version,
        expectedAssets: metadata.release.assets,
        expectedUrls: metadata.release.assets.map((asset) => asset.url),
        cachedAssets: metadata.cachedAssets,
        cachedBytes: metadata.cachedBytes,
        preparedAt: Date.now(),
    })
    await caches.delete(NEXT_APP_CACHE)
    await cleanupPreparedCaches(targetCacheName, previousCacheName)
    if (notify) await notifyClients({
        type: 'UPDATE_APPLIED',
        buildId: metadata.buildId,
        version: metadata.version,
    })
    return {
        applied: true,
        buildId: metadata.buildId,
        version: metadata.version,
        cachedAssets: metadata.cachedAssets,
        cachedBytes: metadata.cachedBytes,
    }
}

async function runStaging(options = {}) {
    if (stagingPromise) return stagingPromise
    const token = ++updateToken
    stagingPromise = stageLatestDeployment(token, options).finally(() => { stagingPromise = null })
    return stagingPromise
}

async function prepareLatestRelease(port, { notify = false } = {}) {
    if (!updatesEnabled) {
        port?.postMessage({ type: 'PREPARE_RELEASE_COMPLETE', status: 'disabled', ready: false })
        return
    }
    try {
        const result = await runStaging({
            onProgress: (progress) => port?.postMessage({ type: 'PREPARE_RELEASE_PROGRESS', ...progress }),
        })
        if (result.status === 'current') {
            port?.postMessage({
                type: 'PREPARE_RELEASE_COMPLETE',
                status: 'current',
                ready: true,
                buildId: result.buildId,
                version: result.releaseVersion || result.release?.version,
                cachedAssets: result.cachedAssets,
            })
            return
        }
        if (result.status !== 'staged') {
            port?.postMessage({
                type: 'PREPARE_RELEASE_COMPLETE',
                status: result.status === 'unavailable' ? 'unavailable' : 'failed',
                ready: false,
                failedUrls: result.failedUrls || [],
            })
            return
        }
        const applied = await applyStagedDeployment(notify)
        port?.postMessage({
            type: 'PREPARE_RELEASE_COMPLETE',
            status: applied.applied ? 'updated' : 'failed',
            ready: applied.applied,
            ...applied,
        })
    } catch (error) {
        console.warn('[Atlas PWA] Release preparation failed:', error)
        port?.postMessage({ type: 'PREPARE_RELEASE_COMPLETE', status: 'failed', ready: false })
    }
}

async function inspectOfflineReadiness() {
    const state = await readCacheState()
    const expectedAssets = Array.isArray(state?.expectedAssets)
        ? state.expectedAssets
        : Array.isArray(state?.expectedUrls)
            ? state.expectedUrls.map((url) => ({ url }))
            : []
    if (state?.activeCacheName && expectedAssets.length > 0) {
        const missingUrls = await verifyCacheEntries(state.activeCacheName, expectedAssets)
        if (missingUrls.length === 0) {
            return {
                ready: true,
                cacheName: state.activeCacheName,
                buildId: state.buildId,
                version: state.releaseVersion,
                cachedAssets: expectedAssets.length,
                cachedBytes: state.cachedBytes,
                preparedAt: state.preparedAt,
            }
        }
    }
    return { ready: false }
}

async function prepareOffline(port, allowUpdate) {
    if (!allowUpdate || !updatesEnabled) {
        const inspection = await inspectOfflineReadiness()
        port?.postMessage({
            type: 'PREPARE_OFFLINE_COMPLETE',
            status: inspection.ready ? 'ready' : 'updates-disabled-incomplete',
            ...inspection,
        })
        return
    }
    const channel = {
        postMessage(message) {
            if (message.type === 'PREPARE_RELEASE_PROGRESS') {
                port?.postMessage({ ...message, type: 'PREPARE_OFFLINE_PROGRESS', phase: 'caching' })
            } else if (message.type === 'PREPARE_RELEASE_COMPLETE') {
                port?.postMessage({
                    ...message,
                    type: 'PREPARE_OFFLINE_COMPLETE',
                    status: message.status === 'current' ? 'ready' : message.status,
                })
            }
        }
    }
    await prepareLatestRelease(channel)
}

async function retainCachedUrls(urls) {
    const cache = await caches.open(APP_CACHE)
    for (const value of urls) {
        try {
            const request = new Request(new URL(value, self.location.origin).href)
            const response = await caches.match(request, { ignoreSearch: request.mode === 'navigate', ignoreVary: true })
            if (response) await cache.put(request, response.clone())
        } catch {
            // Ignore malformed or already-evicted entries.
        }
    }
}

function recoverFromMissingBuildAsset() {
    if (!updatesEnabled) return Promise.resolve()
    if (missingAssetRecoveryPromise) return missingAssetRecoveryPromise
    missingAssetRecoveryPromise = prepareLatestRelease(null, { notify: true })
        .catch((error) => console.warn('[Atlas PWA] Missing build asset recovery failed:', error))
        .finally(() => { missingAssetRecoveryPromise = null })
    return missingAssetRecoveryPromise
}

self.addEventListener('install', () => {
    self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin || !isCacheableRequest(request)) return

    const responsePromise = (async () => {
        const cached = await getCachedResponse(request)
        if (cached) return cached
        try {
            const response = await fetch(request)
            await putResponse(APP_CACHE, request, response)
            return response
        } catch (error) {
            if (request.mode === 'navigate') {
                const shell = await getCachedResponse(appShellRequest())
                if (shell) return shell
            }
            throw error
        }
    })()

    if (isMissingBuildAsset(request)) {
        event.waitUntil(responsePromise.then((response) => (
            response.status === 404 ? recoverFromMissingBuildAsset() : undefined
        )).catch(() => undefined))
    }
    event.respondWith(responsePromise)
})

self.addEventListener('message', (event) => {
    const message = event.data || {}
    const port = event.ports?.[0]

    if (message.type === 'GET_UPDATE_CAPABILITIES') {
        port?.postMessage({
            type: 'UPDATE_CAPABILITIES',
            protocolVersion: UPDATE_PROTOCOL_VERSION,
            releaseSchemaVersion: RELEASE_SCHEMA_VERSION,
        })
        return
    }

    if (message.type === 'SET_UPDATE_POLICY') {
        updatesEnabled = !message.disabled
        if (!updatesEnabled) {
            updateToken += 1
            event.waitUntil(caches.delete(NEXT_APP_CACHE))
        }
        return
    }

    if (message.type === 'CACHE_CURRENT_VERSION' && Array.isArray(message.urls)) {
        event.waitUntil(retainCachedUrls(message.urls))
        return
    }

    if (message.type === 'GET_ACTIVE_RELEASE') {
        event.waitUntil(readCacheState().then((state) => {
            port?.postMessage({ type: 'ACTIVE_RELEASE', ...state })
        }))
        return
    }

    if (message.type === 'PREPARE_RELEASE') {
        event.waitUntil(prepareLatestRelease(port))
        return
    }

    if (message.type === 'CHECK_FOR_UPDATE') {
        if (!updatesEnabled) return
        event.waitUntil(runStaging().then(async (staged) => {
            if (staged.status === 'staged') {
                await notifyClients({
                    type: 'UPDATE_READY',
                    buildId: staged.buildId,
                    version: staged.version,
                })
            }
        }))
        return
    }

    if (message.type === 'REFRESH_TO_LATEST') {
        const legacyPort = {
            postMessage(result) {
                if (result.type !== 'PREPARE_RELEASE_COMPLETE') return
                port?.postMessage({
                    type: 'REFRESH_COMPLETE',
                    status: result.status === 'updated' || result.status === 'current' ? result.status : 'failed',
                })
            }
        }
        event.waitUntil(prepareLatestRelease(legacyPort))
        return
    }

    if (message.type === 'PREPARE_OFFLINE') {
        event.waitUntil(prepareOffline(port, message.allowUpdate !== false))
        return
    }

    if (message.type === 'GET_OFFLINE_STATUS') {
        event.waitUntil(inspectOfflineReadiness().then((status) => {
            port?.postMessage({ type: 'OFFLINE_STATUS', ...status })
        }))
        return
    }

    if (message.type === 'APPLY_UPDATE') {
        event.waitUntil(applyStagedDeployment().then((result) => {
            port?.postMessage({ type: 'APPLY_UPDATE_COMPLETE', ...result })
        }))
    }
})
