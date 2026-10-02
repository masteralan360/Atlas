import { describe, expect, it } from 'vitest'
import { appendInstantPosServiceLine, normalizeInstantPosServiceLines, splitInstantPosServiceLine } from './instantPosServiceLines'

describe('Instant POS service quantity lines', () => {
    it('splits a service quantity into separate unit lines with unique identities', () => {
        let nextId = 0
        const lines = splitInstantPosServiceLine({
            lineId: 'original', productId: 'service-1', name: 'Service 1', quantity: 5, unitPrice: 20,
        }, () => `line-${++nextId}`)

        expect(lines).toHaveLength(5)
        expect(lines.map(({ quantity }) => quantity)).toEqual([1, 1, 1, 1, 1])
        expect(new Set(lines.map(({ lineId }) => lineId)).size).toBe(5)
        expect(lines.map(({ unitPrice }) => unitPrice)).toEqual([20, 20, 20, 20, 20])
    })

    it('appends repeated service additions as distinct quantity-one lines', () => {
        let nextId = 0
        type Service = { productId: string; storageId: string; quantity: number; unitPrice: number; lineId?: string }
        const service: Service = { productId: 'service-1', storageId: 'services', quantity: 99, unitPrice: 20 }
        const lines = Array.from({ length: 5 }).reduce<Service[]>((current) => (
            appendInstantPosServiceLine(current, service, () => `line-${++nextId}`)
        ), [])

        expect(lines.map(({ quantity }) => quantity)).toEqual([1, 1, 1, 1, 1])
        expect(new Set(lines.map(({ lineId }) => lineId)).size).toBe(5)
    })

    it('keeps non-service lines unchanged and preserves legacy fractional service quantity', () => {
        const stockItem = { productId: 'stock-1', storageId: 'storage-1', quantity: 5 }
        const serviceItem = { productId: 'service-1', storageId: 'services', quantity: 2.5 }
        let nextId = 0

        const lines = normalizeInstantPosServiceLines(
            [stockItem, serviceItem],
            (item) => item.storageId === 'services',
            () => `line-${++nextId}`,
        )

        expect(lines[0]).toBe(stockItem)
        expect(lines.slice(1).map(({ quantity }) => quantity)).toEqual([1, 1, 0.5])
    })

    it('is stable when an already split service ticket is normalized again', () => {
        const original = [
            { lineId: 'service-a', productId: 'service-1', storageId: 'services', quantity: 1 },
            { lineId: 'service-b', productId: 'service-1', storageId: 'services', quantity: 1 },
        ]

        expect(normalizeInstantPosServiceLines(original, (item) => item.storageId === 'services', () => 'unexpected'))
            .toEqual(original)
    })

    it('drops invalid service quantities instead of creating unusable ticket rows', () => {
        expect(splitInstantPosServiceLine({ quantity: 0 }, () => 'line')).toEqual([])
        expect(splitInstantPosServiceLine({ quantity: Number.NaN }, () => 'line')).toEqual([])
    })
})
