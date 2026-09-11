export type JumlaKhaleejInquiryPdfItem = {
    productId: string
    name: string
    imageUrl: string | null
    price: number
    currency: string
    unit: string
    quantity: number
    lineTotal: number
}

export type JumlaKhaleejInquiryPdfData = {
    documentNumber: string
    createdAt: string
    customer: {
        name: string
        phone: string
        address: string
        city: string
        notes: string
    }
    items: JumlaKhaleejInquiryPdfItem[]
    deliveryFee: number
    currency: string
}

type MarketplaceInquiryOrderInput = {
    websiteStorefrontKey: string | null
    orderNumber: string
    createdAt: string
    customerName: string
    customerPhone: string
    customerAddress: string | null
    customerCity: string | null
    customerNotes: string | null
    deliveryFee: number | null
    currency: string
    items: Array<{
        product_id: string
        allocation_group_id?: string | null
        name: string
        image_url?: string | null
        unit_price: number
        currency: string
        unit?: string | null
        quantity: number
        line_total: number
    }>
}

function finite(value: number | null | undefined) {
    return Number.isFinite(value) ? Number(value) : 0
}

/**
 * Keeps a multi-storage storefront allocation visually identical to the
 * customer cart: one product row, with the original aggregate quantity.
 */
export function createJumlaKhaleejInquiryPdfData(order: MarketplaceInquiryOrderInput): JumlaKhaleejInquiryPdfData | null {
    if (order.websiteStorefrontKey !== 'jumla-khaleej') return null

    const grouped = new Map<string, JumlaKhaleejInquiryPdfItem>()
    for (const [index, item] of order.items.entries()) {
        if (!item.product_id || !item.name || finite(item.quantity) <= 0) continue
        const key = item.allocation_group_id || `line:${index}`
        const existing = grouped.get(key)
        if (existing) {
            existing.quantity += finite(item.quantity)
            existing.lineTotal += finite(item.line_total)
            continue
        }

        grouped.set(key, {
            productId: item.product_id,
            name: item.name,
            imageUrl: item.image_url || null,
            price: finite(item.unit_price),
            currency: item.currency || order.currency || 'iqd',
            unit: item.unit?.trim() || '',
            quantity: finite(item.quantity),
            lineTotal: finite(item.line_total)
        })
    }

    const items = Array.from(grouped.values())
    if (items.length === 0) return null

    return {
        documentNumber: order.orderNumber,
        createdAt: order.createdAt,
        customer: {
            name: order.customerName,
            phone: order.customerPhone,
            address: order.customerAddress?.trim() || '',
            city: order.customerCity?.trim() || '',
            notes: order.customerNotes?.trim() || ''
        },
        items,
        deliveryFee: finite(order.deliveryFee),
        currency: order.currency || items[0].currency || 'iqd'
    }
}
