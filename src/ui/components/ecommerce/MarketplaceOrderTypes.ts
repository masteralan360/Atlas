import type { MarketplaceSalesOrderReturnStatus } from '@/lib/marketplaceOrderPresentation'
import type { EditableMarketplaceOrderItem } from './EditMarketplaceOrderItemsDialog'

export type MarketplaceOrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled'

export type MarketplaceOrderItemRecord = EditableMarketplaceOrderItem

export type MarketplaceOrderRecord = {
    id: string
    workspace_id: string
    order_number: string
    business_partner_id: string | null
    customer_id: string | null
    sales_order_id: string | null
    customer_name: string
    customer_phone: string
    customer_email: string | null
    customer_address: string | null
    customer_city: string | null
    customer_notes: string | null
    inquiry_pdf_storage_id: string | null
    inquiry_pdf_document_number: string | null
    inquiry_pdf_uploaded_at: string | null
    website_storefront_key: string | null
    items: MarketplaceOrderItemRecord[]
    delivery_fee: number | null
    subtotal: number
    total: number
    currency: string
    status: MarketplaceOrderStatus
    confirmed_at: string | null
    processing_at: string | null
    shipped_at: string | null
    delivered_at: string | null
    cancelled_at: string | null
    cancel_reason: string | null
    inventory_deducted: boolean
    sales_order_return_status: MarketplaceSalesOrderReturnStatus
    sales_order_returned_at: string | null
    created_at: string
    updated_at: string
}
