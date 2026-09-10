import { launcherSectionOrder, type NavigationSectionKey } from './navigationMeta'

export const sidebarSectionOrderStorageVersion = 1

interface StoredSidebarSectionOrder {
  version: number
  sectionOrder: unknown
}

function isStoredSidebarSectionOrder(value: unknown): value is StoredSidebarSectionOrder {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as StoredSidebarSectionOrder).version === sidebarSectionOrderStorageVersion &&
      Array.isArray((value as StoredSidebarSectionOrder).sectionOrder)
  )
}

export function reconcileSidebarSectionOrder(
  savedOrder: readonly string[] | undefined,
  canonicalOrder: readonly NavigationSectionKey[] = launcherSectionOrder
): NavigationSectionKey[] {
  if (!savedOrder) return [...canonicalOrder]

  const knownKeys = new Set<string>(canonicalOrder)
  const restoredOrder: NavigationSectionKey[] = []

  for (const key of savedOrder) {
    if (knownKeys.has(key) && !restoredOrder.includes(key as NavigationSectionKey)) {
      restoredOrder.push(key as NavigationSectionKey)
    }
  }

  return [...restoredOrder, ...canonicalOrder.filter((key) => !restoredOrder.includes(key))]
}

export function readSidebarSectionOrder(serialized: string | null): NavigationSectionKey[] {
  if (!serialized) return [...launcherSectionOrder]

  try {
    const parsed: unknown = JSON.parse(serialized)
    if (!isStoredSidebarSectionOrder(parsed)) return [...launcherSectionOrder]

    return reconcileSidebarSectionOrder(parsed.sectionOrder as string[])
  } catch {
    return [...launcherSectionOrder]
  }
}

export function createSidebarSectionOrderStorageValue(sectionOrder: readonly NavigationSectionKey[]) {
  return JSON.stringify({
    version: sidebarSectionOrderStorageVersion,
    sectionOrder
  })
}

export function reorderVisibleSidebarSections(
  sectionOrder: readonly NavigationSectionKey[],
  visibleSectionKeys: readonly NavigationSectionKey[],
  sourceIndex: number,
  destinationIndex: number
): NavigationSectionKey[] {
  if (
    sourceIndex < 0 ||
    destinationIndex < 0 ||
    sourceIndex >= visibleSectionKeys.length ||
    destinationIndex >= visibleSectionKeys.length ||
    sourceIndex === destinationIndex
  ) {
    return [...sectionOrder]
  }

  const reorderedVisibleKeys = [...visibleSectionKeys]
  const [movedKey] = reorderedVisibleKeys.splice(sourceIndex, 1)
  reorderedVisibleKeys.splice(destinationIndex, 0, movedKey)

  const visibleKeySet = new Set(visibleSectionKeys)
  let visibleIndex = 0

  return sectionOrder.map((key) => {
    if (!visibleKeySet.has(key)) return key

    const nextKey = reorderedVisibleKeys[visibleIndex]
    visibleIndex += 1
    return nextKey
  })
}

export function getSidebarSectionOrderStorageKey(userId: string, workspaceId: string) {
  return `atlas.sidebar.section-order.v${sidebarSectionOrderStorageVersion}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`
}
