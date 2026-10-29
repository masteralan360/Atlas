import { describe, expect, it } from 'vitest'
import { getCartInventoryQuantity } from '@/lib/productUoms'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { formatStockReservationQuantity, getSellableStockQuantity } from './stockReservationPresentation'

const format = (quantity: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 6 }).format(quantity)
const carton = { label: 'cartons', factor: 20 }
const present = (quantity: number) => formatStockReservationQuantity(quantity, 'pieces', carton, format, 'and')

describe('reservation quantities in selling screens', () => {
  it('shows the free whole cartons, remainder and canonical total without promising fractional cartons', () => {
    // 100 physical pieces minus 70 reserved leaves 30 pieces, rather than 30 cartons.
    expect(present(30)).toBe('1 cartons and 10 pieces (30 pieces)')
    expect(getSellableStockQuantity(30, 0, 20, false)).toBe(1)
    expect(present(10)).toBe('10 pieces')
    expect(getSellableStockQuantity(10, 0, 20, false)).toBe(0)
  })

  it('deducts mixed-unit cart lines and free bonus stock before converting the catalog badge', () => {
    const cartonLine = { quantity: 2, freeBonusQuantity: 1, unit_factor: 20 }
    const pieceLine = { quantity: 5, unit_factor: 1 }
    const inCart = getCartInventoryQuantity(cartonLine) + getCartInventoryQuantity(pieceLine)
    expect(inCart).toBe(65)
    expect(getSellableStockQuantity(100, inCart, 20, false)).toBe(1)
    expect(present(100 - inCart)).toBe('1 cartons and 15 pieces (35 pieces)')
  })

  it('retains fractional availability for dynamic measures and rounds at inventory precision', () => {
    expect(getSellableStockQuantity(1500, 250, 1000, true)).toBe(1.25)
    expect(formatStockReservationQuantity(1250, 'g', { label: 'kg', factor: 1000, isDynamic: true }, format, 'and'))
      .toBe('1.25 kg (1,250 g)')
    expect(getSellableStockQuantity(0.3, 0.1, 0.1, false)).toBe(2)
    expect(getSellableStockQuantity(19.999999, 0, 20, false)).toBe(0)
  })

  it('keeps the saved order/cart factor when the product configuration changes', () => {
    const line = { quantity: 2, freeBonusQuantity: 1, unitFactor: 20, inventoryQuantity: 40, freeBonusInventoryQuantity: 20 }
    const demand = getOrderLineInventoryQuantity(line)
    expect(demand).toBe(60)
    expect(formatStockReservationQuantity(demand, 'pieces', { label: 'saved cartons', factor: line.unitFactor }, format, 'and'))
      .toBe('3 saved cartons (60 pieces)')
    // A current catalog coefficient must not replace the saved factor in a historical line.
    expect(getSellableStockQuantity(100, demand, 24, false)).toBe(1)
  })

  it('supports units smaller than the base unit without applying the coefficient twice', () => {
    expect(getSellableStockQuantity(1.25, 0.25, 0.01, true)).toBe(100)
    expect(formatStockReservationQuantity(1.25, 'm', { label: 'cm', factor: 0.01, isDynamic: true }, format, 'and'))
      .toBe('125 cm (1.25 m)')
  })

  it('labels base-only quantities and safely falls back from invalid factors', () => {
    expect(formatStockReservationQuantity(2500, 'pieces', undefined, format, 'and')).toBe('2,500 pieces')
    expect(formatStockReservationQuantity(25, 'pieces', { label: 'cartons', factor: 0 }, format, 'and')).toBe('25 pieces')
    expect(getSellableStockQuantity(30, 40, 20, false)).toBe(0)
    expect(getSellableStockQuantity(30, 0, Number.NaN, false)).toBe(30)
  })

  it.each(['ar', 'ku'])('uses localized numbers and retained custom-unit labels in %s', language => {
    const number = new Intl.NumberFormat(language, { maximumFractionDigits: 6 })
    expect(formatStockReservationQuantity(2500, 'custom pieces', { label: 'custom packs', factor: 20 }, n => number.format(n), '&'))
      .toBe(`${number.format(125)} custom packs (${number.format(2500)} custom pieces)`)
  })
})
