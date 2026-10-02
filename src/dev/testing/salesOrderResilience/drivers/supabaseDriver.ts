import type { SupabaseClient } from '@supabase/supabase-js'
import { db } from '@/local-db/database'
import { toCamelCase } from '@/lib/utils'
import type { LabConfiguration, Action } from '../model/modelTypes'
import type { LabFixture, SalesOrderGraph } from './SalesOrderDriver'
import { ModuleDriver } from './moduleDriver'
import { dataOrThrow } from '../fixtures/testActor'
import { ensure, equal } from '../invariants/assert'
import type { TransportFaults } from '../faults/transportFaults'

const routes: Record<keyof SalesOrderGraph, [string, string]> = {
    orders: ['crm', 'sales_orders'], inventory: ['public', 'inventory'], movements: ['public', 'inventory_transactions'], payments: ['public', 'payment_transactions'],
    returns: ['public', 'order_returns'], returnItems: ['public', 'order_return_items'], installments: ['crm', 'order_installments'],
    loans: ['public', 'loans'], loanPayments: ['public', 'loan_payments'], loanInstallments: ['public', 'loan_installments'],
    accountMovements: ['payment_accounts', 'account_movements'], accountBalances: ['payment_accounts', 'account_balances']
}
export class SupabaseDriver extends ModuleDriver {
    readonly boundary = 'supabase' as const
    private disconnected = false
    constructor(fixture: LabFixture, configuration: LabConfiguration, readonly observer: SupabaseClient,
        readonly transport: TransportFaults, readonly mode: 'cloud' | 'hybrid') { super(fixture, configuration) }
    async execute(action: Action) {
        if (action.name === 'GoOffline') this.disconnected = true
        if (action.name === 'GoOnline') this.disconnected = false
        await super.execute(action)
        if (action.name === 'RetrySync') {
            equal(await db.offline_mutations.where('workspaceId').equals(this.fixture.workspaceId).filter(row => row.status !== 'synced').count(), 0, 'synchronization.queueAcknowledgement')
            const local = await super.readDatabaseGraph()
            const remote = await this.readRemoteGraph()
            const snapshot = (graph: SalesOrderGraph) => graph.orders.map(order => ({ id: order.id, status: order.status, total: order.total,
                paidAmount: order.paidAmount, balanceAmount: order.balanceAmount, items: order.items.map(item => ({ id: item.id, quantity: item.quantity, lineTotal: item.lineTotal })) }))
            equal(snapshot(local), snapshot(remote), 'synchronization.orderConvergence')
            for (const row of local.inventory) {
                const observed = remote.inventory.find(item => item.id === row.id)
                equal(observed?.quantity, row.quantity, 'synchronization.inventoryConvergence')
            }
        }
    }
    async readRemoteGraph(): Promise<SalesOrderGraph> {
        const tables = await Promise.all(Object.entries(routes).map(async ([name, [schema, table]]) => {
            const rows: Record<string, unknown>[] = []
            for (let offset = 0; ; offset += 200) {
                let query = this.observer.schema(schema).from(table).select('*').eq('workspace_id', this.fixture.workspaceId)
                if (name === 'orders') query = query.eq('notes', this.fixture.tag)
                else if (['inventory', 'movements'].includes(name)) query = query.in('product_id', this.fixture.products.map(row => row.id))
                else if (['returns', 'returnItems', 'installments', 'loans'].includes(name)) query = query.eq('order_id', this.orderId)
                else if (name === 'payments') query = query.eq('source_record_id', this.orderId)
                else if (['accountMovements', 'accountBalances'].includes(name)) {
                    if (!this.fixture.accountId) return [name, []]
                    query = query.eq('account_id', this.fixture.accountId)
                } else return [name, []] // Financing graphs are expanded by the financing regressions.
                const page = dataOrThrow(await query.order('id').range(offset, offset + 199), `observation.${table}`)
                const seen = new Set(rows.map(row => row.id))
                ensure(page.every(row => !seen.has(row.id)), 'persistence.pagination', table)
                rows.push(...page)
                if (page.length < 200) break
            }
            return [name, rows.map(row => toCamelCase(row))]
        }))
        const graph = Object.fromEntries(tables) as unknown as SalesOrderGraph
        const returnIds = new Set(graph.returns.map(row => row.id))
        graph.movements = graph.movements.filter(row => row.referenceId === this.orderId || returnIds.has(row.referenceId ?? ''))
        return graph
    }
    async readDatabaseGraph() {
        const pending = await db.offline_mutations.where('workspaceId').equals(this.fixture.workspaceId).filter(row => row.status !== 'synced').count()
        const remote = await this.readRemoteGraph()
        for (const rows of Object.values(remote)) for (const row of rows) equal(row.workspaceId, this.fixture.workspaceId, 'tenancy.observedGraph')
        if (this.disconnected || pending) return super.readDatabaseGraph()
        return remote
    }
    diagnostics() { return { ...super.diagnostics(), boundary: this.boundary, requests: this.transport.requests } }
}
