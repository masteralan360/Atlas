import { setNetworkStatus } from '@/lib/network'

export type ConnectionEvent = 'wake' | 'online' | 'offline' | 'heartbeat' | 'network-lost'
type ConnectionListener = (event: ConnectionEvent) => void

interface ConnectionState {
    /** The app's confirmed connectivity mode. */
    isOnline: boolean
    /** The last connectivity status reported by the operating system/browser. */
    isOsOnline: boolean
    /** True while a Cloud Sync workspace should ask the user to enter offline mode. */
    offlineConfirmationRequired: boolean
    isVisible: boolean
    lastActiveAt: number
}

export class ConnectionManager {
    private listeners = new Set<ConnectionListener>()
    private state: ConnectionState = {
        // Keep the application online until the user explicitly confirms offline mode.
        // This also allows the UI to display its blocking confirmation overlay first.
        isOnline: true,
        isOsOnline: navigator.onLine !== false,
        offlineConfirmationRequired: navigator.onLine === false,
        isVisible: document.visibilityState === 'visible',
        lastActiveAt: Date.now()
    }
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null
    private initialized = false

    // Minimum idle time (ms) before a "wake" event is emitted.
    private static WAKE_THRESHOLD = 60_000
    private static HEARTBEAT_INTERVAL = 30_000

    init() {
        if (this.initialized) return
        this.initialized = true

        window.addEventListener('online', this.handleOnline)
        window.addEventListener('offline', this.handleOffline)
        document.addEventListener('visibilitychange', this.handleVisibilityChange)
        window.addEventListener('focus', this.handleFocus)

        setNetworkStatus(this.state.isOnline)
        this.startHeartbeat()
        console.log('[ConnectionManager] Initialized')
    }

    destroy() {
        window.removeEventListener('online', this.handleOnline)
        window.removeEventListener('offline', this.handleOffline)
        document.removeEventListener('visibilitychange', this.handleVisibilityChange)
        window.removeEventListener('focus', this.handleFocus)
        this.stopHeartbeat()
        this.listeners.clear()
        this.initialized = false
    }

    subscribe(listener: ConnectionListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    getState(): Readonly<ConnectionState> {
        return { ...this.state }
    }

    /**
     * Enters offline mode only after the user accepts the offline-entry prompt.
     * Returns false when connectivity has already been restored or offline mode is active.
     */
    continueOffline(): boolean {
        if (navigator.onLine !== false) {
            this.handleOnline()
            return false
        }

        if (this.state.isOsOnline) {
            this.handleOffline()
        }

        if (!this.state.isOnline || !this.state.offlineConfirmationRequired) {
            return false
        }

        console.log('[ConnectionManager] Offline mode confirmed by user')
        this.state.isOnline = false
        this.state.offlineConfirmationRequired = false
        setNetworkStatus(false)
        this.emit('offline')
        return true
    }

    /**
     * Supabase availability is intentionally not used to change connectivity mode.
     * A slow or unavailable backend is not proof that the device lost internet access.
     */
    reportConnectivitySuccess(_source = 'supabase') {
        // Kept as a no-op compatibility hook for callers that report request results.
    }

    /**
     * Supabase availability is intentionally not used to change connectivity mode.
     * A slow or unavailable backend is not proof that the device lost internet access.
     */
    reportConnectivityFailure(_source = 'supabase') {
        // Kept as a no-op compatibility hook for callers that report request results.
    }

    private emit(event: ConnectionEvent) {
        this.listeners.forEach(fn => {
            try { fn(event) } catch (e) {
                console.error('[ConnectionManager] Listener error:', e)
            }
        })
    }

    private handleOnline = () => {
        const wasDisconnected = !this.state.isOsOnline
            || !this.state.isOnline
            || this.state.offlineConfirmationRequired

        this.state.isOsOnline = true
        this.state.offlineConfirmationRequired = false
        this.state.isOnline = true
        setNetworkStatus(true)
        this.startHeartbeat()

        if (wasDisconnected) {
            console.log('[ConnectionManager] Browser network: online')
            this.emit('online')
        }
    }

    private handleOffline = () => {
        if (!this.state.isOsOnline) return

        console.log('[ConnectionManager] Browser network: offline')
        this.state.isOsOnline = false
        this.state.offlineConfirmationRequired = true
        this.stopHeartbeat()

        // Do not change the app's online state here. Cloud Sync workspaces
        // must first ask the user whether to continue offline.
        this.emit('network-lost')
    }

    private handleVisibilityChange = () => {
        const nowVisible = document.visibilityState === 'visible'
        this.state.isVisible = nowVisible

        if (nowVisible) {
            const idleDuration = Date.now() - this.state.lastActiveAt
            console.log(`[ConnectionManager] Tab visible after ${Math.round(idleDuration / 1000)}s idle`)

            this.state.lastActiveAt = Date.now()
            this.startHeartbeat()

            if (idleDuration >= ConnectionManager.WAKE_THRESHOLD && this.checkBrowserStatus()) {
                this.emit('wake')
            }
        } else {
            this.state.lastActiveAt = Date.now()
            this.stopHeartbeat()
        }
    }

    private handleFocus = () => {
        // Focus can fire without visibilitychange, e.g. alt-tabbing between windows.
        const idleDuration = Date.now() - this.state.lastActiveAt
        if (idleDuration >= ConnectionManager.WAKE_THRESHOLD && this.checkBrowserStatus()) {
            this.state.isVisible = true
            this.emit('wake')
        }
        this.state.lastActiveAt = Date.now()
    }

    private startHeartbeat() {
        this.stopHeartbeat()
        this.heartbeatTimer = setInterval(() => {
            if (!this.state.isVisible) return
            this.checkBrowserStatus()
        }, ConnectionManager.HEARTBEAT_INTERVAL)
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
    }

    /**
     * Browser/OS status is the sole source for entering or leaving offline mode.
     * Backend probes intentionally do not participate in this transition.
     */
    private checkBrowserStatus(): boolean {
        if (navigator.onLine === false) {
            this.handleOffline()
            return false
        }

        if (!this.state.isOsOnline) {
            this.handleOnline()
        }

        this.emit('heartbeat')
        return true
    }
}

export const connectionManager = new ConnectionManager()
