import { describe, expect, it } from 'vitest'
import { getProductSkuFromCameraCapture } from './productSkuCameraScan'

describe('product SKU camera capture', () => {
    it('uses the first readable detected barcode and trims its value', () => {
        expect(getProductSkuFromCameraCapture([
            { rawValue: '   ' },
            { rawValue: '  PRD-001  ' },
            { rawValue: 'PRD-002' }
        ])).toBe('PRD-001')
    })

    it('normalizes Arabic and Eastern Arabic digits for the SKU field', () => {
        expect(getProductSkuFromCameraCapture([{ rawValue: 'SKU-١٢٣٤' }])).toBe('SKU-1234')
        expect(getProductSkuFromCameraCapture([{ rawValue: 'SKU-۱۲۳۴' }])).toBe('SKU-1234')
    })

    it('returns null when the camera has not detected a readable value', () => {
        expect(getProductSkuFromCameraCapture([])).toBeNull()
        expect(getProductSkuFromCameraCapture([{ rawValue: null }, { rawValue: '  ' }])).toBeNull()
    })
})
