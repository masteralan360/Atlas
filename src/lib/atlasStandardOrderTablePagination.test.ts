import { describe, expect, it } from 'vitest'

import {
    ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM,
    getAtlasStandardFirstPageFillerRowCount
} from '@/lib/atlasStandardOrderTablePagination'

describe('Atlas Standard first-page filler rows', () => {
    it('does not render a partial row when the remaining space is smaller than one row', () => {
        expect(getAtlasStandardFirstPageFillerRowCount(
            ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM,
            18,
            8
        )).toBe(0)
    })

    it('renders only complete empty rows and leaves any fractional remainder blank', () => {
        expect(getAtlasStandardFirstPageFillerRowCount(
            ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM,
            16,
            8
        )).toBe(2)
        expect(getAtlasStandardFirstPageFillerRowCount(145, 17, 8)).toBe(1)
    })
})
