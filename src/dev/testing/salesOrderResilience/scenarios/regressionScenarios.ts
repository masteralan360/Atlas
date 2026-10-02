import type { Action } from '../model/modelTypes'

// Paid-on-creation is a domain contract, outside the unpaid generated command
// model. Keep its fixed reproduction ID alongside the stateful reproductions.
export const initialPaymentRegression = {
    id: 'SORL-REG-006',
    description: 'initial paid order creation commits its parent, payment and account movement atomically',
    sourceRunId: '5734880f-38ad-46c5-b81b-714b88f9e424',
    groupId: 'domain-contracts'
} as const

export const regressionScenarios: { id: string; description: string; actions: Action[] }[] = [
    { id: 'SORL-REG-001', description: 'saved edits, approval, partial payment, fulfillment and reload', actions: [
        { name: 'CreateOrder' }, { name: 'AddProduct', slot: 1, value: 2 }, { name: 'ChangeQuantity', slot: 0, value: 3.5 },
        { name: 'ChangePrice', slot: 1, value: 123.456 }, { name: 'ApplyDiscount', value: 10 }, { name: 'ChangeCustomer', slot: 1 },
        { name: 'SaveDraft' }, { name: 'SaveDraft' }, { name: 'RequestApproval' }, { name: 'ApproveOrder' },
        { name: 'RecordPayment', value: 25 }, { name: 'RetryPayment' }, { name: 'RecordPayment', value: 100 },
        { name: 'MoveToPending' }, { name: 'CompleteOrder' }, { name: 'RetryComplete' }, { name: 'ReloadState' }] },
    { id: 'SORL-REG-002', description: 'partial return retry preserves one refund and one stock restoration', actions: [
        { name: 'CreateOrder' }, { name: 'RecordPayment', value: 100 }, { name: 'MoveToPending' }, { name: 'CompleteOrder' },
        { name: 'ReturnItems', value: 50 }, { name: 'RetryReturn' }, { name: 'ReloadState' }] },
    { id: 'SORL-SYNC-001', description: 'offline edits survive reconnect and repeated synchronization', actions: [
        { name: 'CreateOrder' }, { name: 'GoOffline' }, { name: 'ChangeQuantity', value: 4 }, { name: 'SaveDraft' },
        { name: 'GoOnline' }, { name: 'RetrySync' }, { name: 'RetrySync' }, { name: 'ReloadState' }] },
    { id: 'SORL-REG-003', description: 'paid cancellation retains counter-entry audit history', actions: [
        { name: 'CreateOrder' }, { name: 'RecordPayment', value: 100 }, { name: 'CancelOrder' }, { name: 'ReloadState' }] },
    // Generated seed 20261002, path 35:0, command replay B:B: create → save → retry create reset version to 1.
    { id: 'SORL-REG-005', description: 'retrying creation preserves a saved draft and its monotonic version', actions: [
        { name: 'CreateOrder' }, { name: 'SaveDraft' }, { name: 'RetryCreate' }, { name: 'ChangeQuantity', value: 2 },
        { name: 'SaveDraft' }, { name: 'RetryCreate' }, { name: 'ReloadState' }] },
    { id: 'SORL-REG-004', description: 'draft identity retry, rejection and deletion', actions: [
        { name: 'CreateOrder' }, { name: 'RetryCreate' }, { name: 'RequestApproval' }, { name: 'RejectOrder' }, { name: 'DeleteOrder' }] }
]
