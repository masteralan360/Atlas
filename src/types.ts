export interface SaleItem {
    id: string
    sale_id: string
    product_id: string
    storage_id?: string | null
    quantity: number
    unit_price: number
    total_price: number
    cost_price?: number
    converted_cost_price?: number
    product_name?: string
    product_sku?: string
    original_currency: string
    original_unit_price: number
    converted_unit_price: number
    settlement_currency: string
    negotiated_price?: number
    inventory_snapshot?: number
    returned_quantity?: number
    is_returned?: boolean
    return_reason?: string
    returned_at?: string
    returned_by?: string
    product?: {
        name: string
        sku: string
        category?: string
        can_be_returned: boolean
        return_rules?: string
    }
    product_category?: string
}

export interface Sale {
    id: string
    workspace_id: string
    cashier_id: string
    total_amount: number
    settlement_currency: string
    exchange_source: string | null
    exchange_rate: number | null
    exchange_rate_timestamp: string | null
    exchange_rates?: any[] | null
    created_at: string
    origin: 'pos' | 'manual' | 'instant_pos' | 'sales_order' | 'travel_agency'
    payment_method?: 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'loan'
    cashier_name?: string
    items?: SaleItem[]
    is_returned?: boolean
    return_reason?: string
    returned_at?: string
    returned_by?: string
    // Sequential ID
    sequenceId?: number
    // System Verification (offline-first, immutable)
    system_verified?: boolean
    system_review_status?: 'approved' | 'flagged' | 'inconsistent'
    system_review_reason?: string | null
    has_partial_return?: boolean
    notes?: string
    updated_at?: string
    _orderNumber?: string
    _isOrder?: boolean
}

export interface CartItem {
    product_id: string
    storageId?: string
    sku: string
    name: string
    price: number
    quantity: number
    max_stock: number
    negotiated_price?: number
    imageUrl?: string
}

export interface UniversalInvoiceItem {
    product_id: string
    product_name: string
    product_sku?: string
    quantity: number
    unit_price: number
    total_price: number
    original_unit_price?: number
    original_currency?: string
    settlement_currency?: string
    discount_amount?: number
    refunded_quantity?: number
    active_quantity?: number
    original_quantity?: number
    refunded_amount?: number
    active_amount?: number
    refund_status?: 'fully_refunded' | 'partially_refunded' | 'not_refunded'
}

export interface UniversalInvoice {
    id: string
    sequenceId?: number
    invoiceid?: string
    created_at: string

    cashier_name?: string
    customer_name?: string
    items: UniversalInvoiceItem[]
    total_amount: number
    subtotal_amount?: number
    tax_amount?: number
    discount_amount?: number
    settlement_currency: string
    payment_method?: string
    exchange_rates?: any[] | null
    exchange_rate?: number | null
    exchange_source?: string | null
    exchange_rate_timestamp?: string | null
    origin?: string
    created_by_name?: string
    status?: string
    customer_id?: string
    order_id?: string
    workspaceId?: string
    is_refund_invoice?: boolean
    refund_summary?: {
        is_fully_returned: boolean
        refund_reason?: string
        returned_at?: string
        original_total: number
        refunded_total: number
        active_total: number
    }
}

