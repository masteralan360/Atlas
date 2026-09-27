import { describe, expect, it } from 'vitest'

import {
    BARCODE_LABEL_PROFILES,
    formatBarcodeLabelPrice,
    getBarcodeLabelData,
    getBarcodeLabelPricePerUnit,
    getCode128BBarWidths
} from './barcodeLabel'
import type { Product } from '@/local-db'

function product(id: string, sku: string, barcode?: string): Product {
    return {
        id,
        workspaceId: 'workspace-1',
        sku,
        name: sku,
        description: '',
        price: 1234,
        costPrice: 0,
        quantity: 0,
        minStockLevel: 0,
        unit: 'piece',
        currency: 'iqd',
        canBeReturned: true,
        returnRules: '',
        barcode,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        syncStatus: 'synced',
        lastSyncedAt: null,
        version: 1,
        isDeleted: false
    }
}

describe('barcode label data', () => {
    it('keeps products in the supplied selection order', () => {
        const labels = getBarcodeLabelData([
            product('second', 'SKU-2', 'BC-2'),
            product('first', 'SKU-1', 'BC-1')
        ])

        expect(labels.map((label) => label.id)).toEqual(['second', 'first'])
        expect(labels.map((label) => label.productName)).toEqual(['SKU-2', 'SKU-1'])
        expect(labels.map((label) => label.displayValue)).toEqual(['BC-2', 'BC-1'])
        expect(labels.every((label) => label.iqdDisplayPreference === 'IQD')).toBe(true)
    })

    it('falls back to SKU and always produces a complete Code 128 barcode', () => {
        const [label] = getBarcodeLabelData([product('product-1', 'SKU-1')])

        expect(label.barcode).toBe('SKU-1')
        expect(getCode128BBarWidths(label.barcode).length).toBeGreaterThan(0)
        expect(getCode128BBarWidths(label.barcode).every((width) => width > 0)).toBe(true)
    })

    it('uses the workspace IQD suffix preference', () => {
        expect(formatBarcodeLabelPrice(15_000, 'iqd', 'IQD')).toBe('15,000 IQD')
        expect(formatBarcodeLabelPrice(15_000, 'iqd', 'د.ع')).toBe('15,000 د.ع')
    })

    it('adds a fixed one-unit suffix for dynamic-unit products', () => {
        expect(getBarcodeLabelPricePerUnit('m²')).toBe('per 1m²')
        expect(getBarcodeLabelPricePerUnit('Kg')).toBe('per 1 Kg')
        expect(getBarcodeLabelPricePerUnit('Meter')).toBe('per 1 Meter')
        expect(getBarcodeLabelPricePerUnit('kg')).toBe('')
        expect(formatBarcodeLabelPrice(12, 'usd', 'IQD', 'm²')).toBe('12 USD per 1m²')
        expect(formatBarcodeLabelPrice(12, 'usd', 'IQD', 'Meter')).toBe('12 USD per 1 Meter')
    })

    it('supports localized dynamic-unit suffixes on printed labels', () => {
        expect(getBarcodeLabelPricePerUnit('m²', { perSquareMeter: 'لكل 1 م²' })).toBe('لكل 1 م²')
        expect(formatBarcodeLabelPrice(12, 'usd', 'IQD', 'Meter', { perMeter: 'لكل 1 متر' }))
            .toBe('12 USD لكل 1 متر')
    })

    it('defines compact and EML-400I wide label page profiles', () => {
        expect(BARCODE_LABEL_PROFILES.barcode_35x15).toMatchObject({
            widthMm: 35,
            heightMm: 15,
            safeMarginMm: 1.4,
            layout: 'compact'
        })
        expect(BARCODE_LABEL_PROFILES.barcode_108x50).toMatchObject({
            widthMm: 108,
            heightMm: 50,
            safeMarginMm: 3,
            layout: 'wide'
        })
    })
})
