import { describe, expect, it } from 'vitest'
import {
  addSidebarFavorite,
  createSidebarFavoritesStorageValue,
  readSidebarFavorites,
  removeSidebarFavorite,
  reorderVisibleSidebarFavorites,
  resetSidebarFavoritesOrder
} from './sidebarFavorites'

describe('sidebar favorites', () => {
  it('keeps first-added order and makes a re-added module newest', () => {
    const first = addSidebarFavorite(addSidebarFavorite({ order: [], firstAddedOrder: [] }, '/products'), '/stock-adjustments')
    expect(removeSidebarFavorite(first, '/products')).toEqual({
      order: ['/stock-adjustments'],
      firstAddedOrder: ['/stock-adjustments']
    })
    expect(addSidebarFavorite(removeSidebarFavorite(first, '/products'), '/products')).toEqual({
      order: ['/stock-adjustments', '/products'],
      firstAddedOrder: ['/stock-adjustments', '/products']
    })
  })

  it('keeps unavailable entries while reordering visible favorites', () => {
    expect(
      reorderVisibleSidebarFavorites(
        { order: ['/products', '/hidden', '/stock-adjustments'], firstAddedOrder: ['/products', '/hidden', '/stock-adjustments'] },
        ['/products', '/stock-adjustments'],
        1,
        0
      )
    ).toEqual({
      order: ['/stock-adjustments', '/hidden', '/products'],
      firstAddedOrder: ['/products', '/hidden', '/stock-adjustments']
    })
  })

  it('resets a customized order to first-added order', () => {
    expect(
      resetSidebarFavoritesOrder({
        order: ['/stock-adjustments', '/products'],
        firstAddedOrder: ['/products', '/stock-adjustments']
      })
    ).toEqual({ order: ['/products', '/stock-adjustments'], firstAddedOrder: ['/products', '/stock-adjustments'] })
  })

  it('stores versioned, normalized favorite data and safely rejects malformed storage', () => {
    expect(
      readSidebarFavorites(
        createSidebarFavoritesStorageValue({
          order: ['/stock-adjustments', '/products', '/products'],
          firstAddedOrder: ['/products', 'not-a-path', '/stock-adjustments']
        })
      )
    ).toEqual({
      order: ['/stock-adjustments', '/products'],
      firstAddedOrder: ['/products', '/stock-adjustments']
    })
    expect(readSidebarFavorites('{not json')).toEqual({ order: [], firstAddedOrder: [] })
  })
})
