import { db } from '@/local-db/database'
import * as orders from '@/local-db/orders'
import { roundOrderValue } from '@/lib/orderPrecision'
import { calculateOrderTotalWithAdjustments } from '@/lib/orderAdjustments'
import { setNetworkStatus } from '@/lib/network'
import type { SalesOrder, SalesOrderItem } from '@/local-db/models'
import type { Table } from 'dexie'
import type { Action, LabConfiguration } from '../model/modelTypes'
import type { LabFixture, SalesOrderDriver, SalesOrderGraph } from './SalesOrderDriver'

type OrderInput = Parameters<typeof orders.createSalesOrder>[1]

/** Drives the actual form/domain boundary; editor input is deliberately separate from persisted records. */
export class ModuleDriver implements SalesOrderDriver {
    readonly boundary: SalesOrderDriver['boundary'] = 'module'
    readonly mode: SalesOrderDriver['mode'] = 'local'
    protected orderId = crypto.randomUUID()
    protected editor!: OrderInput
    protected lastPayment?: { amount: number; idempotencyKey: string }
    protected lastReturn?: orders.ReturnSalesOrderInput
    protected createInput?: OrderInput
    readonly actions: Action[] = []
    constructor(readonly fixture: LabFixture, readonly configuration: LabConfiguration) {}

    protected makeLine(productIndex: number, quantity = 1): SalesOrderItem {
        const product = this.fixture.products[productIndex]
        return { id: crypto.randomUUID(), productId: product.id, productName: product.name, productSku: product.sku,
            storageId: this.fixture.storage.id, quantity, freeBonusQuantity: 0, unitFactor: 1, unit: 'pcs',
            unitRef: 'builtin:pcs', baseUnitRef: 'builtin:pcs', baseUnitCode: 'pcs', inventoryQuantity: quantity,
            freeBonusInventoryQuantity: 0, lineTotal: roundOrderValue(quantity * 100), originalCurrency: this.configuration.currency,
            originalUnitPrice: 100, convertedUnitPrice: 100, settlementCurrency: this.configuration.currency,
            costPrice: 40, convertedCostPrice: 40, reservedQuantity: 0, fulfilledQuantity: 0, batchAllocations: null }
    }
    protected recalculate() {
        for (const line of this.editor.items) {
            line.lineTotal = roundOrderValue(line.quantity * line.convertedUnitPrice)
            line.inventoryQuantity = line.quantity * (line.unitFactor ?? 1)
        }
        this.editor.subtotal = roundOrderValue(this.editor.items.reduce((sum, line) => sum + line.lineTotal, 0))
        this.editor.total = calculateOrderTotalWithAdjustments(roundOrderValue(this.editor.subtotal - this.editor.discount + this.editor.tax), [])
        this.editor.balanceAmount = this.editor.total
    }
    protected paymentInput(amount: number, idempotencyKey: string) {
        return { orderType: 'sales' as const, orderId: this.orderId, amount, idempotencyKey,
            paymentMethod: this.configuration.method, paidAt: '2026-10-02T09:00:00.000Z', createdBy: this.fixture.userId,
            accountId: this.fixture.accountId, accountNameSnapshot: this.fixture.accountName }
    }
    async execute(action: Action) {
        this.actions.push(structuredClone(action))
        const line = this.editor?.items[(action.slot ?? 0) % this.editor.items.length]
        switch (action.name) {
            case 'CreateOrder': {
                const customer = this.fixture.customers[0]
                this.editor = { businessPartnerId: customer.id, customerId: customer.id, customerName: customer.partnerName,
                    sourceStorageId: this.fixture.storage.id, items: [this.makeLine(0)], subtotal: 100, discount: 0, tax: 0,
                    total: 100, currency: this.configuration.currency, exchangeRate: null, exchangeRateSource: null,
                    exchangeRateTimestamp: null, exchangeRates: null, status: 'draft',
                    isPaid: false, paymentStatus: 'unpaid', paidAmount: 0, balanceAmount: 100, paymentMethod: this.configuration.method,
                    initialPaymentAmount: 0, isInstallmentBased: false, installmentCount: 0, isLocked: false,
                    shippingAddress: '', notes: this.fixture.tag, sourceChannel: 'manual', marketplaceOrderId: null,
                    commissionEnabled: false, createdBy: this.fixture.userId }
                this.createInput = structuredClone(this.editor)
                await orders.createSalesOrder(this.fixture.workspaceId, this.editor, this.fixture.userId, { orderId: this.orderId })
                break
            }
            case 'AddProduct': this.editor.items.push(this.makeLine((action.slot ?? 0) % 3, action.value)); this.recalculate(); break
            case 'RemoveProduct': this.editor.items.splice((action.slot ?? 0) % this.editor.items.length, 1); this.recalculate(); break
            case 'ChangeQuantity': line.quantity = action.value!; this.recalculate(); break
            case 'ChangePrice': line.originalUnitPrice = line.convertedUnitPrice = action.value!; this.recalculate(); break
            case 'ChangeCustomer': {
                const customer = this.fixture.customers[(action.slot ?? 0) % 2]
                this.editor.businessPartnerId = this.editor.customerId = customer.id
                this.editor.customerName = customer.partnerName; break
            }
            case 'ApplyDiscount': this.editor.discount = roundOrderValue(this.editor.subtotal * (action.value ?? 0) / 100); this.recalculate(); break
            case 'SaveDraft': await orders.updateSalesOrder(this.orderId, this.editor); break
            case 'RequestApproval': await orders.updateSalesOrder(this.orderId, { approvalStatus: 'requested', approvalRequestedBy: this.fixture.userId, approvalRequestedAt: new Date().toISOString() }); break
            case 'ApproveOrder': await orders.approveSalesOrderRequest(this.orderId, this.fixture.userId); break
            case 'RejectOrder': await orders.updateSalesOrder(this.orderId, { approvalStatus: 'rejected', approvalReviewedBy: this.fixture.userId }); break
            case 'MoveToPending': await orders.updateSalesOrderStatus(this.orderId, 'pending'); break
            case 'CompleteOrder': await orders.updateSalesOrderStatus(this.orderId, 'completed'); break
            case 'RetryComplete': {
                try { await orders.updateSalesOrderStatus(this.orderId, 'completed') }
                catch (error) { if (!(error instanceof Error) || error.message !== 'invalid_order_transition') throw error }
                break
            }
            case 'RecordPayment': {
                const order = (await this.readOrder())!
                this.lastPayment = { amount: roundOrderValue(order.balanceAmount * (action.value ?? 100) / 100), idempotencyKey: crypto.randomUUID() }
                await orders.recordOrderPayment(this.fixture.workspaceId, this.paymentInput(this.lastPayment.amount, this.lastPayment.idempotencyKey)); break
            }
            case 'RetryPayment': await orders.recordOrderPayment(this.fixture.workspaceId, this.paymentInput(this.lastPayment!.amount, this.lastPayment!.idempotencyKey)); break
            case 'ReturnItems': {
                const order = (await this.readOrder())!
                const returned = await db.order_return_items.where('orderId').equals(this.orderId).toArray()
                const candidates = order.items.filter(item => (item.inventoryQuantity ?? item.quantity) > returned.filter(row => row.orderItemId === item.id).reduce((sum, row) => sum + row.quantity, 0))
                const item = candidates[(action.slot ?? 0) % candidates.length]
                const remaining = (item.inventoryQuantity ?? item.quantity) - returned.filter(row => row.orderItemId === item.id).reduce((sum, row) => sum + row.quantity, 0)
                this.lastReturn = { orderId: this.orderId, idempotencyKey: crypto.randomUUID(), items: [{ orderItemId: item.id, quantity: Math.round(remaining * (action.value ?? 100) / 100 * 1_000_000) / 1_000_000 }],
                    reason: 'customer_returned', actorRole: 'admin', returnedBy: this.fixture.userId,
                    accountId: this.fixture.accountId, accountNameSnapshot: this.fixture.accountName }
                await orders.returnSalesOrder(this.lastReturn); break
            }
            case 'RetryReturn': await orders.returnSalesOrder(this.lastReturn!); break
            case 'CancelOrder': await orders.updateSalesOrderStatus(this.orderId, 'cancelled'); break
            case 'DeleteOrder': await orders.deleteSalesOrder(this.orderId); break
            case 'RetryCreate': await orders.createSalesOrder(this.fixture.workspaceId, this.createInput!, this.fixture.userId, { orderId: this.orderId }); break
            case 'GoOffline': setNetworkStatus(false); break
            case 'GoOnline': setNetworkStatus(true); break
            case 'RetrySync':
                if (this.mode !== 'local') {
                    const { processMutationQueue } = await import('@/sync/syncEngine')
                    const result = await processMutationQueue(this.fixture.userId!)
                    if (result.failed) throw new Error(`sync.failed: ${result.errors.join('; ')}`)
                } else if (await db.offline_mutations.count()) throw new Error('Local business data must not enter the Supabase queue')
                break
            case 'ReloadState': case 'ReopenOrder': db.close(); await db.open(); break
        }
    }
    readOrder(): Promise<SalesOrder | undefined> { return db.sales_orders.get(this.orderId) }
    async readDatabaseGraph(): Promise<SalesOrderGraph> {
        const workspace = this.fixture.workspaceId
        const read = async <T extends { workspaceId: string }>(table: Pick<Table<T>, 'toArray'>): Promise<T[]> => (await table.toArray()).filter(row => row.workspaceId === workspace)
        const orders = (await read(db.sales_orders)).filter(row => row.id === this.orderId)
        const payments = (await read(db.payment_transactions)).filter(row => row.sourceRecordId === this.orderId || row.metadata?.orderId === this.orderId)
        const paymentIds = new Set(payments.map(row => row.id))
        const returns = (await read(db.order_returns)).filter(row => row.orderId === this.orderId)
        const returnIds = new Set(returns.map(row => row.id))
        return { orders, inventory: (await read(db.inventory)).filter(row => this.fixture.products.some(product => product.id === row.productId)), movements: (await read(db.inventory_transactions)).filter(row => row.referenceId === this.orderId || returnIds.has(row.referenceId ?? '')),
            payments, returns,
            returnItems: (await read(db.order_return_items)).filter(row => row.orderId === this.orderId),
            installments: (await read(db.order_installments)).filter(row => row.orderId === this.orderId),
            loans: (await read(db.loans)).filter(row => row.orderId === this.orderId), loanPayments: await read(db.loan_payments), loanInstallments: await read(db.loan_installments),
            accountMovements: (await read(db.payment_account_movements)).filter(row => paymentIds.has(row.paymentTransactionId ?? '')),
            accountBalances: (await read(db.payment_account_balances)).filter(row => row.accountId === this.fixture.accountId) }
    }
    async close() { setNetworkStatus(true) }
    diagnostics() { return { orderId: this.orderId, fixture: this.fixture.tag, boundary: this.boundary, mode: this.mode, actor: 'admin', plan: 'business',
        configuration: this.configuration, workspaceId: this.fixture.workspaceId, userId: this.fixture.userId, storageId: this.fixture.storage.id,
        productIds: this.fixture.products.map(row => row.id), customerIds: this.fixture.customers.map(row => row.id), accountId: this.fixture.accountId, actions: this.actions } }
}
