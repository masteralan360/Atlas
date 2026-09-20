import { Sale, SaleItem, UniversalInvoice, UniversalInvoiceItem } from '@/types'
import { salesExchangeRowsToSnapshots } from '@/lib/salesExchange'

type A4Variant = 'standard' | 'refund'

interface MapSaleToUniversalOptions {
    a4Variant?: A4Variant
}

function hasAnyReturnActivity(sale: Sale): boolean {
    if (sale.is_returned) return true
    const items = sale.items || []
    return items.some(item => item.is_returned || (item.returned_quantity || 0) > 0)
}

function getBaseItem(item: SaleItem): UniversalInvoiceItem {
    const quantity = Number(item.quantity) || 0
    const unitPrice = item.converted_unit_price || item.unit_price || 0
    const baseTotal = unitPrice * quantity

    return {
        product_id: item.product_id,
        product_name: item.product_name || 'Unknown Product',
        product_sku: item.product_sku,
        unit: item.selling_unit_code || item.product?.unit || (item as any).product_unit || '',
        quantity,
        unit_price: unitPrice,
        // Keep total_price in settlement currency.
        total_price: baseTotal,
        original_unit_price: item.original_unit_price,
        original_currency: item.original_currency,
        settlement_currency: item.settlement_currency,
        discount_amount: (item.original_unit_price && item.negotiated_price)
            ? (unitPrice / (item.negotiated_price / item.original_unit_price) - unitPrice)
            : 0
    }
}

function getRefundStatus(refundedQuantity: number, activeQuantity: number): UniversalInvoiceItem['refund_status'] {
    if (refundedQuantity <= 0) return 'not_refunded'
    if (activeQuantity <= 0) return 'fully_refunded'
    return 'partially_refunded'
}

function resolveSaleReturnReason(sale: Sale): string | undefined {
    if (sale.return_reason) return sale.return_reason
    const firstItemReason = (sale.items || []).map(item => item.return_reason).find(Boolean)
    return firstItemReason || undefined
}

function resolveSaleReturnedAt(sale: Sale): string | undefined {
    if (sale.returned_at) return sale.returned_at
    const latestItemReturn = (sale.items || [])
        .map(item => item.returned_at)
        .filter((value): value is string => !!value)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
    return latestItemReturn || undefined
}

export function mapSaleToUniversal(sale: Sale, options: MapSaleToUniversalOptions = {}): UniversalInvoice {
    const sequenceId = sale.sequenceId ? String(sale.sequenceId).padStart(5, '0') : sale.id.slice(0, 8)
    const saleItems = sale.items || []
    const baseItems = saleItems.map(getBaseItem)
    const hasReturnActivity = hasAnyReturnActivity(sale)
    const shouldBuildRefundInvoice = options.a4Variant === 'refund' && hasReturnActivity
    const exchangeRates = sale.exchange_rates?.length
        ? sale.exchange_rates
        : salesExchangeRowsToSnapshots(sale.sales_exchange)

    const baseInvoice: UniversalInvoice = {
        id: sale.id,
        sequenceId: sale.sequenceId,
        invoiceid: `#${sequenceId}`,
        created_at: sale.created_at,
        workspaceId: sale.workspace_id,
        cashier_name: sale.cashier_name,
        total_amount: sale.total_amount,
        settlement_currency: sale.settlement_currency || 'usd',
        payment_method: sale.payment_method,
        exchange_rates: exchangeRates.length > 0 ? exchangeRates : null,
        exchange_rate: null,
        exchange_source: null,
        exchange_rate_timestamp: null,
        origin: sale.origin || 'pos',
        items: baseItems,
        status: 'paid',
        customer_id: (sale as any).customerId || (sale as any).customer_id || '',
        order_id: (sale as any).orderId || (sale as any).order_id || '',
        table_number: (sale as any).table_number
            ?? (sale as any).instant_table_number
            ?? (sale as any).tableNumber
            ?? null,
        notes: sale.notes
    }

    if (!shouldBuildRefundInvoice) {
        return baseInvoice
    }

    const isFullyReturned = !!sale.is_returned || (saleItems.length > 0 && saleItems.every(item =>
        item.is_returned || (item.returned_quantity || 0) >= (item.quantity || 0)
    ))

    const refundItems: UniversalInvoiceItem[] = saleItems.map(item => {
        const baseItem = getBaseItem(item)
        const originalQuantity = Math.max(0, Number(item.quantity) || 0)
        const rawReturnedQuantity = Math.max(0, Number(item.returned_quantity) || 0)
        const refundedQuantity = (isFullyReturned || item.is_returned)
            ? originalQuantity
            : Math.min(rawReturnedQuantity, originalQuantity)
        const activeQuantity = Math.max(0, originalQuantity - refundedQuantity)
        const unitPrice = Number(baseItem.unit_price) || 0
        const refundedAmount = unitPrice * refundedQuantity
        const activeAmount = unitPrice * activeQuantity

        return {
            ...baseItem,
            quantity: originalQuantity,
            total_price: unitPrice * originalQuantity,
            original_quantity: originalQuantity,
            refunded_quantity: refundedQuantity,
            active_quantity: activeQuantity,
            refunded_amount: refundedAmount,
            active_amount: activeAmount,
            refund_status: getRefundStatus(refundedQuantity, activeQuantity)
        }
    })

    const originalTotal = refundItems.reduce((sum, item) => sum + (item.unit_price * (item.original_quantity || item.quantity || 0)), 0)
    const refundedTotal = refundItems.reduce((sum, item) => sum + (item.refunded_amount || 0), 0)
    const activeTotal = refundItems.reduce((sum, item) => sum + (item.active_amount || 0), 0)

    return {
        ...baseInvoice,
        items: refundItems,
        is_refund_invoice: true,
        refund_summary: {
            is_fully_returned: isFullyReturned,
            refund_reason: resolveSaleReturnReason(sale),
            returned_at: resolveSaleReturnedAt(sale),
            original_total: originalTotal,
            refunded_total: refundedTotal,
            active_total: activeTotal
        }
    }
}

// Note: mapInvoiceToUniversal has been removed.
// Invoices are now stored as PDFs in R2. There is no need to map them to UniversalInvoice.
// For viewing/printing, fetch the PDF directly from R2 using invoice.r2PathA4 or invoice.r2PathReceipt.

