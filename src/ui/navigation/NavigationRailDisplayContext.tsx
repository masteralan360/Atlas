import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type NavigationRailDisplayMode = 'expanded' | 'expand-on-hover'

interface NavigationRailDisplayContextValue {
  mode: NavigationRailDisplayMode
  setMode: (mode: NavigationRailDisplayMode) => void
}

const NAVIGATION_RAIL_DISPLAY_MODE_STORAGE_KEY = 'navigation_rail_display_mode'

const NavigationRailDisplayContext = createContext<NavigationRailDisplayContextValue | null>(null)

function readStoredNavigationRailDisplayMode(): NavigationRailDisplayMode {
  if (typeof window === 'undefined') return 'expanded'

  try {
    return window.localStorage.getItem(NAVIGATION_RAIL_DISPLAY_MODE_STORAGE_KEY) === 'expand-on-hover'
      ? 'expand-on-hover'
      : 'expanded'
  } catch {
    return 'expanded'
  }
}

export function NavigationRailDisplayProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<NavigationRailDisplayMode>(readStoredNavigationRailDisplayMode)

  const setMode = useCallback((nextMode: NavigationRailDisplayMode) => {
    setModeState(nextMode)
    try {
      window.localStorage.setItem(NAVIGATION_RAIL_DISPLAY_MODE_STORAGE_KEY, nextMode)
    } catch {
      // Keep the in-memory preference usable when storage is unavailable.
    }
  }, [])

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode])

  return <NavigationRailDisplayContext.Provider value={value}>{children}</NavigationRailDisplayContext.Provider>
}

export function useNavigationRailDisplay() {
  const context = useContext(NavigationRailDisplayContext)
  if (!context) {
    throw new Error('useNavigationRailDisplay must be used within NavigationRailDisplayProvider')
  }
  return context
}
