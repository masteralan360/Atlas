import { getLedgerPaymentTransactionEffect, getLedgerPaymentTransactions } from '@/lib/ledgerPaymentTransactions'
import type { SalesOrderDriver, SalesOrderGraph } from '../drivers/SalesOrderDriver'
import type { SalesOrderModel } from '../model/modelTypes'
import { balance, money, originalTotal, subtotal, total } from '../model/modelState'
import { ensure, equal, near } from './assert'

export function assertGraph(model: SalesOrderModel, driver: SalesOrderDriver, graph: SalesOrderGraph) {
    const fixture = driver.fixture
    for (const [table, rows] of Object.entries(graph)) {
        const ids = rows.map((row: { id: string }) => row.id)
        equal(new Set(ids).size, ids.length, `idempotency.${table}.identity`)
        for (const row of rows) equal(row.workspaceId, fixture.workspaceId, `tenancy.${table}`)
    }
    const roots = new Set(graph.orders.map(order => order.id))
    for (const row of [...graph.returns, ...graph.returnItems, ...graph.installments]) ensure(roots.has(row.orderId), 'persistence.orphanChild', row)
    const returnIds = new Set(graph.returns.map(row => row.id))
    for (const row of graph.returnItems) ensure(returnIds.has(row.returnId), 'returns.orphanLine', row)
    if (model.status === 'none') { equal(graph.orders.length, 0, 'persistence.noPrematureOrder'); return }
    equal(graph.orders.length, 1, 'idempotency.orderIdentity')
    const order = graph.orders[0]
    equal(order.isDeleted, model.status === 'deleted', 'persistence.deleted')
    if (model.status === 'deleted') return
    equal(order.status, model.status === 'approval_requested' ? 'draft' : model.status, 'persistence.status')
    if (model.status === 'approval_requested') equal(order.approvalStatus, 'requested', 'authorization.approval')
    equal(order.currency, model.currency, 'commercial.currency')
    equal(order.businessPartnerId, fixture.customers[model.saved.customer].id, 'persistence.customer')
    const retainedRatio = originalTotal(model.saved) ? total(model) / originalTotal(model.saved) : 1
    near(order.subtotal, money(subtotal(model.saved) * retainedRatio), 'commercial.subtotal')
    near(order.discount, money(model.saved.discount * retainedRatio), 'commercial.discount')
    near(order.tax, money(model.saved.tax * retainedRatio), 'commercial.tax')
    near(order.total, total(model), 'commercial.total')
    near(order.paidAmount, model.paid, 'payments.recognized')
    near(order.balanceAmount, balance(model), 'payments.balance')
    ensure(order.paidAmount >= 0, 'payments.nonNegative', order.paidAmount)
    equal(order.items.length, model.saved.lines.length, 'idempotency.lines')
    equal(new Set(order.items.map(line => line.id)).size, order.items.length, 'idempotency.lineIdentity')
    for (const expected of model.saved.lines) {
        const line = order.items.find(item => item.productId === fixture.products[expected.product].id)
        ensure(line, 'persistence.lineMissing', expected)
        near(line!.quantity, expected.quantity, 'commercial.quantity')
        ensure(line!.quantity > 0, 'commercial.positiveQuantity', line)
        near(line!.lineTotal, money(expected.quantity * expected.price), 'commercial.lineTotal')
        near(line!.unitFactor ?? 1, expected.factor, 'inventory.unitFactor')
        near(line!.inventoryQuantity ?? line!.quantity, expected.quantity * expected.factor, 'inventory.unitConversion')
        near(line!.freeBonusQuantity ?? 0, expected.free, 'inventory.freeQuantity')
    }
    for (let product = 0; product < fixture.products.length; product++) {
        const line = model.saved.lines.find(item => item.product === product)
        const deduction = ['completed', 'returned'].includes(model.status) && line
            ? (line.quantity + line.free) * line.factor - line.returned : 0
        const row = graph.inventory.find(item => item.productId === fixture.products[product].id && item.storageId === fixture.storage.id)
        near(row?.quantity, 100 - deduction, 'inventory.conservation', 0.000001)
        const movements = graph.movements.filter(item => item.productId === fixture.products[product].id)
        if (movements.length) near(movements.reduce((sum, item) => sum + item.quantityDelta, 0), -deduction, 'inventory.movementConservation', 0.000001)
    }
    equal(graph.returns.length, model.returns, 'idempotency.returns')
    for (const expected of model.saved.lines) {
        const line = order.items.find(item => item.productId === fixture.products[expected.product].id)!
        const returns = graph.returnItems.filter(item => item.orderItemId === line.id)
        near(returns.reduce((sum, item) => sum + item.quantity, 0), expected.returned, 'returns.quantity')
        ensure(expected.returned <= expected.quantity * expected.factor, 'returns.maximum', expected)
    }
    near(graph.returns.reduce((sum, item) => sum + item.refundAmount, 0), model.refunded, 'returns.refund')
    for (const transaction of graph.payments) {
        ensure(roots.has(transaction.sourceRecordId) || returnIds.has(transaction.sourceRecordId), 'payments.orphanRelation', transaction)
        if (transaction.reversalOfTransactionId) {
            const original = graph.payments.find(item => item.id === transaction.reversalOfTransactionId)
            ensure(original && original.amount > 0 && transaction.amount < 0, 'payments.reversalLink', transaction)
            const reversed = graph.payments.filter(item => item.reversalOfTransactionId === original!.id).reduce((sum, item) => sum - item.amount, 0)
            ensure(reversed <= original!.amount + 0.0005, 'payments.reversalPortion', transaction)
        }
    }
    near(graph.payments.reduce((sum, item) => sum + item.amount, 0), model.paid, 'payments.transactionNet')
    equal(graph.payments.filter(item => !item.reversalOfTransactionId).length, model.payments.length, 'idempotency.payments')
    const ledger = getLedgerPaymentTransactions(graph.payments)
    equal(ledger.length, graph.payments.length, 'payments.ledgerVisibility')
    near(ledger.reduce((sum, item) => {
        const effect = getLedgerPaymentTransactionEffect(item)
        return sum + (effect.direction === 'incoming' ? effect.amount : -effect.amount)
    }, 0), model.paid, 'payments.ledgerNet')
    for (const movement of graph.accountMovements) ensure(graph.payments.some(item => item.id === movement.paymentTransactionId), 'payments.accountOrphan', movement)
    if (fixture.accountId) {
        equal(graph.accountMovements.length, graph.payments.length, 'payments.accountMovements')
        near(graph.accountBalances.find(row => row.currency === model.currency)?.balanceAmount ?? 0, model.paid, 'payments.accountBalance')
    } else equal(graph.accountMovements.length, 0, 'payments.optionalAccount')
    for (const loan of graph.loans) {
        ensure(roots.has(loan.orderId!), 'installments.loanParent', loan)
        const schedule = graph.loanInstallments.filter(item => item.loanId === loan.id && item.status !== 'cancelled')
        near(schedule.reduce((sum, item) => sum + item.balanceAmount, 0), loan.balanceAmount, 'installments.balance')
    }
    ensure(order.version >= model.minimumVersion, 'persistence.version', order.version)
    ensure(order.total <= originalTotal(model.saved) + 0.0005, 'returns.commercialCeiling', order.total)
}

export async function assertInvariants(model: SalesOrderModel, driver: SalesOrderDriver) {
    const graph = await driver.readDatabaseGraph()
    assertGraph(model, driver, graph)
    if (graph.orders[0]) model.minimumVersion = graph.orders[0].version
    return graph
}
