import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

import { Toaster } from '@/ui/components'
import { ThemeProvider } from '@/ui/components/theme-provider'
import './i18n/config'
import { platformService } from '@/services/platformService'
import { connectionManager } from '@/lib/connectionManager'
import { MarketplaceApp } from './marketplace/MarketplaceApp'

// Initialize connection manager (visibility, online/offline, heartbeat)
connectionManager.init()

const isMarketplaceHost =
    typeof window !== 'undefined'
    && window.location.hostname === 'marketplace-atlas.vercel.app'

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

        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
            console.error('Failed to register service worker:', error)
        })
    })
}

// Global error handler for lazy loading failures (chunks)
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.message?.includes('Failed to fetch dynamically imported module') ||
        event.reason?.message?.includes('Importing a stopped module')) {
        console.error('[Critical] Chunk load failed. Auto-reloading...', event.reason);
        window.location.reload();
    }
});

// Initialize platform service and then render
const init = async () => {
    try {
        await platformService.initialize();
    } catch (e) {
        console.error('Failed to initialize platform service:', e);
    }

    if (isMarketplaceHost && window.location.hash) {
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }

    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme" defaultStyle="emerald">
                {isMarketplaceHost ? (
                    <>
                        <MarketplaceApp />
                        <Toaster />
                    </>
                ) : (
                    <>
                        {/* To set Legacy as default, use: defaultStyle="legacy" */}
                        <App />
                    </>
                )}
            </ThemeProvider>
        </StrictMode>,
    )
}

init();
