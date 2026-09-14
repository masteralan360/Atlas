/*
 * This worker is deliberately deployment-stable. Existing Atlas installations
 * keep their working cache while a complete replacement is downloaded and
 * verified in a separate cache.
 */
const APP_CACHE = 'atlas-app-shell-v2'
const NEXT_APP_CACHE = 'atlas-app-shell-v2-next'
const LEGACY_APP_CACHES = ['atlas-app-shell-v1']
const PREPARED_CACHE_PREFIX = 'atlas-app-shell-prepared-v1-'
const CACHE_STATE = 'atlas-app-shell-state-v1'
const CACHE_STATE_URL = '/__atlas_pwa_cache_state__'
const STAGED_METADATA_URL = '/__atlas_pwa_staged_metadata__'
const ASSET_MANIFEST_URL = '/atlas-assets.json'
const DEPLOYMENT_CHECK_QUERY_PARAM = '__atlas_deployment_check'
const WORKSPACE_ASSET_ROUTE = '/__atlas_workspace_asset__'
const WORKSPACE_ASSET_ROOT = 'atlas-backup-assets'
const WORKSPACE_ASSET_SCOPE_CACHE = 'atlas-workspace-asset-scopes-v1'
const WORKSPACE_ASSET_SCOPE_ROUTE = '/__atlas_workspace_asset_scope__'
const RUNTIME_APP_ASSETS = [
    '/manifest.webmanifest',
    '/pwa-icon.png',
    '/logo.png'
]
let updatesEnabled = true
let updateToken = 0
let missingAssetRecoveryPromise = null

const absoluteUrl = (path) => new URL(path, self.location.origin).href
const appShellRequest = () => new Request(absoluteUrl('/'))
const cacheStateRequest = () => new Request(absoluteUrl(CACHE_STATE_URL))
const stagedMetadataRequest = () => new Request(absoluteUrl(STAGED_METADATA_URL))
const workspaceAssetScopeRequest = (clientId) => {
    const url = new URL(WORKSPACE_ASSET_SCOPE_ROUTE, self.location.origin)
    url.searchParams.set('client', clientId)
    return new Request(url.href)
}

function jsonResponse(value) {
    return new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' }
    })
}

function isCacheableRequest(request) {
    if (request.mode === 'navigate') return true

    const destination = request.destination
    if (['script', 'style', 'image', 'font', 'worker', 'manifest'].includes(destination)) {
        return true
    }

    return /\.(?:js|mjs|css|png|svg|ico|woff2?|wasm)$/i.test(new URL(request.url).pathname)
}

function isMissingBuildAsset(request) {
    const url = new URL(request.url)
    return request.destination === 'script'
        && /^\/assets\/[^/]+\.js$/i.test(url.pathname)
}

function isSafeWorkspaceAssetPath(path, workspaceId) {
    if (!path || !workspaceId || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false
    const segments = path.replace(/\\/g, '/').split('/')
    return segments.length >= 3
        && segments[1] === workspaceId
        && !segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))
}

function workspaceAssetContentType(path) {
    const extension = path.split('.').pop()?.toLowerCase()
    return ({
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
    })[extension] || null
}

function workspaceAssetResponse(body, contentType, status = 200) {
    return new Response(body, {
        status,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
        },
    })
}

function expectedRemoteAssetPath(path, workspaceId) {
    const segments = path.replace(/\\/g, '/').split('/')
    const keySegments = [workspaceId, segments[0], ...segments.slice(2)]
    return `/${keySegments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join('/')}`
}

async function writeWorkspaceAssetScope(clientId, scope) {
    if (!clientId) return
    const cache = await caches.open(WORKSPACE_ASSET_SCOPE_CACHE)
    const request = workspaceAssetScopeRequest(clientId)
    if (!scope) {
        await cache.delete(request)
        return
    }
    await cache.put(request, jsonResponse(scope))
}

async function readWorkspaceAssetScope(clientId) {
    if (!clientId) return null
    try {
        const cache = await caches.open(WORKSPACE_ASSET_SCOPE_CACHE)
        const response = await cache.match(workspaceAssetScopeRequest(clientId))
        const scope = response ? await response.json() : null
        return scope
            && typeof scope.workspaceId === 'string'
            && typeof scope.userId === 'string'
            && scope.workspaceId
            && scope.userId
            ? scope
            : null
    } catch {
        return null
    }
}

async function readWorkspaceAssetFromOpfs(path, workspaceId, userId, contentType) {
    if (!isSafeWorkspaceAssetPath(path, workspaceId) || !userId) return null
    if (!self.navigator?.storage || typeof self.navigator.storage.getDirectory !== 'function') return null

    try {
        let directory = await self.navigator.storage.getDirectory()
        for (const segment of [WORKSPACE_ASSET_ROOT, encodeURIComponent(workspaceId), encodeURIComponent(userId)]) {
            directory = await directory.getDirectoryHandle(segment)
        }
        const manifestHandle = await directory.getFileHandle('manifest.json')
        const manifest = JSON.parse(await (await manifestHandle.getFile()).text())
        const metadata = manifest?.[path]
        if (!metadata || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
            return null
        }
        const content = await (await directory.getFileHandle(metadata.sha256)).getFile()
        return workspaceAssetResponse(content, contentType)
    } catch {
        return null
    }
}

async function serveWorkspaceAsset(request, clientId) {
    const url = new URL(request.url)
    const path = url.searchParams.get('path') || ''
    const workspaceId = url.searchParams.get('workspace') || ''
    const userId = url.searchParams.get('user') || ''
    const boundScope = await readWorkspaceAssetScope(clientId)
    const contentType = workspaceAssetContentType(path)
    if (
        !boundScope
        || boundScope.workspaceId !== workspaceId
        || boundScope.userId !== userId
        || !isSafeWorkspaceAssetPath(path, workspaceId)
        || !contentType
    ) {
        return new Response('', { status: 404 })
    }
    if (request.mode === 'navigate') {
        return new Response('', { status: 404 })
    }

    const local = await readWorkspaceAssetFromOpfs(path, workspaceId, userId, contentType)
    if (local) return local

    const remote = url.searchParams.get('remote')
    if (remote) {
        try {
            const remoteUrl = new URL(remote)
            const expectedPath = expectedRemoteAssetPath(path, workspaceId)
            if (
                remoteUrl.protocol === 'https:'
                && !remoteUrl.username
                && !remoteUrl.password
                && remoteUrl.pathname.endsWith(expectedPath)
            ) {
                // Keep the fallback cross-origin. Relaying arbitrary remote
                // bytes through this same-origin route would turn the worker
                // into an origin-confused response proxy.
                return Response.redirect(remoteUrl.href, 302)
            }
        } catch {
            // Return a deterministic missing response below.
        }
    }
    return new Response('', { status: 404 })
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
        const response = await cache.match(request)
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

async function cacheUrls(cacheName, urls, reload, onProgress) {
    const sameOriginUrls = [...new Set(urls.map((value) => {
        try {
            const url = new URL(value, self.location.origin)
            return url.origin === self.location.origin ? url.href : null
        } catch {
            return null
        }
    }).filter(Boolean))]
    const failedUrls = []

    for (let index = 0; index < sameOriginUrls.length; index += 1) {
        const value = sameOriginUrls[index]
        try {
            const request = new Request(value, { cache: reload ? 'reload' : 'default' })
            const response = await fetch(request)
            if (!response.ok && response.type !== 'opaque') {
                failedUrls.push(value)
            } else {
                await putResponse(cacheName, request, response)
            }
        } catch {
            failedUrls.push(value)
        }
        onProgress?.(index + 1, sameOriginUrls.length)
    }

    return { failedUrls, attempted: sameOriginUrls.length }
}

async function retainCachedUrls(urls) {
    const cache = await caches.open(APP_CACHE)
    for (const value of urls) {
        try {
            const request = new Request(new URL(value, self.location.origin).href)
            const response = await caches.match(request, {
                ignoreSearch: request.mode === 'navigate',
                ignoreVary: true,
            })
            if (response) await cache.put(request, response.clone())
        } catch {
            // Ignore malformed or already-evicted entries.
        }
    }
}

async function getCacheCandidates() {
    const state = await readCacheState()
    return [...new Set([
        state?.activeCacheName,
        state?.previousCacheName,
        APP_CACHE,
        ...LEGACY_APP_CACHES,
    ].filter(Boolean))]
}

async function getCachedResponse(request) {
    const candidates = await getCacheCandidates()
    for (const cacheName of candidates) {
        const cache = await caches.open(cacheName)
        const match = await cache.match(request, {
            ignoreSearch: request.mode === 'navigate',
            // Prepared responses may carry `Vary: Origin` from the hosting
            // layer. Module requests include an Origin header while the
            // preparation fetch does not, so strict Vary matching can miss an
            // otherwise exact same-origin cached asset during a cold start.
            ignoreVary: true,
        })
        if (match) return match
    }
    return undefined
}

function extractInitialAssetUrls(html) {
    const urls = []
    const pattern = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/gi
    let match
    while ((match = pattern.exec(html)) !== null) {
        try {
            const url = new URL(match[1], self.location.origin)
            if (url.origin === self.location.origin) urls.push(url.href)
        } catch {
            // Ignore malformed markup; the page can still fetch the resource.
        }
    }
    return urls
}

function getManifestAssetUrls(manifest) {
    const urls = new Set()
    for (const entry of Object.values(manifest || {})) {
        if (!entry || typeof entry !== 'object') continue
        for (const value of [entry.file, ...(entry.css || []), ...(entry.assets || [])]) {
            if (typeof value === 'string' && value) {
                urls.add(absoluteUrl(value))
            }
        }
    }
    return [...urls]
}

function hashDeployment(value) {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
}

function createFreshDeploymentRequest(path, token) {
    const url = new URL(path, self.location.origin)
    url.searchParams.set(DEPLOYMENT_CHECK_QUERY_PARAM, `${Date.now()}-${token}`)
    return new Request(url.href, { cache: 'no-store' })
}

async function getDeploymentAssets(token) {
    try {
        const manifestRequest = createFreshDeploymentRequest(ASSET_MANIFEST_URL, token)
        const response = await fetch(manifestRequest)
        if (!response.ok) return null
        const manifestResponse = response.clone()
        const manifest = await response.json()
        if (!manifest || typeof manifest !== 'object') return null
        return {
            manifest,
            manifestResponse,
            urls: getManifestAssetUrls(manifest)
        }
    } catch {
        return null
    }
}

async function verifyCacheEntries(cacheName, expectedUrls) {
    const cache = await caches.open(cacheName)
    const missingUrls = []
    for (const value of expectedUrls) {
        const response = await cache.match(new Request(value), { ignoreVary: true })
        if (!response || (!response.ok && response.type !== 'opaque')) {
            missingUrls.push(value)
        }
    }
    return missingUrls
}

async function stageLatestDeployment(token, options = {}) {
    const shellRequest = appShellRequest()
    const current = await getCachedResponse(shellRequest)
    const latestResponse = await fetch(createFreshDeploymentRequest('/', token))
    if (!latestResponse.ok) return { status: 'failed' }

    const latestHtml = await latestResponse.clone().text()
    const currentHtml = current ? await current.clone().text() : ''
    const wasCurrent = latestHtml === currentHtml
    if (wasCurrent && !options.force) return { status: 'current' }

    const deploymentAssets = await getDeploymentAssets(token)
    if (!deploymentAssets) return { status: 'failed' }

    const buildId = hashDeployment(`${latestHtml}\n${JSON.stringify(deploymentAssets.manifest)}`)
    const expectedUrls = [...new Set([
        shellRequest.url,
        absoluteUrl(ASSET_MANIFEST_URL),
        ...deploymentAssets.urls,
        ...extractInitialAssetUrls(latestHtml),
        ...RUNTIME_APP_ASSETS.map(absoluteUrl),
    ])]

    await caches.delete(NEXT_APP_CACHE)
    await putResponse(NEXT_APP_CACHE, shellRequest, latestResponse)
    await putResponse(
        NEXT_APP_CACHE,
        new Request(absoluteUrl(ASSET_MANIFEST_URL)),
        deploymentAssets.manifestResponse,
    )

    const urlsToFetch = expectedUrls.filter((url) => (
        url !== shellRequest.url && url !== absoluteUrl(ASSET_MANIFEST_URL)
    ))
    const { failedUrls, attempted } = await cacheUrls(
        NEXT_APP_CACHE,
        urlsToFetch,
        true,
        options.onProgress,
    )
    const missingUrls = await verifyCacheEntries(NEXT_APP_CACHE, expectedUrls)
    const unavailableUrls = [...new Set([...failedUrls, ...missingUrls])]

    if (unavailableUrls.length > 0) {
        console.warn('[Atlas PWA] Deployment was not staged because assets are unavailable:', unavailableUrls)
        await caches.delete(NEXT_APP_CACHE)
        return { status: 'failed', failedUrls: unavailableUrls }
    }

    if (!updatesEnabled || token !== updateToken) {
        await caches.delete(NEXT_APP_CACHE)
        return { status: 'failed' }
    }

    const metadata = {
        buildId,
        expectedUrls,
        cachedAssets: expectedUrls.length,
        wasCurrent,
        stagedAt: Date.now(),
    }
    await putResponse(NEXT_APP_CACHE, stagedMetadataRequest(), jsonResponse(metadata))
    return { status: 'staged', ...metadata, attempted }
}

async function notifyClients(message) {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    clients.forEach((client) => client.postMessage(message))
}

async function cleanupPreparedCaches(activeCacheName, previousCacheName) {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames
        .filter((name) => name.startsWith(PREPARED_CACHE_PREFIX))
        .filter((name) => name !== activeCacheName && name !== previousCacheName)
        .map((name) => caches.delete(name)))
}

async function applyStagedDeployment(notify = true) {
    if (!updatesEnabled) return { applied: false }

    const next = await caches.open(NEXT_APP_CACHE)
    const metadataResponse = await next.match(stagedMetadataRequest())
    if (!metadataResponse) return { applied: false }
    const metadata = await metadataResponse.json()
    if (!metadata?.buildId || !Array.isArray(metadata.expectedUrls)) return { applied: false }

    const missingBeforeCopy = await verifyCacheEntries(NEXT_APP_CACHE, metadata.expectedUrls)
    if (missingBeforeCopy.length > 0) return { applied: false }

    const targetCacheName = `${PREPARED_CACHE_PREFIX}${metadata.buildId}-${Date.now().toString(36)}`
    const target = await caches.open(targetCacheName)
    const keys = await next.keys()
    try {
        for (const request of keys) {
            if (request.url === stagedMetadataRequest().url) continue
            const response = await next.match(request)
            if (!response) throw new Error(`Missing staged response for ${request.url}`)
            await target.put(request, response)
        }

        const missingAfterCopy = await verifyCacheEntries(targetCacheName, metadata.expectedUrls)
        if (missingAfterCopy.length > 0) {
            throw new Error(`Prepared cache verification failed for ${missingAfterCopy.length} asset(s)`)
        }
    } catch (error) {
        await caches.delete(targetCacheName)
        console.warn('[Atlas PWA] Prepared cache copy failed; the existing cache remains active:', error)
        return { applied: false }
    }

    const currentState = await readCacheState()
    const previousCacheName = currentState?.activeCacheName || APP_CACHE
    await writeCacheState({
        version: 1,
        activeCacheName: targetCacheName,
        previousCacheName,
        buildId: metadata.buildId,
        expectedUrls: metadata.expectedUrls,
        cachedAssets: metadata.cachedAssets,
        preparedAt: Date.now(),
    })
    await caches.delete(NEXT_APP_CACHE)
    await cleanupPreparedCaches(targetCacheName, previousCacheName)

    if (notify) await notifyClients({ type: 'UPDATE_APPLIED' })
    return {
        applied: true,
        buildId: metadata.buildId,
        cachedAssets: metadata.cachedAssets,
        updated: metadata.wasCurrent !== true,
    }
}

async function expectedUrlsFromExistingCache(cacheName) {
    try {
        const cache = await caches.open(cacheName)
        const shellResponse = await cache.match(appShellRequest(), {
            ignoreSearch: true,
            ignoreVary: true,
        })
        if (!shellResponse) return null
        const html = await shellResponse.clone().text()
        const keys = await cache.keys()
        const manifestRequest = keys.find((request) => new URL(request.url).pathname === ASSET_MANIFEST_URL)
        if (!manifestRequest) return null
        const manifestResponse = await cache.match(manifestRequest)
        if (!manifestResponse) return null
        const manifest = await manifestResponse.json()
        const expectedUrls = [...new Set([
            appShellRequest().url,
            ...getManifestAssetUrls(manifest),
            ...extractInitialAssetUrls(html),
            ...RUNTIME_APP_ASSETS.map(absoluteUrl),
        ])]
        return {
            expectedUrls,
            buildId: hashDeployment(`${html}\n${JSON.stringify(manifest)}`),
        }
    } catch {
        return null
    }
}

async function inspectOfflineReadiness() {
    const state = await readCacheState()
    if (state?.activeCacheName && Array.isArray(state.expectedUrls)) {
        const missingUrls = await verifyCacheEntries(state.activeCacheName, state.expectedUrls)
        if (missingUrls.length === 0) {
            return {
                ready: true,
                cacheName: state.activeCacheName,
                buildId: state.buildId,
                cachedAssets: state.expectedUrls.length,
                preparedAt: state.preparedAt,
            }
        }
    }

    for (const cacheName of [...new Set([
        state?.previousCacheName,
        APP_CACHE,
        ...LEGACY_APP_CACHES,
    ].filter(Boolean))]) {
        const existing = await expectedUrlsFromExistingCache(cacheName)
        if (!existing) continue
        const missingUrls = await verifyCacheEntries(cacheName, existing.expectedUrls)
        if (missingUrls.length === 0) {
            return {
                ready: true,
                cacheName,
                buildId: existing.buildId,
                cachedAssets: existing.expectedUrls.length,
            }
        }
    }

    return { ready: false }
}

async function refreshToLatestDeployment(port) {
    const token = ++updateToken
    let status = 'failed'
    try {
        const staged = await stageLatestDeployment(token)
        if (staged.status === 'staged') {
            const applied = await applyStagedDeployment(false)
            status = applied.applied ? 'updated' : 'failed'
        } else if (staged.status === 'current') {
            status = 'current'
        }
    } catch (error) {
        console.warn('[Atlas PWA] Manual refresh could not complete:', error)
    }
    port?.postMessage({ type: 'REFRESH_COMPLETE', status })
}

async function prepareOffline(port, allowUpdate) {
    try {
        if (!allowUpdate || !updatesEnabled) {
            const inspection = await inspectOfflineReadiness()
            port?.postMessage({
                type: 'PREPARE_OFFLINE_COMPLETE',
                status: inspection.ready ? 'ready' : 'updates-disabled-incomplete',
                ...inspection,
            })
            return
        }

        const token = ++updateToken
        const staged = await stageLatestDeployment(token, {
            force: true,
            onProgress: (completed, total) => port?.postMessage({
                type: 'PREPARE_OFFLINE_PROGRESS',
                phase: 'caching',
                completed,
                total,
            }),
        })
        if (staged.status !== 'staged') {
            port?.postMessage({
                type: 'PREPARE_OFFLINE_COMPLETE',
                status: 'failed',
                failedUrls: staged.failedUrls || [],
            })
            return
        }

        const applied = await applyStagedDeployment(false)
        if (!applied.applied) {
            port?.postMessage({ type: 'PREPARE_OFFLINE_COMPLETE', status: 'failed' })
            return
        }
        port?.postMessage({
            type: 'PREPARE_OFFLINE_COMPLETE',
            status: applied.updated ? 'updated' : 'ready',
            ready: true,
            buildId: applied.buildId,
            cachedAssets: applied.cachedAssets,
        })
    } catch (error) {
        console.warn('[Atlas PWA] Offline preparation failed:', error)
        port?.postMessage({ type: 'PREPARE_OFFLINE_COMPLETE', status: 'failed' })
    }
}

function recoverFromMissingBuildAsset() {
    if (!updatesEnabled) return Promise.resolve()
    if (missingAssetRecoveryPromise) return missingAssetRecoveryPromise

    const token = ++updateToken
    missingAssetRecoveryPromise = (async () => {
        try {
            const staged = await stageLatestDeployment(token)
            if (staged.status === 'staged') await applyStagedDeployment()
        } catch (error) {
            console.warn('[Atlas PWA] Missing build asset recovery failed:', error)
        } finally {
            missingAssetRecoveryPromise = null
        }
    })()
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
    const requestUrl = new URL(request.url)
    if (request.method === 'GET' && requestUrl.origin === self.location.origin && requestUrl.pathname === WORKSPACE_ASSET_ROUTE) {
        event.respondWith(serveWorkspaceAsset(request, event.clientId))
        return
    }
    if (request.method !== 'GET' || requestUrl.origin !== self.location.origin || !isCacheableRequest(request)) {
        return
    }

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

    if (message.type === 'SET_WORKSPACE_ASSET_SCOPE' || message.type === 'CLEAR_WORKSPACE_ASSET_SCOPE') {
        const clientId = event.source?.id || ''
        const scope = message.type === 'SET_WORKSPACE_ASSET_SCOPE'
            && typeof message.workspaceId === 'string'
            && typeof message.userId === 'string'
            && message.workspaceId
            && message.userId
            ? { workspaceId: message.workspaceId, userId: message.userId }
            : null
        event.waitUntil(writeWorkspaceAssetScope(clientId, scope).then(() => {
            event.ports?.[0]?.postMessage({ type: 'WORKSPACE_ASSET_SCOPE_UPDATED' })
        }))
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

    if (message.type === 'CHECK_FOR_UPDATE') {
        if (!updatesEnabled) return
        const token = ++updateToken
        event.waitUntil((async () => {
            const staged = await stageLatestDeployment(token)
            if (staged.status === 'staged') await notifyClients({ type: 'UPDATE_READY' })
        })())
        return
    }

    if (message.type === 'REFRESH_TO_LATEST') {
        if (!updatesEnabled) return
        event.waitUntil(refreshToLatestDeployment(event.ports?.[0]))
        return
    }

    if (message.type === 'PREPARE_OFFLINE') {
        event.waitUntil(prepareOffline(event.ports?.[0], message.allowUpdate !== false))
        return
    }

    if (message.type === 'GET_OFFLINE_STATUS') {
        event.waitUntil(inspectOfflineReadiness().then((status) => {
            event.ports?.[0]?.postMessage({ type: 'OFFLINE_STATUS', ...status })
        }))
        return
    }

    if (message.type === 'APPLY_UPDATE') {
        event.waitUntil(applyStagedDeployment())
    }
})
