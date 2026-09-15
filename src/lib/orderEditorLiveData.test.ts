import { describe, expect, it } from 'vitest'

import {
    getOrderEditorLiveDataProgress,
    getOrderEditorLiveDataSources,
    shouldHydrateOrderEditorLiveData,
    shouldKeepOrderEditorSectionsLoading
} from './orderEditorLiveData'

describe('order editor live-data sources', () => {
    it('keeps the purchase editor focused on its own required data', () => {
        expect(getOrderEditorLiveDataSources({
            kind: 'purchase',
            priceBooksEnabled: false
        })).toEqual([
            'order',
            'businessPartners',
            'products',
            'productBarcodes',
            'storages',
            'units'
        ])
    })

    it('adds only enabled sales capabilities to the initial load', () => {
        expect(getOrderEditorLiveDataSources({
            kind: 'sales',
            priceBooksEnabled: true,
            salesAgentCommissionsEnabled: true,
            agentSalesAccountsEnabled: true
        })).toEqual(expect.arrayContaining([
            'priceBooks',
            'agents',
            'salesOrderAgentAssignments',
            'agentCommissionMemberships',
            'agentCommissionPlans',
            'productCommissionCatalog'
        ]))
    })
})

describe('order editor live-data progress', () => {
    it('rounds and bounds the collective percentage', () => {
        expect(getOrderEditorLiveDataProgress(0, 3)).toBe(0)
        expect(getOrderEditorLiveDataProgress(1, 3)).toBe(33)
        expect(getOrderEditorLiveDataProgress(9, 3)).toBe(100)
        expect(getOrderEditorLiveDataProgress(-1, 3)).toBe(0)
        expect(getOrderEditorLiveDataProgress(0, 0)).toBe(100)
    })

    it('hydrates only existing-order editors', () => {
        expect(shouldHydrateOrderEditorLiveData()).toBe(false)
        expect(shouldHydrateOrderEditorLiveData('sales-order-1')).toBe(true)
    })

    it('keeps completed cards covered until the collective load is ready', () => {
        expect(shouldKeepOrderEditorSectionsLoading('sales-order-1', false, false)).toBe(true)
        expect(shouldKeepOrderEditorSectionsLoading('sales-order-1', true, false)).toBe(false)
        expect(shouldKeepOrderEditorSectionsLoading('sales-order-1', false, true)).toBe(false)
        expect(shouldKeepOrderEditorSectionsLoading(undefined, false, false)).toBe(false)
    })
})
