import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { NAVIGATION_RAIL_DEV_ENABLED, NAVIGATION_RAIL_ENABLED } from './navigationRail'

export type NavigationRailDisplayMode = 'expanded' | 'expand-on-hover'
export type NavigationRailPreference = NavigationRailDisplayMode | 'closed'

interface NavigationRailDisplayContextValue {
  preference: NavigationRailPreference
  mode: NavigationRailDisplayMode
  isEnabled: boolean
  setPreference: (preference: NavigationRailPreference) => void
  setMode: (mode: NavigationRailDisplayMode) => void
}

const NAVIGATION_RAIL_DISPLAY_MODE_STORAGE_KEY = 'navigation_rail_display_mode'

const NavigationRailDisplayContext = createContext<NavigationRailDisplayContextValue | null>(null)

function getDefaultNavigationRailPreference(): NavigationRailPreference {
  const isEnabledByDefault = import.meta.env.DEV ? NAVIGATION_RAIL_DEV_ENABLED : NAVIGATION_RAIL_ENABLED
  return isEnabledByDefault ? 'expanded' : 'closed'
}

function readStoredNavigationRailPreference(): NavigationRailPreference {
  if (typeof window === 'undefined') return getDefaultNavigationRailPreference()

  try {
    const stored = window.localStorage.getItem(NAVIGATION_RAIL_DISPLAY_MODE_STORAGE_KEY)
    if (stored === 'expanded' || stored === 'expand-on-hover' || stored === 'closed') return stored
    return getDefaultNavigationRailPreference()
  } catch {
    return getDefaultNavigationRailPreference()
  }
}

export function NavigationRailDisplayProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<NavigationRailPreference>(readStoredNavigationRailPreference)

  const setPreference = useCallback((nextPreference: NavigationRailPreference) => {
    setPreferenceState(nextPreference)
    try {
      window.localStorage.setItem(NAVIGATION_RAIL_DISPLAY_MODE_STORAGE_KEY, nextPreference)
    } catch {
      // Keep the in-memory preference usable when storage is unavailable.
    }
  }, [])

  const mode: NavigationRailDisplayMode = preference === 'expand-on-hover' ? 'expand-on-hover' : 'expanded'
  const isEnabled = preference !== 'closed'
  const setMode = useCallback((nextMode: NavigationRailDisplayMode) => setPreference(nextMode), [setPreference])
  const value = useMemo(
    () => ({ preference, mode, isEnabled, setPreference, setMode }),
    [preference, mode, isEnabled, setPreference, setMode]
  )

  return <NavigationRailDisplayContext.Provider value={value}>{children}</NavigationRailDisplayContext.Provider>
}

export function useNavigationRailDisplay() {
  const context = useContext(NavigationRailDisplayContext)
  if (!context) {
    throw new Error('useNavigationRailDisplay must be used within NavigationRailDisplayProvider')
  }
  return context
}
