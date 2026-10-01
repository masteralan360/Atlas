// Set to false to restore the standard sidebar and titlebar layout.
export const NAVIGATION_RAIL_ENABLED = false
export const NAVIGATION_RAIL_DEV_ENABLED = true
export const isNavigationRailEnabled = import.meta.env.DEV
  ? NAVIGATION_RAIL_DEV_ENABLED
  : NAVIGATION_RAIL_ENABLED
export const NAVIGATION_RAIL_WIDTH = 56
