import '@/lib/consoleErrorCapture'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '@/i18n/config'
import { requestPersistentStorage } from '@/local-db/storagePersist'
import { isOpfsSupported } from '@/local-db/pwaSqlite'
import { AtlasSplashScreen } from '@/ui/components/AtlasSplashScreen'
import { initDesktopZoomPersistence } from '@/lib/tauriZoomPersistence'
import { removeDeploymentRefreshParam } from '@/lib/deploymentRefresh'
import {
    preparePwaReleaseForStartup,
    refreshPwaDeployment,
} from '@/lib/pwaUpdateControl'
import { areApplicationUpdatesDisabled } from '@/lib/updatePreference'

type ShellStartupController = {
    update: (message: string, progress?: number, supportingText?: string) => void
    dismiss: () => void
}

const getShellStartupController = (): ShellStartupController | undefined => (
    window as typeof window & { __atlasShellStartup?: ShellStartupController }
).__atlasShellStartup

const updateShellStartup = (message: string, progress?: number, supportingText?: string) => {
    getShellStartupController()?.update(message, progress, supportingText)
}

const isMarketplaceHost =
    typeof window !== 'undefined'
    && window.location.hostname === 'shop.atlaserp.dev'

const isTauriRuntime =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

if (typeof window !== 'undefined') {
    const refreshedUrl = removeDeploymentRefreshParam(window.location.href)
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (refreshedUrl !== currentPath) {
        window.history.replaceState(null, '', refreshedUrl)
    }
}

function isPwaMode(): boolean {
    if (typeof window === 'undefined') return false
    if ((window.navigator as any).standalone) return true
    try { return window.matchMedia('(display-mode: standalone)').matches } catch { return false }
}

function isColdStart(): boolean {
    try {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
        if (nav) return nav.type === 'navigate'
    } catch { }
    return true
}

const initPwaLocalMode = async () => {
    if (import.meta.env.PROD && isOpfsSupported()) {
        try {
            await requestPersistentStorage()
        } catch (error) {
            console.error('Failed to request persistent storage:', error)
        }
    }
}

if (
    import.meta.env.PROD
    && typeof window !== 'undefined'
    && !('__TAURI_INTERNALS__' in window)
    && 'serviceWorker' in navigator
    && isMarketplaceHost
) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.getRegistrations()
            .then(async (registrations) => {
                const results = await Promise.all(registrations.map((registration) => registration.unregister()))
                if (results.some(Boolean)) window.location.reload()
            })
            .catch((error) => {
                console.error('Failed to unregister marketplace service workers:', error)
            })
    })
}

const isDynamicImportFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error ?? '')
    return message.includes('Failed to fetch dynamically imported module')
        || message.includes('Importing a stopped module')
}

const recoverFromDynamicImportFailure = async (error: unknown) => {
    if (!isDynamicImportFailure(error) || areApplicationUpdatesDisabled()) {
        return false
    }

    const key = '__atlas_reload_ts__'
    const last = parseInt(sessionStorage.getItem(key) || '0', 10)
    const now = Date.now()
    if (now - last <= 30000) {
        console.error('[Critical] Chunk load failed again within 30s. Breaking reload loop.', error)
        return false
    }

    sessionStorage.setItem(key, String(now))
    console.error('[Critical] Chunk load failed. Recovering the current deployment...', error)
    await refreshPwaDeployment()
    window.location.reload()
    return true
}

window.addEventListener('unhandledrejection', (event) => {
    void recoverFromDynamicImportFailure(event.reason)
})

if (import.meta.env.DEV && typeof window !== 'undefined') {
    void import('@/ui/components/use-toast').then(({ toast }) => {
        ;(window as any).toast = toast
    })
}

const rootElement = document.getElementById('root')

if (!rootElement) {
    throw new Error('Root element not found')
}

const root = createRoot(rootElement)

const dismissShellRecovery = () => getShellStartupController()?.dismiss()

const renderRoot = (content: ReactNode) => {
    updateShellStartup('Opening your workspace', 100)
    dismissShellRecovery()
    root.render(
        <StrictMode>
            {content}
        </StrictMode>,
    )
}

const renderStartupFailure = (error: unknown) => {
    console.error('[Atlas] Application startup failed:', error)
    const canRecoverCurrentDeployment = isDynamicImportFailure(error) && !areApplicationUpdatesDisabled()
    dismissShellRecovery()
    root.render(
        <div
            role="alert"
            style={{
                minHeight: '100dvh',
                display: 'grid',
                placeItems: 'center',
                padding: 24,
                background: '#f8fafc',
                color: '#0f172a',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                textAlign: 'center',
            }}
        >
            <div style={{ maxWidth: 420 }}>
                <h1 style={{ margin: '0 0 12px', fontSize: 24 }}>Atlas needs to finish an update</h1>
                <p style={{ margin: '0 0 20px', lineHeight: 1.5 }}>
                    Connect to the internet, then tap Retry. Your local business data remains on this device.
                </p>
                <button
                    type="button"
                    onClick={() => {
                        if (canRecoverCurrentDeployment) {
                            void recoverFromDynamicImportFailure(error).then((recovering) => {
                                if (!recovering) window.location.reload()
                            })
                            return
                        }
                        window.location.reload()
                    }}
                    style={{
                        border: 0,
                        borderRadius: 10,
                        padding: '12px 20px',
                        background: '#0cb7ae',
                        color: '#fff',
                        fontSize: 16,
                        fontWeight: 600,
                    }}
                >
                    Retry
                </button>
            </div>
        </div>,
    )

    if (canRecoverCurrentDeployment) {
        void recoverFromDynamicImportFailure(error)
    }
}



const renderMarketplace = async () => {
    updateShellStartup('Loading the marketplace', 25)
    const [, { Toaster }, { MarketplaceApp }, { MarketplaceThemeRoot }] = await Promise.all([
        import('./index.css'),
        import('@/ui/components'),
        import('./marketplace/MarketplaceApp'),
        import('./marketplace/MarketplaceThemeRoot'),
    ])

    renderRoot(
        <MarketplaceThemeRoot>
            <MarketplaceApp />
            <Toaster />
        </MarketplaceThemeRoot>,
    )
}

const bootApp = async (splash: boolean) => {
    updateShellStartup('Loading the Atlas interface', 35)
    const preloads: Promise<unknown>[] = []
    if (splash) {
        preloads.push(import('@/ui/pages/Dashboard'), import('@/ui/pages/Login'))
    }

    const [
        ,
        { ThemeProvider },
        { platformService },
        { connectionManager },
        { default: App }
    ] = await Promise.all([
        import('./index.css'),
        import('@/ui/components/theme-provider'),
        import('@/services/platformService'),
        import('@/lib/connectionManager'),
        import('./App.tsx'),
        ...preloads,
    ])

    updateShellStartup('Preparing your workspace', 65)
    connectionManager.init()

    try {
        updateShellStartup('Starting device services', 78)
        await platformService.initialize()
    } catch (error) {
        console.error('Failed to initialize platform service:', error)
    }

    updateShellStartup('Finalizing Atlas startup', 90)
    return { ThemeProvider, App } as const
}

const init = async () => {
    updateShellStartup('Application code loaded', 20)
    if (isMarketplaceHost && window.location.hash) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }

    if (isMarketplaceHost) {
        await renderMarketplace()
        return
    }

    initDesktopZoomPersistence()

    void initPwaLocalMode()

    const canShowSplash = !isMarketplaceHost && isColdStart() && (isPwaMode() || (isTauriRuntime && !import.meta.env.DEV))

    // Start loading immediately
    const bootPromise = bootApp(canShowSplash)

    if (canShowSplash) {
        // Phase 1: Show splash immediately. App container hidden + empty.
        root.render(
            <StrictMode>
                <div id="atlas-splash" style={{}}>
                    <AtlasSplashScreen />
                </div>
                <div id="atlas-app" style={{ display: 'none' }} />
            </StrictMode>,
        )
        dismissShellRecovery()

        // Modules load in background while splash plays
        const { ThemeProvider, App } = await bootPromise

        // Phase 2: Inject app into hidden container. AuthProvider (inside App.tsx)
        // mounts and starts initializing. Splash still visible.
        root.render(
            <StrictMode>
                <div id="atlas-splash" style={{}}>
                    <AtlasSplashScreen />
                </div>
                <div id="atlas-app" style={{ display: 'none' }}>
                    <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme" defaultStyle="emerald">
                        <App />
                    </ThemeProvider>
                </div>
            </StrictMode>,
        )

        const dismissOnKey = new Promise<void>(resolve => {
            window.addEventListener('keydown', () => resolve(), { once: true })
        })

        await Promise.race([dismissOnKey, new Promise<void>(r => setTimeout(r, 2800))])

        // Phase 3: Show app, hide splash. Tree structure identical to Phase 2
        // — React preserves all state (AuthProvider, etc.)
        dismissShellRecovery()
        root.render(
            <StrictMode>
                <div id="atlas-splash" style={{ display: 'none' }}>
                    <AtlasSplashScreen />
                </div>
                <div id="atlas-app" style={{}}>
                    <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme" defaultStyle="emerald">
                        <App />
                    </ThemeProvider>
                </div>
            </StrictMode>,
        )

        return
    }

    const { ThemeProvider, App } = await bootPromise

    renderRoot(
        <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme" defaultStyle="emerald">
            <App />
        </ThemeProvider>,
    )
}

const PWA_RELOAD_GUARD_KEY = 'atlas_pwa_startup_reload_build'

const runStartup = async () => {
    const shouldCheckPwaRelease = import.meta.env.PROD
        && !isMarketplaceHost
        && !isTauriRuntime
        && 'serviceWorker' in navigator

    if (shouldCheckPwaRelease) {
        const result = await preparePwaReleaseForStartup((progress) => {
            if (progress.phase === 'checking') {
                updateShellStartup(
                    i18n.t('pwaUpdater.checking'),
                    12,
                    i18n.t('pwaUpdater.checkingDescription'),
                )
                return
            }

            const completedBytes = progress.completedBytes ?? 0
            const totalBytes = progress.totalBytes ?? 0
            const completed = progress.completed ?? 0
            const total = progress.total ?? 0
            const ratio = totalBytes > 0
                ? completedBytes / totalBytes
                : total > 0 ? completed / total : 0
            updateShellStartup(
                i18n.t('pwaUpdater.downloading'),
                18 + Math.round(Math.max(0, Math.min(1, ratio)) * 70),
                i18n.t('pwaUpdater.downloadingDescription', { completed, total }),
            )
        })

        if (result.status === 'updated') {
            const reloadBuild = result.buildId ?? 'legacy-protocol-update'
            const previousReloadBuild = sessionStorage.getItem(PWA_RELOAD_GUARD_KEY)
            if (previousReloadBuild !== reloadBuild) {
                sessionStorage.setItem(PWA_RELOAD_GUARD_KEY, reloadBuild)
                updateShellStartup(
                    i18n.t('pwaUpdater.restarting'),
                    100,
                    i18n.t('pwaUpdater.restartingDescription'),
                )
                window.location.reload()
                return
            }
            console.error('[Atlas PWA] Prevented a repeated startup reload for build:', reloadBuild)
        } else if (result.status === 'current') {
            sessionStorage.removeItem(PWA_RELOAD_GUARD_KEY)
        } else if (result.status === 'failed' || result.status === 'unavailable') {
            updateShellStartup(
                i18n.t('pwaUpdater.openingInstalled'),
                18,
                i18n.t('pwaUpdater.openingInstalledDescription'),
            )
        }
    }

    await init()
}

void runStartup().catch(renderStartupFailure)
