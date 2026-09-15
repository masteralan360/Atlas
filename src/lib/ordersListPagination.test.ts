import { describe, expect, it } from 'vitest'
import {
    clampOrdersPagination,
    createOrdersPaginationState,
    paginateOrders,
    resetOrdersPagination,
    setOrdersPage,
    setOrdersPageSize
} from './ordersListPagination'

describe('Orders list pagination', () => {
    const rows = Array.from({ length: 23 }, (_, index) => `order-${index + 1}`)

    it('uses the persisted page size when it is a supported option', () => {
        expect(createOrdersPaginationState('50')).toEqual({ currentPage: 1, pageSize: 50 })
        expect(createOrdersPaginationState('7')).toEqual({ currentPage: 1, pageSize: 20 })
        expect(createOrdersPaginationState(null)).toEqual({ currentPage: 1, pageSize: 20 })
    })

    it('returns the correct rows at page boundaries', () => {
        const state = setOrdersPage({ currentPage: 1, pageSize: 10 }, 3)

        expect(paginateOrders(rows, state)).toEqual({
            currentPage: 3,
            totalPages: 3,
            rows: ['order-21', 'order-22', 'order-23']
        })
    })

    it('resets to the first page when filters, tabs, or page size change', () => {
        const onThirdPage = { currentPage: 3, pageSize: 10 }

        expect(resetOrdersPagination(onThirdPage)).toEqual({ currentPage: 1, pageSize: 10 })
        expect(setOrdersPageSize(onThirdPage, 50)).toEqual({ currentPage: 1, pageSize: 50 })
    })

    it('clamps a page that becomes invalid after filtering shrinks the result set', () => {
        const state = { currentPage: 3, pageSize: 10 }

        expect(clampOrdersPagination(state, 6)).toEqual({ currentPage: 1, pageSize: 10 })
        expect(paginateOrders(rows.slice(0, 6), state)).toEqual({
            currentPage: 1,
            totalPages: 1,
            rows: rows.slice(0, 6)
        })
    })
})
