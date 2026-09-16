import { describe, expect, it } from 'vitest'
import { findFittingPrintReferenceCount, formatPrintReferenceList } from './printReferenceList'

const labels = Array.from({ length: 9 }, (_, index) => `SO-2026-000${index}`)
const more = (count: number) => `+${count} More`

describe('compact print reference lists', () => {
  it('keeps the references that fit and counts all remaining references', () => {
    expect(formatPrintReferenceList(labels, 3, more)).toBe('SO-2026-0000 - SO-2026-0001 - SO-2026-0002 - +6 More')
    expect(formatPrintReferenceList(labels, labels.length, more)).toBe(labels.join(' - '))
  })

  it('shows every reference when it fits, even if more than three fit', () => {
    expect(findFittingPrintReferenceCount(labels, () => true, more)).toBe(9)
    const budget = formatPrintReferenceList(labels, 6, more).length
    expect(findFittingPrintReferenceCount(labels, text => text.length <= budget, more)).toBe(6)
  })

  it('reserves space for the overflow label and respects the exact fit boundary', () => {
    const budget = formatPrintReferenceList(labels, 3, more).length
    expect(findFittingPrintReferenceCount(labels, text => text.length <= budget, more)).toBe(3)
    expect(findFittingPrintReferenceCount(labels, text => text.length < budget, more)).toBe(2)
  })

  it('can show the complete list when removing the overflow label makes it fit', () => {
    const shortLabels = ['A', 'B']
    expect(findFittingPrintReferenceCount(shortLabels, text => text.length <= 5, more)).toBe(2)
  })

  it('handles empty, tiny and very long reference lists without creating extra rows', () => {
    expect(findFittingPrintReferenceCount([], () => false, more)).toBe(0)
    expect(formatPrintReferenceList([], 0, more)).toBe('')
    expect(findFittingPrintReferenceCount(labels, text => text.length <= more(9).length, more)).toBe(0)
    expect(formatPrintReferenceList(labels, 0, more)).toBe('+9 More')
    const many = Array.from({ length: 10000 }, (_, index) => `SO-${index}`)
    const limit = formatPrintReferenceList(many, 3, more).length
    const count = findFittingPrintReferenceCount(many, text => text.length <= limit, more)
    expect(count).toBe(3)
    expect(formatPrintReferenceList(many, count, more)).toContain('+9997 More')
  })

  it('normalizes invalid counts, rounds down fractions and supports localized summaries', () => {
    expect(formatPrintReferenceList(labels, -1, more)).toBe('+9 More')
    expect(formatPrintReferenceList(labels, Number.NaN, more)).toBe('+9 More')
    expect(formatPrintReferenceList(labels, 3.9, more)).toBe(formatPrintReferenceList(labels, 3, more))
    expect(formatPrintReferenceList(labels, 99, more)).toBe(labels.join(' - '))
    expect(formatPrintReferenceList(labels, 3, count => `+${count} زیاتر`)).toContain('+6 زیاتر')
  })
})
