export const isPwaDesktop = () => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

    const tauriWindow = window as typeof window & {
        __TAURI__?: unknown
        __TAURI_METADATA__?: unknown
        __TAURI_INTERNALS__?: unknown
    }
    if (tauriWindow.__TAURI__ || tauriWindow.__TAURI_METADATA__ || tauriWindow.__TAURI_INTERNALS__) return false
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) return false

    const pwaNavigator = navigator as Navigator & { standalone?: boolean }
    if (pwaNavigator.standalone === true) return true

    try {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.matchMedia('(display-mode: window-controls-overlay)').matches
    } catch {
        return false
    }
}
