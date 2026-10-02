import * as fc from 'fast-check'
import type { Action, SalesOrderModel } from '../model/modelTypes'
import type { SalesOrderDriver } from '../drivers/SalesOrderDriver'
import { applyAction, isValidAction } from '../model/modelState'
import { assertInvariants } from '../invariants'

export class SalesOrderCommand implements fc.AsyncCommand<SalesOrderModel, SalesOrderDriver> {
    constructor(readonly action: Action) {}
    check(model: Readonly<SalesOrderModel>) { return isValidAction(this.action, model) }
    async run(model: SalesOrderModel, driver: SalesOrderDriver) {
        await driver.execute(this.action)
        applyAction(this.action, model)
        await assertInvariants(model, driver)
    }
    toString() { return JSON.stringify(this.action) }
}
const command = (action: Action) => new SalesOrderCommand(action)
const simple: Action['name'][] = ['SaveDraft', 'SaveDraft', 'SaveDraft', 'MoveToPending', 'CompleteOrder', 'RetryComplete', 'RetryPayment',
    'RequestApproval', 'ApproveOrder', 'RejectOrder', 'RetryReturn', 'CancelOrder', 'DeleteOrder', 'GoOffline', 'GoOnline',
    'RetrySync', 'RetrySync', 'ReloadState', 'ReopenOrder', 'RetryCreate']
export const commandArbitraries: fc.Arbitrary<SalesOrderCommand>[] = [
    ...simple.map(name => fc.constant(null).map(() => command({ name }))),
    fc.record({ slot: fc.nat(5), value: fc.integer({ min: 1, max: 12 }).map(n => n / 2) }).map(args => command({ name: 'AddProduct', ...args })),
    fc.nat(5).map(slot => command({ name: 'RemoveProduct', slot })),
    fc.record({ slot: fc.nat(5), value: fc.integer({ min: 1, max: 16 }).map(n => n / 2) }).map(args => command({ name: 'ChangeQuantity', ...args })),
    fc.record({ slot: fc.nat(5), value: fc.integer({ min: 50_000, max: 250_000 }).map(n => n / 1000) }).map(args => command({ name: 'ChangePrice', ...args })),
    fc.nat(3).map(slot => command({ name: 'ChangeCustomer', slot })),
    fc.integer({ min: 0, max: 25 }).map(value => command({ name: 'ApplyDiscount', value })),
    fc.constantFrom(25, 50, 100).map(value => command({ name: 'RecordPayment', value })),
    fc.constantFrom(25, 50, 100).map(value => command({ name: 'RecordPayment', value })),
    fc.record({ slot: fc.nat(5), value: fc.constantFrom(50, 100) }).map(args => command({ name: 'ReturnItems', ...args }))
]
