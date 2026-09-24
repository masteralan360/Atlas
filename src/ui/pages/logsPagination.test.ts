import { describe, expect, it } from 'vitest'

import { getLogsPageSize, paginateLogRecords } from './logsPagination'

describe('logs pagination', () => {
    const records = Array.from({ length: 23 }, (_, index) => index + 1)

    it('shows the selected number of rows and the remaining last page', () => {
        expect(paginateLogRecords(records, 1, 10)).toEqual({
            currentPage: 1,
            records: records.slice(0, 10),
        })
        expect(paginateLogRecords(records, 3, 10)).toEqual({
            currentPage: 3,
            records: records.slice(20),
        })
    })

    it('clamps a page when filtering or refreshing reduces the result count', () => {
        expect(paginateLogRecords(records.slice(0, 11), 3, 10)).toEqual({
            currentPage: 2,
            records: [11],
        })
        expect(paginateLogRecords([], 3, 10)).toEqual({ currentPage: 1, records: [] })
        expect(paginateLogRecords(records, 0, 10).currentPage).toBe(1)
    })

    it('accepts only the app rows-per-page choices from storage', () => {
        expect(getLogsPageSize('50')).toBe(50)
        expect(getLogsPageSize(null)).toBe(20)
        expect(getLogsPageSize('0')).toBe(20)
        expect(getLogsPageSize('not-a-number')).toBe(20)
    })
})
