import { describe, expect, it } from 'vitest'

import { getProductStockPresentation } from './productStockPresentation'

const formatNumber = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 6 }).format(value)
const relatedUnits = {
  factor: 20,
  largerUnitLabel: 'Cartons',
  smallerUnitLabel: 'Sheets',
  conjunction: 'and',
}

describe('product stock presentation', () => {
  it('shows the smaller-unit total when stock has only larger units', () => {
    expect(getProductStockPresentation(100, 'Sheets', relatedUnits, formatNumber)).toEqual({
      label: '5 Cartons',
      smallerUnitTotal: '100 Sheets',
    })
  })

  it('includes the remainder in the smaller-unit total', () => {
    expect(getProductStockPresentation(102, 'Sheets', relatedUnits, formatNumber)).toEqual({
      label: '5 Cartons and 2 Sheets',
      smallerUnitTotal: '102 Sheets',
    })
  })

  it('does not add a tooltip for stock entirely in smaller units or for ordinary products', () => {
    expect(getProductStockPresentation(2, 'Sheets', relatedUnits, formatNumber)).toEqual({
      label: '2 Sheets',
      smallerUnitTotal: null,
    })
    expect(getProductStockPresentation(0, 'Sheets', relatedUnits, formatNumber)).toEqual({
      label: '0 Sheets',
      smallerUnitTotal: null,
    })
    expect(getProductStockPresentation(100, 'Pieces', null, formatNumber)).toEqual({
      label: '100 Pieces',
      smallerUnitTotal: null,
    })
  })

  it('keeps localized number formatting for large and fractional totals', () => {
    expect(getProductStockPresentation(1234.5, 'Sheets', relatedUnits, formatNumber)).toEqual({
      label: '61 Cartons and 14.5 Sheets',
      smallerUnitTotal: '1,234.5 Sheets',
    })
  })
})
