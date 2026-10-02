import { describe, expect, it } from 'vitest'
import { addInstantPosServiceItem, coalesceInstantPosServiceItems } from './instantPosServiceItems'

describe('Instant POS service ticket lines', () => {
    it('adds repeated services to one line and increases its quantity', () => {
        const service = { productId: 'service-1', storageId: 'services', quantity: 1, unitPrice: 15000 }
        const items = Array.from({ length: 5 }).reduce<typeof service[]>(
            (current) => addInstantPosServiceItem(current, service),
            [],
        )

        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({ productId: 'service-1', quantity: 5, unitPrice: 15000 })
    })

    it('coalesces legacy duplicate service rows despite different UoM snapshots and keeps stock rows distinct', () => {
        const service1 = { productId: 'service-1', storageId: 'services', uomId: 'legacy-base:service-1', quantity: 1 }
        const service2 = { productId: 'service-1', storageId: 'services', quantity: 1 }
        const stock1 = { productId: 'stock-1', storageId: 'store-a', quantity: 1 }
        const stock2 = { productId: 'stock-1', storageId: 'store-a', quantity: 1 }

        const items = coalesceInstantPosServiceItems(
            [service1, stock1, service2, stock2],
            (item) => item.storageId === 'services',
        )

        expect(items).toHaveLength(3)
        expect(items[0]).toMatchObject({ productId: 'service-1', quantity: 2, uomId: undefined })
        expect(items.filter((item) => item.productId === 'stock-1')).toHaveLength(2)
    })

    it('preserves distinct service notes when merging duplicate ticket rows', () => {
        const items = coalesceInstantPosServiceItems(
            [
                { productId: 'service-1', quantity: 1, note: 'First request' },
                { productId: 'service-1', quantity: 1, note: 'Second request' },
            ],
            () => true,
        )

        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({ quantity: 2, note: 'First request\nSecond request' })
    })

    it('preserves fractional service quantities when merging duplicate rows', () => {
        const items = coalesceInstantPosServiceItems(
            [
                { productId: 'service-1', quantity: 0.1 },
                { productId: 'service-1', quantity: 0.2 },
            ],
            () => true,
        )

        expect(items).toHaveLength(1)
        expect(items[0].quantity).toBeCloseTo(0.3, 10)
    })
})
