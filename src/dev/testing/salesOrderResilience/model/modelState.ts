import type { Action, CommercialState, LabConfiguration, SalesOrderModel } from './modelTypes'

// Integer milli-units keep the oracle independent of Atlas calculation helpers.
export const money = (value: number) => Math.round(value * 1000) / 1000
export const quantity = (value: number) => Math.round(value * 1_000_000) / 1_000_000
export const copyCommercial = (state: CommercialState): CommercialState => structuredClone(state)
export const subtotal = (state: CommercialState) => money(state.lines.reduce((sum, line) => sum + money(line.quantity * line.price), 0))
export const originalTotal = (state: CommercialState) => money(Math.max(0, subtotal(state) - state.discount + state.tax))
export const returnValue = (state: CommercialState) => {
    const gross = subtotal(state)
    const ratio = gross ? originalTotal(state) / gross : 0
    return money(state.lines.reduce((sum, line) => sum + money(line.returned / line.factor * line.price * ratio), 0))
}
export const total = (model: SalesOrderModel) => money(originalTotal(model.saved) - model.refunded)
export const balance = (model: SalesOrderModel) => money(total(model) - model.paid)
export const slotIndex = (action: Action, model: SalesOrderModel) => (action.slot ?? 0) % model.editor.lines.length
export function newModel(configuration: LabConfiguration): SalesOrderModel {
    const empty: CommercialState = { lines: [], discount: 0, tax: 0, customer: 0 }
    return { status: 'none', editor: copyCommercial(empty), saved: copyCommercial(empty), currency: configuration.currency,
        method: configuration.method, paid: 0, refunded: 0, online: true, dirty: false, synced: true, payments: [], returns: 0, minimumVersion: 1 }
}
export function isValidAction(action: Action, model: SalesOrderModel) {
    const active = !['none', 'deleted'].includes(model.status)
    const editable = model.status === 'draft' && model.paid === 0
    switch (action.name) {
        case 'CreateOrder': return model.status === 'none'
        case 'AddProduct': return editable && model.editor.lines.length < 3 && !model.editor.lines.some(line => line.product === (action.slot ?? 0) % 3)
        case 'RemoveProduct': return editable && model.editor.lines.length > 1
        case 'ChangeQuantity': case 'ChangePrice': case 'ChangeCustomer': case 'ApplyDiscount': return editable && model.editor.lines.length > 0
        case 'SaveDraft': return editable && model.editor.lines.length > 0
        case 'RequestApproval': return editable && !model.dirty && model.online
        case 'ApproveOrder': case 'RejectOrder': return model.status === 'approval_requested' && model.online
        case 'RecordPayment': return ['draft', 'pending', 'completed'].includes(model.status) && !model.dirty && balance(model) > 0.001 && model.online
        case 'RetryPayment': return model.payments.length > 0 && !['cancelled', 'returned', 'deleted'].includes(model.status) && model.online
        case 'MoveToPending': return model.status === 'draft' && !model.dirty && model.paid === total(model) && model.online
        case 'CompleteOrder': return model.status === 'pending' && model.online
        case 'RetryComplete': return model.status === 'completed' && model.online
        case 'ReturnItems': return model.status === 'completed' && model.online && model.saved.lines.some(line => line.returned < line.quantity * line.factor)
        case 'RetryReturn': return model.returns > 0 && model.online
        case 'CancelOrder': return ['draft', 'pending'].includes(model.status) && !model.dirty && model.online
        case 'DeleteOrder': return model.status === 'draft' && model.paid === 0 && !model.dirty && model.online
        case 'RetryCreate': return model.status === 'draft' && model.paid === 0 && !model.dirty && model.online
        case 'GoOffline': return active && model.online && !model.dirty
        case 'GoOnline': return active && !model.online
        case 'RetrySync': return active && model.online && !model.dirty
        case 'ReloadState': case 'ReopenOrder': return active && !model.dirty
    }
}
export function applyAction(action: Action, model: SalesOrderModel) {
    const line = model.editor.lines[slotIndex(action, model)]
    switch (action.name) {
        case 'CreateOrder':
            model.status = 'draft'
            model.editor.lines = [{ product: 0, quantity: 1, price: 100, factor: 1, free: 0, returned: 0 }]
            model.saved = copyCommercial(model.editor)
            break
        case 'AddProduct': model.editor.lines.push({ product: (action.slot ?? 0) % 3, quantity: action.value ?? 1, price: 100, factor: 1, free: 0, returned: 0 }); model.dirty = true; break
        case 'RemoveProduct': model.editor.lines.splice(slotIndex(action, model), 1); model.dirty = true; break
        case 'ChangeQuantity': line.quantity = action.value!; model.dirty = true; break
        case 'ChangePrice': line.price = action.value!; model.dirty = true; break
        case 'ChangeCustomer': model.editor.customer = (action.slot ?? 0) % 2; model.dirty = true; break
        case 'ApplyDiscount': model.editor.discount = money(subtotal(model.editor) * (action.value ?? 0) / 100); model.dirty = true; break
        case 'SaveDraft': model.saved = copyCommercial(model.editor); model.dirty = false; model.synced = model.online; break
        case 'RequestApproval': model.status = 'approval_requested'; break
        case 'ApproveOrder': case 'RejectOrder': model.status = 'draft'; break
        case 'RecordPayment': {
            const amount = money(balance(model) * (action.value ?? 100) / 100)
            model.paid = money(model.paid + amount); model.payments.push(amount); break
        }
        case 'MoveToPending': model.status = 'pending'; break
        case 'CompleteOrder': model.status = 'completed'; break
        case 'ReturnItems': {
            const candidates = model.saved.lines.filter(item => item.returned < item.quantity * item.factor)
            const returned = candidates[(action.slot ?? 0) % candidates.length]
            const available = quantity(returned.quantity * returned.factor - returned.returned)
            const amount = quantity(available * (action.value ?? 100) / 100)
            returned.returned = quantity(returned.returned + amount)
            model.refunded = returnValue(model.saved)
            model.paid = total(model)
            model.returns++
            break
        }
        case 'CancelOrder': model.status = 'cancelled'; model.paid = 0; break
        case 'DeleteOrder': model.status = 'deleted'; break
        case 'GoOffline': model.online = false; break
        case 'GoOnline': model.online = true; break
        case 'RetrySync': model.synced = true; break
        default: break
    }
}
