import { describe, expect, it } from 'vitest'
import {
  createSidebarSectionOrderStorageValue,
  readSidebarSectionOrder,
  reconcileSidebarSectionOrder,
  reorderVisibleSidebarSections
} from './sidebarSectionOrder'

describe('sidebar section order', () => {
  it('keeps a valid custom order and appends new canonical groups', () => {
    expect(
      reconcileSidebarSectionOrder(['cash-and-control', 'sell-and-serve'], [
        'sell-and-serve',
        'stock-and-supply',
        'cash-and-control'
      ])
    ).toEqual(['cash-and-control', 'sell-and-serve', 'stock-and-supply'])
  })

  it('removes duplicate and obsolete saved keys safely', () => {
    expect(
      reconcileSidebarSectionOrder(['cash-and-control', 'obsolete', 'cash-and-control'], [
        'sell-and-serve',
        'cash-and-control'
      ])
    ).toEqual(['cash-and-control', 'sell-and-serve'])
  })

  it('falls back to the canonical order when storage is malformed or outdated', () => {
    expect(readSidebarSectionOrder('{not json')).toEqual([
      'sell-and-serve',
      'stock-and-supply',
      'cash-and-control',
      'real-estate',
      'currency-exchange',
      'manual-entry',
      'clinic-service',
      'agents',
      'partners-and-demand',
      'insights-and-trends',
      'people-and-workspace',
      'global'
    ])
    expect(readSidebarSectionOrder(JSON.stringify({ version: 0, sectionOrder: ['cash-and-control'] }))).toEqual([
      'sell-and-serve',
      'stock-and-supply',
      'cash-and-control',
      'real-estate',
      'currency-exchange',
      'manual-entry',
      'clinic-service',
      'agents',
      'partners-and-demand',
      'insights-and-trends',
      'people-and-workspace',
      'global'
    ])
  })

  it('stores a versioned preference', () => {
    expect(readSidebarSectionOrder(createSidebarSectionOrderStorageValue(['cash-and-control', 'sell-and-serve']))).toEqual([
      'cash-and-control',
      'sell-and-serve',
      'stock-and-supply',
      'real-estate',
      'currency-exchange',
      'manual-entry',
      'clinic-service',
      'agents',
      'partners-and-demand',
      'insights-and-trends',
      'people-and-workspace',
      'global'
    ])
  })

  it('moves visible sections without discarding a hidden section position', () => {
    expect(
      reorderVisibleSidebarSections(
        ['sell-and-serve', 'stock-and-supply', 'cash-and-control'],
        ['sell-and-serve', 'cash-and-control'],
        1,
        0
      )
    ).toEqual(['cash-and-control', 'stock-and-supply', 'sell-and-serve'])
  })
})
