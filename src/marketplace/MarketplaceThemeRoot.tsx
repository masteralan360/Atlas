import { useLayoutEffect, type ReactNode } from 'react'

const appThemeClasses = [
    'theme-modern',
    'theme-legacy',
    'theme-primary',
    'theme-emerald',
    'theme-neo-orange',
    'theme-gold',
    'theme-low-power',
    'low-power'
]

/**
 * Public marketplace pages never inherit the saved Atlas application theme.
 * Individual storefront templates can still use any palette they need inside
 * this light application shell.
 */
export function MarketplaceThemeRoot({ children }: { children: ReactNode }) {
    useLayoutEffect(() => {
        const root = document.documentElement

        root.classList.remove('dark', ...appThemeClasses)
        root.classList.add('light', 'theme-emerald')
        root.style.colorScheme = 'light'
    }, [])

    return (
        <div className="h-dvh overflow-hidden bg-white text-slate-950" style={{ colorScheme: 'light' }}>
            {children}
        </div>
    )
}
