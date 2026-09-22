import {
    areApplicationUpdatesDisabled,
    UPDATE_PREFERENCE_CHANGED_EVENT
} from './updatePreference'

type PwaWorkerMessage =
    | { type: 'CACHE_CURRENT_VERSION'; urls: string[] }
    | { type: 'SET_UPDATE_POLICY'; disabled: boolean }
    | { type: 'GET_UPDATE_CAPABILITIES' }
    | { type: 'GET_ACTIVE_RELEASE' }
    | { type: 'PREPARE_RELEASE' }
    | { type: 'CHECK_FOR_UPDATE' }
    | { type: 'REFRESH_TO_LATEST' }
    | { type: 'PREPARE_OFFLINE'; allowUpdate: boolean }
    | { type: 'GET_OFFLINE_STATUS' }
    | { type: 'APPLY_UPDATE' }

type PwaRefreshResult = 'updated' | 'current' | 'failed' | 'unavailable'

export type PwaStartupUpdateStatus =
    | 'current'
    | 'updated'
    | 'disabled'
    | 'unavailable'
    | 'failed'

export interface PwaStartupUpdateProgress {
    phase: 'checking' | 'downloading' | 'verifying' | 'applying'
    completed?: number
    total?: number
    completedBytes?: number
    totalBytes?: number
}

export interface PwaStartupUpdateResult {
    status: PwaStartupUpdateStatus
    buildId?: string
    version?: string
    cachedAssets?: number
}

export interface PendingPwaUpdate {
    buildId?: string
    version?: string
}

export type PwaOfflinePreparationStatus =
    | 'ready'
    | 'updated'
    | 'failed'
    | 'updates-disabled-incomplete'
    | 'unavailable'

export interface PwaOfflineShellStatus {
    ready: boolean
    buildId?: string
    cachedAssets?: number
    preparedAt?: number
    status?: PwaOfflinePreparationStatus
}

export interface PwaOfflinePreparationProgress {
    phase: 'caching'
    completed: number
    total: number
}

let messagingInitialized = false
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null
let lastBackgroundCheckAt = Date.now()

export const PWA_UPDATE_READY_EVENT = 'atlas-pwa-update-ready'
const PENDING_PWA_UPDATE_STORAGE_KEY = 'atlas.pwa.pending-update'
const BACKGROUND_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000
const BACKGROUND_UPDATE_CHECK_THROTTLE_MS = 60 * 1000

function clearPendingPwaUpdate(): void {
    try {
        window.localStorage.removeItem(PENDING_PWA_UPDATE_STORAGE_KEY)
    } catch {
        // Storage may be unavailable in restricted browser contexts.
    }
}

function rememberPendingPwaUpdate(update: PendingPwaUpdate): void {
    try {
        window.localStorage.setItem(PENDING_PWA_UPDATE_STORAGE_KEY, JSON.stringify(update))
    } catch {
        // The live event still reaches the mounted application.
    }
}

export function getPendingPwaUpdate(): PendingPwaUpdate | null {
    if (typeof window === 'undefined') return null
    try {
        const raw = window.localStorage.getItem(PENDING_PWA_UPDATE_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as PendingPwaUpdate
        return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
        return null
    }
}

function canUseServiceWorkers() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

async function getActiveWorker(): Promise<ServiceWorker | null> {
    if (!canUseServiceWorkers()) return null

    try {
        const registration = await navigator.serviceWorker.ready
        // Use the registration's active worker rather than the current page's
        // controller. During a worker upgrade, controller can briefly still
        // point at the old worker even though a newer one is already active.
        return registration.active ?? navigator.serviceWorker.controller
    } catch (error) {
        console.warn('Unable to reach the Atlas service worker:', error)
        return null
    }
}

function waitForWorkerActivation(
    registration: ServiceWorkerRegistration,
    timeoutMs = 10_000,
): Promise<ServiceWorker | null> {
    const candidate = registration.installing ?? registration.waiting
    if (!candidate || candidate.state === 'activated') {
        return Promise.resolve(registration.active ?? candidate ?? null)
    }

    return new Promise((resolve) => {
        let settled = false
        const finish = () => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            candidate.removeEventListener('statechange', handleStateChange)
            resolve(registration.active ?? (candidate.state === 'activated' ? candidate : null))
        }
        const handleStateChange = () => {
            if (candidate.state === 'activated' || candidate.state === 'redundant') finish()
        }
        const timeout = window.setTimeout(finish, timeoutMs)
        candidate.addEventListener('statechange', handleStateChange)
        handleStateChange()
    })
}

export function registerPwaServiceWorker(): Promise<ServiceWorkerRegistration> {
    if (!canUseServiceWorkers()) return Promise.reject(new Error('Service workers are unavailable'))
    if (registrationPromise) return registrationPromise

    initializePwaUpdateControl()
    registrationPromise = navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none'
    }).then(async (registration) => {
        try {
            await registration.update()
            await waitForWorkerActivation(registration)
        } catch (error) {
            console.warn('Failed to re-check the Atlas service worker:', error)
        }
        await navigator.serviceWorker.ready
        return registration
    }).catch((error) => {
        registrationPromise = null
        throw error
    })
    return registrationPromise
}

async function updateStableWorker(): Promise<void> {
    if (!canUseServiceWorkers()) return
    try {
        const registration = await navigator.serviceWorker.ready
        await registration.update()
    } catch (error) {
        console.warn('Unable to update the Atlas service worker:', error)
    }
}

async function getUpdateProtocol(worker: ServiceWorker): Promise<number> {
    if (typeof MessageChannel === 'undefined') return 0
    return new Promise((resolve) => {
        const channel = new MessageChannel()
        let settled = false
        const finish = (value: number) => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            channel.port1.close()
            resolve(value)
        }
        const timeout = window.setTimeout(() => finish(0), 2_500)
        channel.port1.onmessage = (event: MessageEvent<{ type?: string; protocolVersion?: number }>) => {
            if (event.data?.type !== 'UPDATE_CAPABILITIES') return
            finish(Number.isInteger(event.data.protocolVersion) ? event.data.protocolVersion! : 0)
        }
        try {
            worker.postMessage({ type: 'GET_UPDATE_CAPABILITIES' } satisfies PwaWorkerMessage, [channel.port2])
        } catch {
            finish(0)
        }
    })
}

function postToWorker(message: PwaWorkerMessage): void {
    void getActiveWorker()
        .then((worker) => worker?.postMessage(message))
        .catch((error) => console.warn('Unable to reach the Atlas service worker:', error))
}

function getCurrentAppUrls(): string[] {
    if (typeof window === 'undefined') return []

    const urls = new Set<string>([window.location.href])
    for (const entry of performance.getEntriesByType('resource')) {
        try {
            const url = new URL(entry.name, window.location.href)
            if (url.origin === window.location.origin) {
                urls.add(url.href)
            }
        } catch {
            // Ignore non-URL performance entries.
        }
    }

    return [...urls]
}

/** Cache the exact app shell that is already running; this never checks a deployment. */
export function cacheCurrentPwaVersion(): void {
    if (areApplicationUpdatesDisabled()) return
    postToWorker({ type: 'CACHE_CURRENT_VERSION', urls: getCurrentAppUrls() })
}

export function setPwaUpdatePolicy(disabled: boolean): void {
    postToWorker({ type: 'SET_UPDATE_POLICY', disabled })
}

/**
 * The only path that asks a PWA worker to fetch a newer deployment.
 * Keeping this guard here prevents accidental update checks from other UI
 * controls while the Local Mode preference is disabled.
 */
export function requestPwaDeploymentUpdate(): void {
    if (areApplicationUpdatesDisabled()) return
    postToWorker({ type: 'CHECK_FOR_UPDATE' })
}

/**
 * Stages and applies the latest deployment through the active worker. Unlike
 * a background update check, this resolves only once the worker has finished
 * its work, so a user-initiated refresh can safely reload afterwards.
 */
export async function refreshPwaDeployment(): Promise<PwaRefreshResult> {
    if (areApplicationUpdatesDisabled() || !canUseServiceWorkers()) {
        return 'unavailable'
    }

    let registration: ServiceWorkerRegistration
    try {
        registration = await navigator.serviceWorker.ready
        // This also picks up a repaired stable worker for an older installed
        // PWA before asking it to stage the current app deployment.
        await registration.update()
    } catch (error) {
        console.warn('Unable to update the Atlas service worker:', error)
    }

    const worker = await getActiveWorker()
    if (!worker || typeof MessageChannel === 'undefined') {
        return 'unavailable'
    }

    return new Promise((resolve) => {
        const channel = new MessageChannel()
        let settled = false
        const settle = (result: PwaRefreshResult) => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            channel.port1.close()
            resolve(result)
        }
        const timeout = window.setTimeout(() => settle('failed'), 30_000)

        channel.port1.onmessage = (event: MessageEvent<{ type?: string; status?: PwaRefreshResult }>) => {
            if (event.data?.type !== 'REFRESH_COMPLETE') return
            settle(event.data.status === 'updated' || event.data.status === 'current'
                ? event.data.status
                : 'failed')
        }

        try {
            worker.postMessage({ type: 'REFRESH_TO_LATEST' } satisfies PwaWorkerMessage, [channel.port2])
        } catch (error) {
            console.warn('Unable to request an Atlas deployment refresh:', error)
            settle('unavailable')
        }
    })
}

/**
 * Blocks an installed PWA's interactive boot until the active release is
 * confirmed or a complete newer release has been atomically activated. An
 * unavailable network never destroys or replaces the installed release.
 */
export async function preparePwaReleaseForStartup(
    onProgress?: (progress: PwaStartupUpdateProgress) => void,
): Promise<PwaStartupUpdateResult> {
    if (areApplicationUpdatesDisabled()) return { status: 'disabled' }
    if (!canUseServiceWorkers() || typeof MessageChannel === 'undefined') {
        return { status: 'unavailable' }
    }

    onProgress?.({ phase: 'checking' })
    try {
        await registerPwaServiceWorker()
    } catch (error) {
        console.warn('Unable to initialize the Atlas PWA updater:', error)
        return { status: 'unavailable' }
    }

    setPwaUpdatePolicy(false)
    cacheCurrentPwaVersion()
    const worker = await getActiveWorker()
    if (!worker) return { status: 'unavailable' }

    const protocolVersion = await getUpdateProtocol(worker)
    if (protocolVersion < 2) {
        // A deployment-stable worker released before the startup protocol can
        // still stage the current deployment through its compatibility path.
        const legacyResult = await refreshPwaDeployment()
        if (legacyResult === 'current' || legacyResult === 'updated') clearPendingPwaUpdate()
        return { status: legacyResult }
    }

    return new Promise((resolve) => {
        const channel = new MessageChannel()
        let settled = false
        const settle = (result: PwaStartupUpdateResult) => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            channel.port1.close()
            if (result.status === 'current' || result.status === 'updated') clearPendingPwaUpdate()
            resolve(result)
        }
        const timeout = window.setTimeout(() => settle({ status: 'failed' }), 120_000)

        channel.port1.onmessage = (event: MessageEvent<{
            type?: string
            status?: PwaStartupUpdateStatus
            buildId?: string
            version?: string
            cachedAssets?: number
            completed?: number
            total?: number
            completedBytes?: number
            totalBytes?: number
        }>) => {
            if (event.data?.type === 'PREPARE_RELEASE_PROGRESS') {
                onProgress?.({
                    phase: 'downloading',
                    completed: event.data.completed,
                    total: event.data.total,
                    completedBytes: event.data.completedBytes,
                    totalBytes: event.data.totalBytes,
                })
                return
            }
            if (event.data?.type !== 'PREPARE_RELEASE_COMPLETE') return
            const status = event.data.status
            settle({
                status: status === 'current' || status === 'updated' || status === 'disabled'
                    || status === 'unavailable' ? status : 'failed',
                buildId: event.data.buildId,
                version: event.data.version,
                cachedAssets: event.data.cachedAssets,
            })
        }

        try {
            worker.postMessage({ type: 'PREPARE_RELEASE' } satisfies PwaWorkerMessage, [channel.port2])
        } catch (error) {
            console.warn('Unable to prepare the latest Atlas PWA release:', error)
            settle({ status: 'unavailable' })
        }
    })
}

/** Activates a fully staged background release and reloads after confirmation. */
export async function applyPreparedPwaUpdate(): Promise<boolean> {
    if (areApplicationUpdatesDisabled() || !canUseServiceWorkers() || typeof MessageChannel === 'undefined') {
        return false
    }
    const worker = await getActiveWorker()
    if (!worker) return false

    return new Promise((resolve) => {
        const channel = new MessageChannel()
        let settled = false
        const settle = (applied: boolean) => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            channel.port1.close()
            resolve(applied)
        }
        const timeout = window.setTimeout(() => settle(false), 15_000)
        channel.port1.onmessage = (event: MessageEvent<{ type?: string; applied?: boolean }>) => {
            if (event.data?.type === 'APPLY_UPDATE_COMPLETE') settle(event.data.applied === true)
        }
        try {
            worker.postMessage({ type: 'APPLY_UPDATE' } satisfies PwaWorkerMessage, [channel.port2])
        } catch {
            settle(false)
        }
    })
}

/**
 * Downloads and verifies the complete application bundle in a separate cache.
 * The worker keeps the existing cache active unless every required asset is
 * present, so an interrupted preparation cannot damage an installed PWA.
 */
export async function preparePwaOfflineShell(
    options: {
        allowUpdate: boolean
        onProgress?: (progress: PwaOfflinePreparationProgress) => void
    }
): Promise<PwaOfflineShellStatus & { status: PwaOfflinePreparationStatus }> {
    if (!canUseServiceWorkers() || typeof MessageChannel === 'undefined') {
        return { ready: false, status: 'unavailable' }
    }

    await updateStableWorker()
    const worker = await getActiveWorker()
    if (!worker) return { ready: false, status: 'unavailable' }

    return new Promise((resolve) => {
        const channel = new MessageChannel()
        let settled = false
        const settle = (result: PwaOfflineShellStatus & { status: PwaOfflinePreparationStatus }) => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            channel.port1.close()
            resolve(result)
        }
        const timeout = window.setTimeout(() => {
            settle({ ready: false, status: 'unavailable' })
        }, 120_000)

        channel.port1.onmessage = (event: MessageEvent<{
            type?: string
            status?: PwaOfflinePreparationStatus
            ready?: boolean
            buildId?: string
            cachedAssets?: number
            preparedAt?: number
            phase?: 'caching'
            completed?: number
            total?: number
        }>) => {
            if (event.data?.type === 'PREPARE_OFFLINE_PROGRESS') {
                options.onProgress?.({
                    phase: 'caching',
                    completed: event.data.completed ?? 0,
                    total: event.data.total ?? 0
                })
                return
            }
            if (event.data?.type !== 'PREPARE_OFFLINE_COMPLETE') return
            const status = event.data.status ?? 'failed'
            settle({
                ready: event.data.ready === true || status === 'ready' || status === 'updated',
                status,
                buildId: event.data.buildId,
                cachedAssets: event.data.cachedAssets,
                preparedAt: event.data.preparedAt
            })
        }

        try {
            worker.postMessage({
                type: 'PREPARE_OFFLINE',
                allowUpdate: options.allowUpdate
            } satisfies PwaWorkerMessage, [channel.port2])
        } catch (error) {
            console.warn('Unable to prepare Atlas for offline use:', error)
            settle({ ready: false, status: 'unavailable' })
        }
    })
}

/** Read-only cache inspection used by the Settings readiness card. */
export async function getPwaOfflineShellStatus(): Promise<PwaOfflineShellStatus> {
    if (!canUseServiceWorkers() || typeof MessageChannel === 'undefined') {
        return { ready: false }
    }

    const worker = await getActiveWorker()
    if (!worker) return { ready: false }

    return new Promise((resolve) => {
        const channel = new MessageChannel()
        let settled = false
        const settle = (result: PwaOfflineShellStatus) => {
            if (settled) return
            settled = true
            window.clearTimeout(timeout)
            channel.port1.close()
            resolve(result)
        }
        const timeout = window.setTimeout(() => settle({ ready: false }), 5_000)

        channel.port1.onmessage = (event: MessageEvent<{
            type?: string
            ready?: boolean
            buildId?: string
            cachedAssets?: number
            preparedAt?: number
        }>) => {
            if (event.data?.type !== 'OFFLINE_STATUS') return
            settle({
                ready: event.data.ready === true,
                buildId: event.data.buildId,
                cachedAssets: event.data.cachedAssets,
                preparedAt: event.data.preparedAt
            })
        }

        try {
            worker.postMessage({ type: 'GET_OFFLINE_STATUS' } satisfies PwaWorkerMessage, [channel.port2])
        } catch {
            settle({ ready: false })
        }
    })
}

export function initializePwaUpdateControl(): void {
    if (!canUseServiceWorkers() || messagingInitialized) return
    messagingInitialized = true

    navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{
        type?: string
        buildId?: string
        version?: string
    }>) => {
        if (event.data?.type === 'UPDATE_READY') {
            if (!areApplicationUpdatesDisabled()) {
                const update = { buildId: event.data.buildId, version: event.data.version }
                rememberPendingPwaUpdate(update)
                window.dispatchEvent(new CustomEvent(PWA_UPDATE_READY_EVENT, { detail: update }))
            }
            return
        }

        if (event.data?.type === 'UPDATE_APPLIED' && !areApplicationUpdatesDisabled()) {
            clearPendingPwaUpdate()
            window.location.reload()
        }
    })

    const checkForBackgroundUpdate = (force = false) => {
        if (areApplicationUpdatesDisabled() || document.visibilityState === 'hidden') return
        const now = Date.now()
        if (!force && now - lastBackgroundCheckAt < BACKGROUND_UPDATE_CHECK_THROTTLE_MS) return
        lastBackgroundCheckAt = now
        requestPwaDeploymentUpdate()
    }

    window.addEventListener('focus', () => checkForBackgroundUpdate())
    window.addEventListener('online', () => checkForBackgroundUpdate(true))
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForBackgroundUpdate()
    })
    window.setInterval(() => checkForBackgroundUpdate(true), BACKGROUND_UPDATE_CHECK_INTERVAL_MS)

    window.addEventListener(UPDATE_PREFERENCE_CHANGED_EVENT, (event: Event) => {
        const disabled = (event as CustomEvent<{ disabled?: boolean }>).detail?.disabled === true
        setPwaUpdatePolicy(disabled)
        if (disabled) clearPendingPwaUpdate()
        else checkForBackgroundUpdate(true)
    })
}
