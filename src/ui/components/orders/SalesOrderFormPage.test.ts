import { describe, expect, it } from 'vitest'

import {
    buildSalesOrderLineId,
    clearSalesItemProductForServicesStorage,
    getPersistedSalesOrderItemStorageId,
    getSalesOrderFormItemStorageId
} from '@/lib/salesOrderLineStorage'
import {
    appendSalesOrderLineDraft,
    getSalesOrderLineIdForSave,
    getSalesOrderLineSequence,
    getSalesOrderLinesNewestFirst,
    removeSalesOrderLineDraft,
    shouldInitializeSalesOrderDraft,
    updateSalesOrderLineDraft
} from '@/lib/salesOrderLineDraft'

describe('clearSalesItemProductForServicesStorage', () => {
    it('keeps otherwise-identical product lines separately addressable', () => {
        const line = {
            productId: 'product-1',
            storageId: 'storage-1',
            batchId: '',
            unitRef: 'builtin:carton',
            quantity: 2,
            freeBonusQuantity: 0,
            unitPrice: 40_000,
            seq: 1
        }

        expect(buildSalesOrderLineId(line)).not.toBe(buildSalesOrderLineId({ ...line, seq: 2 }))
    })

    it('clears the selected product and selling-price fields while preserving the rest of the line', () => {
        const line = {
            seq: 3,
            productId: 'product-1',
            productSearch: 'Premium product',
            storageId: '__atlas_services__',
            quantity: '2',
            freeBonusQuantity: '1',
            freeBonusUnit: 'box',
            unitPrice: '125000',
            batchId: 'batch-1',
            priceBookId: 'price-book-1',
            priceBookItemId: 'price-book-item-1',
            priceSourceCurrency: 'USD',
            priceBookCostPrice: '75',
            note: 'Keep this note'
        }
        const cleared = clearSalesItemProductForServicesStorage(line)

        expect(cleared).toMatchObject({
            seq: 3,
            storageId: '__atlas_services__',
            quantity: '2',
            note: 'Keep this note',
            productId: '',
            productSearch: '',
            unitPrice: '',
            batchId: '',
            priceBookId: '',
            priceBookItemId: '',
            priceSourceCurrency: '',
            priceBookCostPrice: '',
            unitRef: '',
            uomId: '',
            uomNameSnapshot: '',
            unitFactor: '',
            baseUnitRef: '',
            baseUnitCode: '',
            unitNameSnapshot: '',
            baseUnitNameSnapshot: '',
            freeBonusQuantity: '',
            freeBonusUnit: ''
        })
    })

    it('keeps the Services location in the form but never in the saved order line', () => {
        const service = { isService: true }

        expect(getSalesOrderFormItemStorageId(service, null, 'storage-1')).toBe('__atlas_services__')
        expect(getPersistedSalesOrderItemStorageId(service, '__atlas_services__')).toBeNull()
        expect(getPersistedSalesOrderItemStorageId({ isService: false }, 'storage-1')).toBe('storage-1')
    })
})

describe('sales order line draft state', () => {
    type DraftLine = { clientId: string; seq: number; productId: string; quantity: string }

    const existingLines: DraftLine[] = Array.from({ length: 8 }, (_, index) => ({
        clientId: `persisted-${index + 1}`,
        seq: index + 1,
        productId: `product-${index + 1}`,
        quantity: '1'
    }))

    it('keeps appended lines in draft state and displays the newest lines first', () => {
        const withNinth = appendSalesOrderLineDraft(existingLines, (seq) => ({
            clientId: 'temporary-9', seq, productId: '', quantity: '1'
        }))
        const withTenth = appendSalesOrderLineDraft(withNinth, (seq) => ({
            clientId: 'temporary-10', seq, productId: '', quantity: '1'
        }))

        expect(withTenth).toHaveLength(10)
        expect(getSalesOrderLinesNewestFirst(withTenth).slice(0, 3).map((line) => line.clientId))
            .toEqual(['temporary-10', 'temporary-9', 'persisted-8'])
        expect(withTenth.map((line) => line.clientId).slice(-2))
            .toEqual(['temporary-9', 'temporary-10'])
    })

    it.each([1, 8, 20])('adds a visible newest line to an order with %i existing lines', (count) => {
        const lines: DraftLine[] = Array.from({ length: count }, (_, index) => ({
            clientId: `persisted-${index + 1}`,
            seq: index + 1,
            productId: `product-${index + 1}`,
            quantity: '1'
        }))
        const next = appendSalesOrderLineDraft(lines, (seq) => ({
            clientId: 'new-line', seq, productId: '', quantity: '1'
        }))

        expect(next).toHaveLength(count + 1)
        expect(getSalesOrderLinesNewestFirst(next)[0]).toMatchObject({ clientId: 'new-line', seq: count + 1 })
    })

    it('updates and removes only the selected stable line identity without changing order', () => {
        const withNewLine = appendSalesOrderLineDraft(existingLines, (seq) => ({
            clientId: 'temporary-9', seq, productId: '', quantity: '1'
        }))
        const updatedExisting = updateSalesOrderLineDraft(withNewLine, 'persisted-4', () => ({ quantity: '3' }))
        const updated = updateSalesOrderLineDraft(withNewLine, 'temporary-9', () => ({
            productId: 'selected-product', quantity: '4'
        }))
        const withoutNewLine = removeSalesOrderLineDraft(updated, 'temporary-9')

        expect(updatedExisting.map((line) => line.clientId)).toEqual(withNewLine.map((line) => line.clientId))
        expect(updatedExisting.find((line) => line.clientId === 'persisted-4')?.quantity).toBe('3')
        expect(updatedExisting.find((line) => line.clientId === 'persisted-3')?.quantity).toBe('1')
        expect(updated.find((line) => line.clientId === 'temporary-9')).toMatchObject({
            seq: 9,
            productId: 'selected-product',
            quantity: '4'
        })
        expect(withoutNewLine.map((line) => line.clientId))
            .toEqual(existingLines.map((line) => line.clientId))
        expect(updateSalesOrderLineDraft(updated, 'missing-id', () => ({ quantity: '0' }))).toBe(updated)
    })

    it('recovers insertion sequence from persisted IDs and ignores same-order refetches for draft initialization', () => {
        const persistedId = buildSalesOrderLineId({
            productId: 'product-1', storageId: 'storage-1', batchId: '', unitRef: 'builtin:pcs',
            quantity: 1, freeBonusQuantity: 0, unitPrice: 100, seq: 8
        })

        expect(getSalesOrderLineSequence(persistedId, 1)).toBe(8)
        expect(getSalesOrderLineIdForSave(persistedId, () => 'regenerated-id')).toBe(persistedId)
        expect(getSalesOrderLineIdForSave(undefined, () => 'new-line-id')).toBe('new-line-id')
        expect(getSalesOrderLineSequence('legacy-imported-line-id', 3)).toBe(3)
        expect(shouldInitializeSalesOrderDraft('order-1', 'order-1')).toBe(false)
        expect(shouldInitializeSalesOrderDraft('order-1', 'order-2')).toBe(true)
        expect(shouldInitializeSalesOrderDraft(null, undefined)).toBe(false)
    })

    it('reopens saved lines in insertion order even when the stored array has legacy display order', () => {
        const sequences = [9, 1, 2, 3, 4, 5, 6, 7, 8]
        const persisted = sequences.map((seq, index) => {
            const id = buildSalesOrderLineId({
                productId: `product-${index + 1}`, storageId: 'storage-1', batchId: '', unitRef: 'builtin:pcs',
                quantity: 1, freeBonusQuantity: 0, unitPrice: 100, seq
            })
            return { clientId: `persisted:${id}`, seq: getSalesOrderLineSequence(id, index + 1) }
        })

        expect(getSalesOrderLinesNewestFirst(persisted).map((line) => line.seq))
            .toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1])

        const withTenth = appendSalesOrderLineDraft(persisted, (seq) => {
            const id = buildSalesOrderLineId({
                productId: 'product-10', storageId: 'storage-1', batchId: '', unitRef: 'builtin:pcs',
                quantity: 1, freeBonusQuantity: 0, unitPrice: 100, seq
            })
            return { clientId: `persisted:${id}`, seq }
        })
        const reopened = withTenth.map((line, index) => ({
            ...line,
            seq: getSalesOrderLineSequence(line.clientId.replace(/^persisted:/, ''), index + 1)
        }))
        expect(getSalesOrderLinesNewestFirst(reopened).map((line) => line.seq))
            .toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    })
})
