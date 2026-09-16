import { afterEach, describe, expect, it, vi } from 'vitest'
import { fitPrintReferenceLists, findFittingPrintReferenceCount, formatPrintReferenceList } from './printReferenceList'

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

describe('batched print reference measurements', () => {
  afterEach(() => vi.unstubAllGlobals())

  function referenceRow(values: string[], budget: number, events: string[], id: string) {
    const probe = {
      style: {}, textContent: '', removeAttribute: vi.fn(), remove: vi.fn(),
      getBoundingClientRect() {
        events.push(`measure:${id}`)
        return { height: this.textContent.length <= budget ? 30 : 31 }
      },
    }
    let textContent = ''
    return {
      dataset: { printReferenceList: JSON.stringify(values), printMoreLabel: '+{count} More' },
      lang: 'en',
      getBoundingClientRect: () => { events.push(`bounds:${id}`); return { width: 120 } },
      closest: () => null,
      cloneNode: () => probe,
      appendChild: () => { events.push(`append:${id}`) },
      get textContent() { return textContent },
      set textContent(value: string) { events.push(`commit:${id}`); textContent = value },
      probe,
    }
  }

  it('preserves scalar fitting results while reading all row bounds before inserting probes', () => {
    const events: string[] = []
    const rows = [referenceRow(labels, formatPrintReferenceList(labels, 3, more).length, events, 'a'),
      referenceRow(['A', 'B'], 5, events, 'b'), referenceRow([], 0, events, 'c')]
    vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '10px', fontSize: '9px' }))
    fitPrintReferenceLists({ querySelectorAll: () => rows } as unknown as HTMLElement)
    expect(events.slice(0, 6)).toEqual(['bounds:a', 'bounds:b', 'bounds:c', 'append:a', 'append:b', 'append:c'])
    expect(rows.map(row => row.textContent)).toEqual([formatPrintReferenceList(labels, 3, more), 'A - B', ''])
    expect(events.findIndex(event => event.startsWith('commit:'))).toBeGreaterThan(events.lastIndexOf('measure:a'))
    rows.forEach(row => expect(row.probe.remove).toHaveBeenCalled())
  })

  it('removes every probe when one measurement fails', () => {
    const rows = [referenceRow(labels, 1, [], 'a'), referenceRow(labels, 1, [], 'b')]
    rows[1].probe.getBoundingClientRect = () => { throw new Error('layout failed') }
    vi.stubGlobal('getComputedStyle', () => ({ lineHeight: '10px', fontSize: '9px' }))
    expect(() => fitPrintReferenceLists({ querySelectorAll: () => rows } as unknown as HTMLElement)).toThrow('layout failed')
    rows.forEach(row => expect(row.probe.remove).toHaveBeenCalled())
    expect(rows[0].textContent).toBe('')
  })
})
