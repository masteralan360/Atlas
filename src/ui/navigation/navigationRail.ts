// Default behavior when no device preference has been saved.
export const NAVIGATION_RAIL_ENABLED = false
export const NAVIGATION_RAIL_DEV_ENABLED = true
export const NAVIGATION_RAIL_MIN_WIDTH = 1280
export const isNavigationRailEnabled = (viewportWidth: number, enabled: boolean) =>
  enabled && viewportWidth >= NAVIGATION_RAIL_MIN_WIDTH
export const NAVIGATION_RAIL_WIDTH = 56
export const NAVIGATION_RAIL_COLLAPSED_WIDTH = 16
export const NAVIGATION_RAIL_CORNER_RADIUS = 16
