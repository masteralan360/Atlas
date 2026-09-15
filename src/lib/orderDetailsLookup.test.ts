import { describe, expect, it } from 'vitest'
import { resolveOrderDetailsLookupStatus } from './orderDetailsLookup'

describe('resolveOrderDetailsLookupStatus', () => {
    it('keeps the detail page loading until both order types and cloud hydration resolve', () => {
        expect(resolveOrderDetailsLookupStatus({
            salesOrderStatus: 'not-found',
            purchaseOrderStatus: 'loading',
            remoteStatus: 'complete'
        })).toBe('loading')

        expect(resolveOrderDetailsLookupStatus({
            salesOrderStatus: 'not-found',
            purchaseOrderStatus: 'not-found',
            remoteStatus: 'loading'
        })).toBe('loading')
    })

    it('renders either available order immediately', () => {
        expect(resolveOrderDetailsLookupStatus({
            salesOrderStatus: 'found',
            purchaseOrderStatus: 'loading',
            remoteStatus: 'loading'
        })).toBe('found')

        expect(resolveOrderDetailsLookupStatus({
            salesOrderStatus: 'not-found',
            purchaseOrderStatus: 'found',
            remoteStatus: 'complete'
        })).toBe('found')
    })

    it('only shows not found after a completed lookup confirms absence', () => {
        expect(resolveOrderDetailsLookupStatus({
            salesOrderStatus: 'not-found',
            purchaseOrderStatus: 'not-found',
            remoteStatus: 'complete'
        })).toBe('not-found')
    })

    it('distinguishes lookup failures from a missing order', () => {
        expect(resolveOrderDetailsLookupStatus({
            salesOrderStatus: 'not-found',
            purchaseOrderStatus: 'not-found',
            remoteStatus: 'error'
        })).toBe('error')
    })
})
