import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const testStorage = vi.hoisted(() => ({
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn()
}))

vi.stubGlobal('localStorage', testStorage)
vi.mock('@/services/platformService', () => ({
    platformService: {
        convertFileSrc: (path: string) => path
    }
}))

import { chunkAtlasStandardTableRows, resolveAtlasStandardTableCapacities } from '@/lib/atlasStandardOrderTablePagination'
import type { Sale } from '@/types'

import {
    createSalesHistoryAtlasStandardReturnPrintData,
    mapSaleToSalesHistoryAtlasStandardOrder,
    SalesHistoryAtlasStandardInvoiceTemplate
} from './SalesHistoryAtlasStandardInvoiceTemplate'

const sale: Sale = {
    id: 'sale-001',
    workspace_id: 'workspace-001',
    cashier_id: 'cashier-001',
    cashier_name: 'Atlas Cashier',
    sequenceId: 42,
    total_amount: 100,
    original_total_amount: 100,
    returned_amount: 25,
    return_status: 'partial',
    settlement_currency: 'usd',
    created_at: '2026-09-05T09:00:00.000Z',
    origin: 'pos',
    payment_method: 'cash',
    notes: 'Sale note',
    items: [{
        id: 'sale-item-001',
        sale_id: 'sale-001',
        product_id: 'product-001',
        product_name: 'Product 10kg',
        product_sku: 'SKU-001',
        quantity: 4,
        unit_price: 25,
        total_price: 100,
        original_currency: 'usd',
        original_unit_price: 25,
        converted_unit_price: 25,
        settlement_currency: 'usd',
        returned_quantity: 1,
        batch_allocations: [{
            batch_id: 'batch-001',
            batch_number: 'BATCH-001',
            quantity: 4
        }]
    }]
}

describe('Sales History Atlas Standard template', () => {
    it('maps sales-native rows without introducing a counterparty', () => {
        const order = mapSaleToSalesHistoryAtlasStandardOrder(sale)

        expect(order).toMatchObject({
            customerId: '',
            customerName: '',
            orderNumber: '#42',
            currency: 'usd',
            paidAmount: 100,
            balanceAmount: 0
        })
        expect(order.items[0]).toMatchObject({
            productName: 'Product 10kg',
            productSku: 'SKU-001',
            returnedQuantity: 1,
            lineTotal: 100
        })
    })

    it('derives a return-only document from line return quantities when return rows are unavailable', () => {
        const data = createSalesHistoryAtlasStandardReturnPrintData(sale)

        expect(data).toMatchObject({
            status: 'partial',
            baseRefundAmount: 25,
            totalRefundAmount: 25,
            lines: [{
                orderItemId: 'sale-item-001',
                returnedQuantity: 1,
                unitRefundAmount: 25,
                refundAmount: 25
            }]
        })
    })

    it('retains the Atlas Standard first and continuation page capacities', () => {
        const capacities = resolveAtlasStandardTableCapacities()
        const chunks = chunkAtlasStandardTableRows(
            Array.from({ length: 49 }, (_, index) => index + 1),
            capacities.firstPageRows,
            capacities.continuationRows
        )

        expect(chunks.map((chunk) => chunk.length)).toEqual([18, 30, 1])
    })

    it('prints the compacted sales header and summary without counterparty or refund fields', () => {
        const html = renderToStaticMarkup(
            <SalesHistoryAtlasStandardInvoiceTemplate
                workspaceName="Atlas"
                printLang="en"
                sale={sale}
            />
        )

        expect(html).toContain('Sale type')
        expect(html).toContain('Sale No.')
        expect(html).toContain('Sale date')
        expect(html).toContain('Time')
        expect(html).toContain('SKU-001')
        expect(html).toContain('Paid total')
        expect(html).toContain('Net total')
        expect(html).toContain('data-atlas-standard-print-footer')
        expect(html).toContain('Made By AtlasERP')
        expect(html).not.toContain('Customer')
        expect(html).not.toContain('Source reference')
        expect(html).not.toContain('Refund status')
        expect(html).not.toContain('Refunded amount')
    })

    it('renders only returned quantities and refund values for the return template', () => {
        const html = renderToStaticMarkup(
            <SalesHistoryAtlasStandardInvoiceTemplate
                workspaceName="Atlas"
                printLang="en"
                sale={sale}
                printVersion="returned"
            />
        )

        expect(html).toContain('Return Invoice')
        expect(html).toContain('Returned Qty')
        expect(html).toContain('Total Refunded')
        expect(html).not.toContain('Paid total')
    })

    it('removes the print metadata footer from the layout when Common edit disables it', () => {
        const html = renderToStaticMarkup(
            <SalesHistoryAtlasStandardInvoiceTemplate
                workspaceName="Atlas"
                printLang="en"
                sale={sale}
                templateFields={{ showPrintFooter: 'false' }}
            />
        )

        expect(html).not.toContain('data-atlas-standard-print-footer')
        expect(html).not.toContain('Made By AtlasERP')
        expect(html).not.toContain('Print date')
    })

    it('applies the effective Common edit header height to the shared layout markers', () => {
        const html = renderToStaticMarkup(
            <SalesHistoryAtlasStandardInvoiceTemplate
                workspaceName="Atlas"
                printLang="en"
                sale={sale}
                templateFields={{ atlasStandardHeaderHeightMm: '42.5' }}
            />
        )

        expect(html).toContain('data-atlas-standard-layout=""')
        expect(html).toContain('data-atlas-standard-header-height-mm="42.5"')
        expect(html).toContain('height:42.5mm')
        expect(html).toContain('data-atlas-standard-content-end=""')
    })
})
