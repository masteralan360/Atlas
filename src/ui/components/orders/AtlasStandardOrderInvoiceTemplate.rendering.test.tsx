import { isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SalesOrder } from '@/local-db'
import { fitAtlasStandardOrderRows } from '@/lib/atlasStandardOrderTablePagination'

const layout = vi.hoisted(() => ({ fit: null as ReturnType<typeof fitAtlasStandardOrderRows> | null }))
vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
vi.mock('@/local-db', () => ({
    getOrderPaidAmount: (value: SalesOrder) => value.paidAmount,
    getOrderBalanceAmount: (value: SalesOrder) => value.balanceAmount
}))
vi.mock('@/services/platformService', () => ({ platformService: { convertFileSrc: (path: string) => path } }))
vi.mock('@/lib/useAtlasStandardOrderLayout', () => ({
    useAtlasStandardOrderLayout: (enabled: boolean) => ({ pageRef: { current: null }, fit: enabled ? layout.fit : null })
}))
vi.mock('react-i18next', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-i18next')>(),
    useTranslation: () => ({ i18n: { getFixedT: () => (key: string) => key } })
}))

import { AtlasStandardOrderInvoiceTemplate } from './AtlasStandardOrderInvoiceTemplate'

const order = {
    id: 'order-40', currency: 'iqd', createdAt: '2026-09-17T09:00:00Z',
    orderNumber: 'SO-0040', customerName: 'Test customer', status: 'pending',
    total: 800_000, subtotal: 800_000, discount: 0, paidAmount: 0, balanceAmount: 800_000,
    items: Array.from({ length: 40 }, (_, index) => ({
        // Repeated product/line IDs must not become repeated React keys.
        id: `imported-item-${index % 4}`, productId: `product-${index % 4}`,
        productName: `Product ${index + 1}`, quantity: 1, unit: 'pcs',
        convertedUnitPrice: 20_000, lineTotal: 20_000
    }))
} as SalesOrder

function printedRows(smart = true) {
    const element = AtlasStandardOrderInvoiceTemplate({
        order, kind: 'sales', printLang: 'en',
        templateFields: { showPrintFooter: String(!smart), enableTextPositionAnchor: String(!smart) }
    })
    const rows: { index: number; key: string | null }[] = []
    const visit = (node: ReactNode): void => {
        if (Array.isArray(node)) { node.forEach(visit); return }
        if (!isValidElement<{ children?: ReactNode | (() => ReactNode); 'data-atlas-standard-row-index'?: number }>(node)) return
        const index = node.props['data-atlas-standard-row-index']
        if (index !== undefined) rows.push({ index, key: node.key })
        visit(typeof node.props.children === 'function' ? node.props.children() : node.props.children)
    }
    visit(element)
    return rows
}

beforeEach(() => { layout.fit = null })

describe('Atlas Standard 40-row pagination identities', () => {
    it('assigns unique row keys even when historic line IDs repeat', () => {
        layout.fit = fitAtlasStandardOrderRows(Array(40).fill(8), 165, 8)
        const rows = printedRows()
        expect(rows.map((row) => row.index)).toEqual(Array.from({ length: 40 }, (_, index) => index))
        expect(new Set(rows.map((row) => row.key)).size).toBe(40)
    })

    it('retains each row identity when capacity changes or both toggles are restored', () => {
        const normal = printedRows(false)
        for (const availableMm of [165, 145, 104, 201, 0]) {
            layout.fit = fitAtlasStandardOrderRows(Array(40).fill(8), availableMm, 8)
            expect(printedRows()).toEqual(normal)
        }
    })

    it('preserves all 40 rows and their keys when large images require extra continuation pages', () => {
        layout.fit = fitAtlasStandardOrderRows(Array(40).fill(8), 165, 8)
        const initial = printedRows()
        layout.fit = fitAtlasStandardOrderRows(Array(40).fill(17), 165, 17)
        expect(layout.fit.firstPageRows).toBe(9)
        expect(layout.fit.continuationRows).toEqual([14, 14, 3])
        expect(printedRows()).toEqual(initial)
    })
})
