import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

import { ThemeProvider } from '@/ui/components/theme-provider'
import './i18n/config'
import { platformService } from '@/services/platformService'
import { connectionManager } from '@/lib/connectionManager'

// Initialize connection manager (visibility, online/offline, heartbeat)
connectionManager.init()

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

    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme" defaultStyle="emerald">
                {/* To set Legacy as default, use: defaultStyle="legacy" */}
                <App />
            </ThemeProvider>
        </StrictMode>,
    )
}

init();
