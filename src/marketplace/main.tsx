import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../index.css'
import '../i18n/config'

import { Toaster } from '@/ui/components'
import { ThemeProvider } from '@/ui/components/theme-provider'
import { MarketplaceApp } from './MarketplaceApp'

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme" defaultStyle="emerald">
            <MarketplaceApp />
            <Toaster />
        </ThemeProvider>
    </StrictMode>
)
