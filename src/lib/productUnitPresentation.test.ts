import { describe, expect, it } from 'vitest'

import i18n from '@/i18n/config'
import { formatProductQuantity, getProductUnitLabel } from './productUnitPresentation'

describe('product unit presentation', () => {
    it.each([
        ['en', 'Box', 'box'],
        ['ar', 'Box', 'صندوق'],
        ['ku', 'Box', 'سندووق'],
        ['ar', 'Ton', 'طن']
    ])('localizes built-in units case-insensitively in %s', (language, unit, expected) => {
        const t = i18n.getFixedT(language)

        expect(getProductUnitLabel(unit, t)).toBe(expected)
        expect(formatProductQuantity(5, unit, language, t)).toBe(`5 ${expected}`)
    })

    it('keeps custom unit labels unchanged', () => {
        const t = i18n.getFixedT('ar')

        expect(getProductUnitLabel('crate', t)).toBe('crate')
        expect(formatProductQuantity(2, 'crate', 'ar', t)).toBe('2 crate')
    })
})
