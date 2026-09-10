import { launcherSectionOrder, type NavigationSectionKey } from './navigationMeta'

export const sidebarModuleOrderStorageVersion = 1

export type SidebarModuleOrderBySection = Partial<Record<NavigationSectionKey, string[]>>

interface StoredSidebarModuleOrder {
  version: number
  moduleOrderBySection: unknown
}

function isStoredSidebarModuleOrder(value: unknown): value is StoredSidebarModuleOrder {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as StoredSidebarModuleOrder).version === sidebarModuleOrderStorageVersion &&
      typeof (value as StoredSidebarModuleOrder).moduleOrderBySection === 'object' &&
      (value as StoredSidebarModuleOrder).moduleOrderBySection !== null
  )
}

function isModuleHref(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length > 1
}

function normalizeModuleOrder(moduleOrder: unknown): string[] {
  if (!Array.isArray(moduleOrder)) return []

  const uniqueModuleHrefs: string[] = []
  for (const href of moduleOrder) {
    if (isModuleHref(href) && !uniqueModuleHrefs.includes(href)) {
      uniqueModuleHrefs.push(href)
    }
  }

  return uniqueModuleHrefs
}

export function readSidebarModuleOrder(serialized: string | null): SidebarModuleOrderBySection {
  if (!serialized) return {}

  try {
    const parsed: unknown = JSON.parse(serialized)
    if (!isStoredSidebarModuleOrder(parsed)) return {}

    const savedOrderBySection = parsed.moduleOrderBySection as Record<string, unknown>
    return launcherSectionOrder.reduce<SidebarModuleOrderBySection>((moduleOrderBySection, sectionKey) => {
      const sectionOrder = normalizeModuleOrder(savedOrderBySection[sectionKey])
      if (sectionOrder.length > 0) {
        moduleOrderBySection[sectionKey] = sectionOrder
      }
      return moduleOrderBySection
    }, {})
  } catch {
    return {}
  }
}

export function createSidebarModuleOrderStorageValue(moduleOrderBySection: SidebarModuleOrderBySection) {
  const normalizedOrderBySection = launcherSectionOrder.reduce<SidebarModuleOrderBySection>(
    (normalized, sectionKey) => {
      const sectionOrder = normalizeModuleOrder(moduleOrderBySection[sectionKey])
      if (sectionOrder.length > 0) {
        normalized[sectionKey] = sectionOrder
      }
      return normalized
    },
    {}
  )

  return JSON.stringify({
    version: sidebarModuleOrderStorageVersion,
    moduleOrderBySection: normalizedOrderBySection
  })
}

/**
 * Restores an ordered list of direct module links. Saved links that are
 * currently unavailable remain in the result, so a permissions or plan change
 * does not discard the place a module will occupy when it becomes visible again.
 */
export function reconcileSidebarModuleOrder(
  savedOrder: readonly string[] | undefined,
  visibleModuleHrefs: readonly string[]
): string[] {
  const restoredOrder = normalizeModuleOrder(savedOrder)

  return [...restoredOrder, ...visibleModuleHrefs.filter((href) => !restoredOrder.includes(href))]
}

export function reorderVisibleSidebarModuleItems(
  savedOrder: readonly string[] | undefined,
  visibleModuleHrefs: readonly string[],
  sourceIndex: number,
  destinationIndex: number
): string[] {
  const reconciledOrder = reconcileSidebarModuleOrder(savedOrder, visibleModuleHrefs)

  if (
    sourceIndex < 0 ||
    destinationIndex < 0 ||
    sourceIndex >= visibleModuleHrefs.length ||
    destinationIndex >= visibleModuleHrefs.length ||
    sourceIndex === destinationIndex
  ) {
    return reconciledOrder
  }

  const reorderedVisibleHrefs = [...visibleModuleHrefs]
  const [movedHref] = reorderedVisibleHrefs.splice(sourceIndex, 1)
  reorderedVisibleHrefs.splice(destinationIndex, 0, movedHref)

  const visibleHrefSet = new Set(visibleModuleHrefs)
  let visibleIndex = 0

  return reconciledOrder.map((href) => {
    if (!visibleHrefSet.has(href)) return href

    const nextHref = reorderedVisibleHrefs[visibleIndex]
    visibleIndex += 1
    return nextHref
  })
}

export function getSidebarModuleOrderStorageKey(userId: string, workspaceId: string) {
  return `atlas.sidebar.module-order.v${sidebarModuleOrderStorageVersion}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`
}
