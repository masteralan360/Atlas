import { describe, expect, it } from 'vitest'

import { generateBarcodeLabelsPdf } from './barcodeLabelPdf'
import { getBarcodeLabelProfile } from '@/lib/barcodeLabel'

const labels = [
    { id: 'first', productName: 'First product', barcode: 'WE54070882', displayValue: 'WE54070882', price: 1234, currency: 'iqd', unit: 'pcs', iqdDisplayPreference: 'IQD' as const },
    { id: 'second', productName: 'Second product', barcode: 'WE54070883', displayValue: 'WE54070883', price: 99, currency: 'usd', unit: 'pcs', iqdDisplayPreference: 'IQD' as const }
]

function getFirstPageSizeMm(pdfText: string) {
    const mediaBox = pdfText.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/)
    expect(mediaBox).not.toBeNull()
    return [Number(mediaBox?.[1]) * 25.4 / 72, Number(mediaBox?.[2]) * 25.4 / 72]
}

describe('barcode label PDF', () => {
    it('creates one 35 × 15 mm PDF page for each label in its input order', async () => {
        const pdf = await generateBarcodeLabelsPdf({ labels })
        const pdfText = await pdf.text()

        expect(pdf.type).toBe('application/pdf')
        expect(getFirstPageSizeMm(pdfText)).toEqual([35, 15])
        expect(pdfText).toContain('WE54070882')
        expect(pdfText).toContain('WE54070883')
        expect(pdfText.indexOf('WE54070882')).toBeLessThan(pdfText.indexOf('WE54070883'))
        expect((pdfText.match(/\/Type \/Page\b/g) || []).length).toBe(2)
    })

    it('creates one 108 × 50 mm wide label page per selected product', async () => {
        const pdf = await generateBarcodeLabelsPdf({
            labels,
            profile: getBarcodeLabelProfile('barcode_108x50'),
            priceLabel: 'Price'
        })
        const pdfText = await pdf.text()

        expect(pdf.type).toBe('application/pdf')
        expect(getFirstPageSizeMm(pdfText)).toEqual([108, 50])
        expect((pdfText.match(/\/Type \/Page\b/g) || []).length).toBe(2)
        expect(pdfText).toContain('First product')
        expect(pdfText).toContain('WE54070882')
        expect(pdfText.indexOf('WE54070882')).toBeLessThan(pdfText.indexOf('WE54070883'))
    })

    it('keeps product name and barcode while omitting price on a wide label', async () => {
        const pdf = await generateBarcodeLabelsPdf({
            labels: [labels[0]],
            profile: getBarcodeLabelProfile('barcode_108x50'),
            showPrice: false
        })
        const pdfText = await pdf.text()

        expect(pdfText).not.toContain('Price')
        expect(pdfText).not.toContain('1,234 IQD')
        expect(pdfText).toContain('First product')
        expect(pdfText).toContain('WE54070882')
    })

    it('omits both price strings when the price control is disabled', async () => {
        const pdf = await generateBarcodeLabelsPdf({ labels, showPrice: false })
        const pdfText = await pdf.text()

        expect(pdfText).not.toContain('Price')
        expect(pdfText).not.toContain('1,234 IQD')
        expect(pdfText).toContain('WE54070882')
    })

    it('uses the supplied localized price label and unit suffix', async () => {
        const pdf = await generateBarcodeLabelsPdf({
            labels: [{ ...labels[0], unit: 'Meter' }],
            profile: getBarcodeLabelProfile('barcode_108x50'),
            priceLabel: 'Unit price',
            pricePerUnitTranslations: { perMeter: 'per 1 linear meter' }
        })
        const pdfText = await pdf.text()

        expect(pdfText).toContain('Unit price')
        expect(pdfText).toContain('per 1 linear meter')
    })
})
