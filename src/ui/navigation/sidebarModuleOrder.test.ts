import { describe, expect, it } from 'vitest'
import {
  createSidebarModuleOrderStorageValue,
  readSidebarModuleOrder,
  reconcileSidebarModuleOrder,
  reorderVisibleSidebarModuleItems
} from './sidebarModuleOrder'

describe('sidebar module order', () => {
  it('keeps saved module positions and appends newly visible modules', () => {
    expect(
      reconcileSidebarModuleOrder(['/stock-adjustments', '/products'], ['/products', '/services', '/stock-adjustments'])
    ).toEqual(['/stock-adjustments', '/products', '/services'])
  })

  it('retains unavailable module positions while moving visible modules', () => {
    expect(
      reorderVisibleSidebarModuleItems(
        ['/products', '/services', '/stock-adjustments'],
        ['/products', '/stock-adjustments'],
        1,
        0
      )
    ).toEqual(['/stock-adjustments', '/services', '/products'])
  })

  it('stores a versioned per-section order and ignores malformed entries', () => {
    expect(
      readSidebarModuleOrder(
        createSidebarModuleOrderStorageValue({
          'stock-and-supply': ['/stock-adjustments', '/products'],
          'sell-and-serve': ['not-a-path', '/pos', '/pos']
        })
      )
    ).toEqual({
      'sell-and-serve': ['/pos'],
      'stock-and-supply': ['/stock-adjustments', '/products']
    })
  })

  it('falls back safely when storage is malformed or outdated', () => {
    expect(readSidebarModuleOrder('{not json')).toEqual({})
    expect(readSidebarModuleOrder(JSON.stringify({ version: 0, moduleOrderBySection: {} }))).toEqual({})
  })
})
