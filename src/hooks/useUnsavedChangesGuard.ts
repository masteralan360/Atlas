import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Intercepts both browser-level navigation (tab close / refresh) and
 * in-app routing (wouter uses history.pushState) when the form is dirty.
 *
 * Returns:
 *  - pendingPath: the path the user tried to navigate to (null if none)
 *  - confirmNavigation: call to actually navigate to pendingPath
 *  - cancelNavigation: call to dismiss & stay on page
 *  - showGuard: convenience boolean
 *  - requestNavigation: manually trigger guard for buttons (Cancel/Back)
 */
export function useUnsavedChangesGuard(isDirty: boolean) {
    const [pendingPath, setPendingPath] = useState<string | null>(null)
    const isDirtyRef = useRef(isDirty)
    const originalPushStateRef = useRef<typeof window.history.pushState | null>(null)

    useEffect(() => {
        isDirtyRef.current = isDirty
    }, [isDirty])

    // Block browser tab close / refresh
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (!isDirtyRef.current) return
            e.preventDefault()
        }

        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
    }, [])

    // Intercept history.pushState (used by wouter for all route changes programmatically)
    useEffect(() => {
        const originalPushState = window.history.pushState.bind(window.history)
        originalPushStateRef.current = originalPushState

        window.history.pushState = function (...args: Parameters<typeof window.history.pushState>) {
            if (isDirtyRef.current) {
                const url = args[2]
                if (url && typeof url === 'string') {
                    setPendingPath(url)
                    return // Block navigation
                }
            }
            return originalPushState(...args)
        }

        return () => {
            window.history.pushState = originalPushState
            originalPushStateRef.current = null
        }
    }, [])

    // Intercept <a> tag clicks globally (capture phase) to block wouter <Link> components (e.g., in sidebar)
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (!isDirtyRef.current) return

            // Allow default for modifiers (opening in new tab, etc.)
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return

            const anchor = (e.target as Element).closest('a')
            if (!anchor) return

            const href = anchor.getAttribute('href')
            if (!href) return

            if (anchor.target === '_blank' || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:')) return

            // Intercept internal paths
            if (href.startsWith('/')) {
                if (href !== window.location.pathname) {
                    e.preventDefault()
                    e.stopPropagation() // Prevent wouter Link from handling the click
                    setPendingPath(href)
                }
            }
        }

        document.addEventListener('click', handleClick, { capture: true })
        return () => document.removeEventListener('click', handleClick, { capture: true })
    }, [])

    const confirmNavigation = useCallback((navigateCb?: (path: string) => void) => {
        const path = pendingPath
        setPendingPath(null)
        isDirtyRef.current = false
        if (path) {
            if (navigateCb) {
                navigateCb(path)
            } else if (originalPushStateRef.current) {
                // Use the original (unpatched) pushState so we don't re-intercept
                originalPushStateRef.current(null, '', path)
                // Dispatch popstate so wouter picks up the new location
                window.dispatchEvent(new PopStateEvent('popstate'))
            }
        }
    }, [pendingPath])

    const cancelNavigation = useCallback(() => {
        setPendingPath(null)
    }, [])

    // Allow triggering guard manually (e.g. Cancel / Back button)
    const requestNavigation = useCallback((path: string) => {
        if (isDirtyRef.current) {
            setPendingPath(path)
            return true // blocked
        }
        return false // not dirty, caller should navigate
    }, [])

    return {
        pendingPath,
        showGuard: pendingPath !== null,
        confirmNavigation,
        cancelNavigation,
        requestNavigation
    }
}
