export const sidebarFavoritesStorageVersion = 1

export interface SidebarFavorites {
  order: string[]
  firstAddedOrder: string[]
}

interface StoredSidebarFavorites {
  version: number
  order: unknown
  firstAddedOrder: unknown
}

const emptyFavorites = (): SidebarFavorites => ({ order: [], firstAddedOrder: [] })

function isModuleHref(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length > 1
}

function normalizeHrefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value.reduce<string[]>((hrefs, href) => {
    if (isModuleHref(href) && !hrefs.includes(href)) hrefs.push(href)
    return hrefs
  }, [])
}

function normalizeFavorites(order: unknown, firstAddedOrder: unknown): SidebarFavorites {
  const normalizedFirstAddedOrder = normalizeHrefs(firstAddedOrder)
  const normalizedOrder = normalizeHrefs(order)
  const allHrefs = [...normalizedFirstAddedOrder]

  for (const href of normalizedOrder) {
    if (!allHrefs.includes(href)) allHrefs.push(href)
  }

  return {
    order: [...normalizedOrder, ...allHrefs.filter((href) => !normalizedOrder.includes(href))],
    firstAddedOrder: allHrefs
  }
}

export function readSidebarFavorites(serialized: string | null): SidebarFavorites {
  if (!serialized) return emptyFavorites()

  try {
    const parsed: unknown = JSON.parse(serialized)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as StoredSidebarFavorites).version !== sidebarFavoritesStorageVersion
    ) {
      return emptyFavorites()
    }

    return normalizeFavorites(
      (parsed as StoredSidebarFavorites).order,
      (parsed as StoredSidebarFavorites).firstAddedOrder
    )
  } catch {
    return emptyFavorites()
  }
}

export function createSidebarFavoritesStorageValue(favorites: SidebarFavorites) {
  const normalized = normalizeFavorites(favorites.order, favorites.firstAddedOrder)
  return JSON.stringify({ version: sidebarFavoritesStorageVersion, ...normalized })
}

export function addSidebarFavorite(favorites: SidebarFavorites, href: string): SidebarFavorites {
  const normalized = normalizeFavorites(favorites.order, favorites.firstAddedOrder)
  if (!isModuleHref(href) || normalized.order.includes(href)) return normalized

  return {
    order: [...normalized.order, href],
    firstAddedOrder: [...normalized.firstAddedOrder, href]
  }
}

export function removeSidebarFavorite(favorites: SidebarFavorites, href: string): SidebarFavorites {
  const normalized = normalizeFavorites(favorites.order, favorites.firstAddedOrder)
  return {
    order: normalized.order.filter((favoriteHref) => favoriteHref !== href),
    firstAddedOrder: normalized.firstAddedOrder.filter((favoriteHref) => favoriteHref !== href)
  }
}

/** Reorders visible favorites while retaining saved unavailable modules. */
export function reorderVisibleSidebarFavorites(
  favorites: SidebarFavorites,
  visibleFavoriteHrefs: readonly string[],
  sourceIndex: number,
  destinationIndex: number
): SidebarFavorites {
  const normalized = normalizeFavorites(favorites.order, favorites.firstAddedOrder)
  if (
    sourceIndex < 0 ||
    destinationIndex < 0 ||
    sourceIndex >= visibleFavoriteHrefs.length ||
    destinationIndex >= visibleFavoriteHrefs.length ||
    sourceIndex === destinationIndex
  ) {
    return normalized
  }

  const reorderedVisible = [...visibleFavoriteHrefs]
  const [moved] = reorderedVisible.splice(sourceIndex, 1)
  reorderedVisible.splice(destinationIndex, 0, moved)
  const visibleSet = new Set(visibleFavoriteHrefs)
  let visibleIndex = 0

  return {
    ...normalized,
    order: normalized.order.map((href) => (visibleSet.has(href) ? reorderedVisible[visibleIndex++] : href))
  }
}

export function resetSidebarFavoritesOrder(favorites: SidebarFavorites): SidebarFavorites {
  const normalized = normalizeFavorites(favorites.order, favorites.firstAddedOrder)
  return { ...normalized, order: [...normalized.firstAddedOrder] }
}

export function getSidebarFavoritesStorageKey(userId: string, workspaceId: string) {
  return `atlas.sidebar.favorites.v${sidebarFavoritesStorageVersion}:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`
}
