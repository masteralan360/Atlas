import '@/lib/consoleErrorCapture'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { requestPersistentStorage } from '@/local-db/storagePersist'
import { isOpfsSupported } from '@/local-db/pwaSqlite'
import { AtlasSplashScreen } from '@/ui/components/AtlasSplashScreen'
import { initDesktopZoomPersistence } from '@/lib/tauriZoomPersistence'
import { removeDeploymentRefreshParam } from '@/lib/deploymentRefresh'
import {
    cacheCurrentPwaVersion,
    initializePwaUpdateControl,
    refreshPwaDeployment,
    requestPwaDeploymentUpdate,
    setPwaUpdatePolicy
} from '@/lib/pwaUpdateControl'
import { areApplicationUpdatesDisabled } from '@/lib/updatePreference'

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

const registerAppServiceWorker = () => {
    initializePwaUpdateControl()

    void navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        // The worker is a stable update gate. It must not be replaced by a
        // deployment-specific Workbox worker on every web deployment.
        updateViaCache: 'none'
    }).then(async (registration) => {
        // Ask the browser to re-check the stable gate on every launch. This
        // lets an already-installed PWA receive a worker recovery fix without
        // clearing its offline cache or reinstalling the app.
        try {
            await registration.update()
        } catch (error) {
            console.warn('Failed to re-check the Atlas service worker:', error)
        }
        return navigator.serviceWorker.ready
    })
        .then(() => {
            const updatesDisabled = areApplicationUpdatesDisabled()
            setPwaUpdatePolicy(updatesDisabled)
            if (!updatesDisabled) {
                cacheCurrentPwaVersion()
                requestPwaDeploymentUpdate()
            }
        })
        .catch((error) => {
            console.error('Failed to register service worker:', error)
        })
}

if (
    import.meta.env.PROD
    && typeof window !== 'undefined'
    && !('__TAURI_INTERNALS__' in window)
    && 'serviceWorker' in navigator
) {
    window.addEventListener('load', () => {
        if (isMarketplaceHost) {
            navigator.serviceWorker.getRegistrations()
                .then(async (registrations) => {
                    const results = await Promise.all(registrations.map((registration) => registration.unregister()))
                    if (results.some(Boolean)) {
                        window.location.reload()
                    }
                })
                .catch((error) => {
                    console.error('Failed to unregister marketplace service workers:', error)
                })

            return
        }

        registerAppServiceWorker()
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

const dismissShellRecovery = () => {
    const recovery = document.getElementById('atlas-shell-recovery')
    if (!recovery) return
    recovery.dataset.dismissed = 'true'
    recovery.setAttribute('hidden', '')
}

const renderRoot = (content: ReactNode) => {
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
    const [, { Toaster }, { MarketplaceApp }, { MarketplaceThemeRoot }] = await Promise.all([
        import('./index.css'),
        import('@/ui/components'),
        import('./marketplace/MarketplaceApp'),
        import('./marketplace/MarketplaceThemeRoot'),
        import('./i18n/config')
    ])

    renderRoot(
        <MarketplaceThemeRoot>
            <MarketplaceApp />
            <Toaster />
        </MarketplaceThemeRoot>,
    )
}

const bootApp = async (splash: boolean) => {
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
        import('./i18n/config'),
        ...preloads,
    ])

    connectionManager.init()

    try {
        await platformService.initialize()
    } catch (error) {
        console.error('Failed to initialize platform service:', error)
    }

    return { ThemeProvider, App } as const
}

const init = async () => {
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

void init().catch(renderStartupFailure)
