export interface SaleItem {
    id: string
    // Older local snapshots may not yet have this field. New Supabase rows
    // always receive it from the parent sale.
    workspace_id?: string
    sale_id: string
    // Kept optional at the view boundary so pre-upgrade local snapshots can
    // still render while the local cache migration backfills them.
    created_at?: string
    updated_at?: string
    product_id: string
    storage_id?: string | null
    quantity: number
    selling_unit_ref?: string | null
    selling_unit_code?: string | null
    base_unit_ref?: string | null
    base_unit_code?: string | null
    unit_factor?: number
    inventory_quantity?: number
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
    batch_allocations?: {
        batch_id: string
        batch_number: string
        quantity: number
        price?: number | null
        cost_price?: number | null
        currency?: string | null
        expiry_date?: string | null
        manufacturing_date?: string | null
    }[] | null
    original_batch_allocations?: {
        batch_id: string
        batch_number: string
        quantity: number
        price?: number | null
        cost_price?: number | null
        currency?: string | null
        expiry_date?: string | null
        manufacturing_date?: string | null
    }[] | null
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
        unit?: string
        is_deleted?: boolean
    }
    product_category?: string
    price_book_id?: string | null
}

export interface Sale {
    id: string
    workspace_id: string
    cashier_id: string
    total_amount: number
    totalAmount?: number
    original_total_amount?: number
    returned_amount?: number
    return_status?: 'none' | 'partial' | 'full'
    settlement_currency: string
    currency_conversion_applied?: boolean
    sales_exchange?: SalesExchange[]
    // Derived compatibility shape for receipt and invoice rendering.
    exchange_rates?: any[] | null
    created_at: string
    origin: 'pos' | 'manual' | 'instant_pos' | 'sales_order' | 'exchange' | 'real_estate' | 'activities' | 'clinical_appointment' | 'post_service' | 'car_rental' | 'travel_transportation'
    payment_method?: 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'bank_transfer' | 'loan'
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
    _sourceChannel?: string | null
    _realEstateTransactionId?: string | null
    _activityTransactionId?: string | null
    _transactionNo?: string | null
    _clinicalAppointmentId?: string | null
    _rentalContractNo?: string | null
    _travelBookingId?: string | null
    _counterpartyName?: string | null
    returns?: SaleReturn[]
    product_exchanges?: SaleProductExchange[]
}

export interface SalesExchange {
    id: string
    sale_id: string
    workspace_id: string
    base_currency: 'usd' | 'eur' | 'iqd' | 'try'
    quote_currency: 'usd' | 'eur' | 'iqd' | 'try'
    base_amount: number
    quote_amount: number
    source: string
    captured_at: string
    rate_side: 'buy' | 'sell' | 'mid'
    source_price_id?: string | null
    source_price_updated_at?: string | null
    created_at: string
}

export interface SaleReturn {
    id: string
    workspace_id: string
    sale_id: string
    reason: string
    status: 'posted' | 'voided'
    refund_method?: string | null
    refund_amount: number
    returned_by?: string | null
    returned_at: string
    source: 'app' | 'exchange' | 'legacy_backfill' | 'system'
    created_at: string
    updated_at: string
    items?: SaleReturnItem[]
}

export interface SaleReturnItem {
    id: string
    workspace_id: string
    return_id: string
    sale_id: string
    sale_item_id: string
    quantity: number
    unit_refund_amount: number
    refund_amount: number
    restored_storage_id?: string | null
    restored_batch_allocations?: SaleItem['batch_allocations']
    created_at: string
    updated_at: string
}

export interface CartItem {
    product_id: string
    storageId?: string
    sku: string
    name: string
    price: number
    discounted_price?: number
    discount_type?: 'percentage' | 'fixed_amount'
    discount_value?: number
    discount_source?: 'product' | 'category'
    discount_ends_at?: string
    quantity: number
    /** Free quantity carried into a Sales Order when POS uses the Order payment flow. */
    freeBonusQuantity?: number
    /** Display-only unit override for the POS order free-bonus quantity. */
    freeBonusUnit?: string
    max_stock: number
    negotiated_price?: number
    imageUrl?: string
    unit?: string
    /** Immutable selling/base unit selection used by checkout and held carts. */
    selling_unit_ref?: string | null
    selling_unit_code?: string | null
    base_unit_ref?: string | null
    base_unit_code?: string | null
    unit_factor?: number
    /** Service lines use the UI-only Services virtual location and never affect stock. */
    is_service?: boolean
    price_book_id?: string
    price_book_name?: string
}

export interface UniversalInvoiceItem {
    product_id: string
    product_name: string
    product_sku?: string
    unit?: string
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

export interface Annotation {
    type: 'pen' | 'brush'
    points: { x: number, y: number }[]
    color: string
    brushSize: number
}

export interface AttachedText {
    id: string
    text: string
    x: number
    y: number
    width: number
    rotation?: number
    fontSize?: number | ''
    color?: string
}

export interface SaleProductExchange {
    id: string
    workspace_id: string
    sale_id: string
    return_id: string
    return_sale_item_id: string
    return_product_id: string
    return_quantity: number
    return_unit_amount: number
    return_amount: number
    return_storage_id?: string | null
    replacement_product_id: string
    replacement_storage_id: string
    replacement_quantity: number
    replacement_unit_amount: number
    replacement_amount: number
    replacement_batch_allocations?: SaleItem['batch_allocations']
    settlement_currency: string
    difference_amount: number
    cash_settlement_amount: number
    settlement_direction?: 'incoming' | 'outgoing' | null
    settlement_method?: string | null
    settlement_transaction_id?: string | null
    loan_id?: string | null
    loan_credit_amount: number
    reason: string
    notes?: string | null
    exchanged_by?: string | null
    exchanged_at: string
    status: 'posted' | 'voided'
    created_at: string
    updated_at: string
}

export type PdfShapeKind = 'rectangle' | 'circle' | 'triangle' | 'star'
export type PdfShapeLayer = 'behind-template' | 'above-template'

export const PDF_SHAPE_BEHIND_TEMPLATE_Z_INDEX = 5
export const PDF_SHAPE_ABOVE_TEMPLATE_Z_INDEX = 75

export function getPdfShapeHeightRatio(_kind: PdfShapeKind) {
    return 1
}

export interface PdfShape {
    id: string
    kind: PdfShapeKind
    x: number
    y: number
    width: number
    height?: number
    rotation?: number
    layer?: PdfShapeLayer
    color: string
}

export function getPdfShapeHeight(shape: Pick<PdfShape, 'kind' | 'width' | 'height'>) {
    return typeof shape.height === 'number' && Number.isFinite(shape.height) && shape.height > 0
        ? shape.height
        : shape.width * getPdfShapeHeightRatio(shape.kind)
}

export function getPdfShapeBottom(shape: PdfShape) {
    return shape.y + getPdfShapeHeight(shape) / 2
}

export function getPdfShapeZIndex(shape: Pick<PdfShape, 'layer'>) {
    return shape.layer === 'behind-template'
        ? PDF_SHAPE_BEHIND_TEMPLATE_Z_INDEX
        : PDF_SHAPE_ABOVE_TEMPLATE_Z_INDEX
}

export interface UniversalInvoice {
    id: string
    sequenceId?: number
    invoiceid?: string
    created_at: string

    cashier_name?: string
    customer_name?: string
    customer_address?: string
    terms?: string
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
    table_number?: string | null
    workspaceId?: string
    is_refund_invoice?: boolean
    attached_images?: {
        path: string
        x: number
        y: number
        width: number
        height?: number
        rotation?: number
    }[]
    refund_summary?: {
        is_fully_returned: boolean
        refund_reason?: string
        returned_at?: string
        original_total: number
        refunded_total: number
        active_total: number
    }
    annotations?: Annotation[]
    attached_texts?: AttachedText[]
    attached_shapes?: PdfShape[]
    hiddenPrintFields?: Record<string, boolean>
    notes?: string
}
