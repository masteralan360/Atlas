import type { CurrencyCode, OrderPaymentMethod } from '@/local-db/models'

export type LabStatus = 'none' | 'draft' | 'approval_requested' | 'pending' | 'completed' | 'cancelled' | 'returned' | 'deleted'
export interface ModelLine {
    product: number
    quantity: number
    price: number
    factor: number
    free: number
    returned: number
}
export interface CommercialState {
    lines: ModelLine[]
    discount: number
    tax: number
    customer: number
}
export interface SalesOrderModel {
    status: LabStatus
    editor: CommercialState
    saved: CommercialState
    currency: CurrencyCode
    method: OrderPaymentMethod
    paid: number
    refunded: number
    online: boolean
    dirty: boolean
    synced: boolean
    payments: number[]
    returns: number
    minimumVersion: number
}
export type ActionName = 'CreateOrder' | 'AddProduct' | 'RemoveProduct' | 'ChangeQuantity' | 'ChangePrice' | 'ChangeCustomer'
    | 'ApplyDiscount' | 'SaveDraft' | 'ReopenOrder' | 'RequestApproval' | 'ApproveOrder' | 'RejectOrder' | 'MoveToPending'
    | 'CompleteOrder' | 'RecordPayment' | 'RetryPayment' | 'ReturnItems' | 'RetryReturn' | 'CancelOrder' | 'DeleteOrder'
    | 'GoOffline' | 'GoOnline' | 'RetrySync' | 'ReloadState' | 'RetryCreate' | 'RetryComplete'
export interface Action {
    name: ActionName
    slot?: number
    value?: number
}
export interface LabConfiguration {
    currency: 'usd' | 'iqd'
    method: Exclude<OrderPaymentMethod, 'loan' | 'installments'>
    account: boolean
}
