import { createHash } from 'node:crypto'
import type { Graph, HostedClient, Row, Scope } from './types'

const PAGE_SIZE = 200
const tableRoutes: Record<string, [string, string]> = {
    orders: ['crm', 'sales_orders'], products: ['public', 'products'], inventory: ['public', 'inventory'],
    batches: ['public', 'stock_batches'], movements: ['public', 'inventory_transactions'],
    payments: ['public', 'payment_transactions'], returns: ['public', 'order_returns'], returnItems: ['public', 'order_return_items'],
    loans: ['public', 'loans'], loanPayments: ['public', 'loan_payments'], loanInstallments: ['public', 'loan_installments'],
    orderInstallments: ['crm', 'order_installments'], assignments: ['crm', 'sales_order_agent_assignments'],
    commissions: ['crm', 'agent_commission_entries'], productCommissions: ['crm', 'agent_product_commission_entries'],
    trackedCommissions: ['crm', 'agent_tracked_commission_entries'], trackedProductCommissions: ['crm', 'agent_tracked_product_commission_entries'],
    accounts: ['payment_accounts', 'accounts'], accountMovements: ['payment_accounts', 'account_movements'],
    accountBalances: ['payment_accounts', 'account_balances'], invoices: ['public', 'invoices'],
    invoiceVersions: ['public', 'invoice_versions'], marketplace: ['public', 'marketplace_orders']
}

/** Explicit pagination + stable primary-key ordering: a truncated graph must never pass. */
export async function readRows(client: HostedClient, table: string, workspaceId: string, column: string, ids: readonly string[]): Promise<Row[]> {
    if (!ids.length) return []
    const [schema, name] = tableRoutes[table] ?? table.split('.')
    if (!schema || !name) throw new Error(`unknown_observer_table: ${table}`)
    const result: Row[] = []
    for (let chunk = 0; chunk < ids.length; chunk += 100) {
        const values = ids.slice(chunk, chunk + 100)
        const seen = new Set<string>()
        for (let offset = 0; ; offset += PAGE_SIZE) {
            const { data, error } = await client.schema(schema).from(name).select('*')
                .eq('workspace_id', workspaceId).in(column, values).order('id').range(offset, offset + PAGE_SIZE - 1)
            if (error || !Array.isArray(data)) throw new Error(`hosted_read_failed: ${table}: ${error?.message ?? 'invalid result'}`)
            if (data.some(row => !row.id || seen.has(row.id)) || new Set(data.map(row => row.id)).size !== data.length) throw new Error(`hosted_pagination_unstable: ${table}`)
            data.forEach(row => seen.add(row.id))
            result.push(...data)
            if (data.length < PAGE_SIZE) break
        }
    }
    return uniqueRows(result)
}
const uniqueRows = (rows: Row[]) => [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)))
const ids = (rows: Row[], column = 'id') => [...new Set(rows.map(row => row[column]).filter((value): value is string => typeof value === 'string' && !!value))]

export async function readGraph(client: HostedClient, scope: Scope): Promise<Graph> {
    const read = (table: string, column: string, values: readonly string[]) => readRows(client, table, scope.workspaceId, column, values)
    // Capture a save that committed before a lost response, including IDs not returned to the action caller.
    const discoveredIds = new Set<string>()
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data: discovered, error } = await client.schema('crm').from('sales_orders').select('id')
            .eq('workspace_id', scope.workspaceId).like('notes', `${scope.tag}%`).order('id').range(offset, offset + PAGE_SIZE - 1)
        if (error || !Array.isArray(discovered)) throw new Error(`hosted_order_discovery_failed:${error?.code ?? 'invalid_result'}:${error?.message ?? ''}`)
        for (const row of discovered) {
            if (!row.id || discoveredIds.has(row.id)) throw new Error('hosted_order_discovery_unstable')
            discoveredIds.add(row.id); scope.orderIds.add(row.id)
        }
        if (discovered.length < PAGE_SIZE) break
    }
    const orderIds = [...scope.orderIds]
    const tables: Record<string, Row[]> = {}
    const roots: Array<[string, string, string[]]> = [
        ['orders', 'id', orderIds], ['products', 'id', [...scope.productIds]], ['inventory', 'product_id', [...scope.productIds]],
        ['batches', 'product_id', [...scope.productIds]], ['movements', 'product_id', [...scope.productIds]],
        ['returns', 'order_id', orderIds], ['returnItems', 'order_id', orderIds], ['loans', 'order_id', orderIds],
        ['orderInstallments', 'order_id', orderIds], ['assignments', 'order_id', orderIds], ['commissions', 'order_id', orderIds],
        ['productCommissions', 'order_id', orderIds], ['trackedCommissions', 'order_id', orderIds], ['trackedProductCommissions', 'order_id', orderIds],
        ['marketplace', 'sales_order_id', orderIds], ['invoices', 'order_id', orderIds], ['invoiceVersions', 'source_id', orderIds]
    ]
    await Promise.all(roots.map(async ([name, column, values]) => { tables[name] = await read(name, column, values) }))
    tables.marketplace = uniqueRows([...tables.marketplace, ...await read('marketplace', 'id', [...scope.marketplaceIds])])
    const loanIds = ids(tables.loans)
    const sourceIds = [...new Set([...orderIds, ...loanIds, ...ids(tables.returns), ...ids(tables.commissions), ...ids(tables.assignments)])]
    const [payments, loanPayments, loanInstallments] = await Promise.all([
        read('payments', 'source_record_id', sourceIds), read('loanPayments', 'loan_id', loanIds), read('loanInstallments', 'loan_id', loanIds)
    ])
    tables.loanPayments = loanPayments
    tables.loanInstallments = loanInstallments
    const linkedIds = loanPayments.flatMap(row => [row.payment_transaction_id, row.reversal_transaction_id]).filter(Boolean)
    const commissionPayments = await read('payments', 'source_subrecord_id', ids(tables.commissions))
    const paymentById = await read('payments', 'id', linkedIds)
    tables.payments = uniqueRows([...payments, ...commissionPayments, ...paymentById])
    const reversals = await read('payments', 'reversal_of_transaction_id', ids(tables.payments))
    tables.payments = uniqueRows([...tables.payments, ...reversals])
    tables.payments.forEach(row => { if (row.account_id) scope.accountIds.add(row.account_id) })
    const accountIds = [...scope.accountIds]
    // Read all movements of disposable accounts; this catches orphan effects and unexplained balances.
    await Promise.all([
        read('accounts', 'id', accountIds).then(rows => { tables.accounts = rows }),
        read('accountMovements', 'account_id', accountIds).then(rows => { tables.accountMovements = rows }),
        read('accountBalances', 'account_id', accountIds).then(rows => { tables.accountBalances = rows })
    ])
    return { workspaceId: scope.workspaceId, tables }
}

export function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(value)
}
export const graphHash = (graph: Graph) => createHash('sha256').update(canonical(graph)).digest('hex')
export const money = (value: unknown) => Math.round(Number(value) * 1_000) / 1_000
export const quantity = (value: unknown) => Math.round(Number(value) * 1_000_000) / 1_000_000
export const active = (rows: Row[]) => rows.filter(row => !row.is_deleted)
export const sum = (rows: Row[], column: string) => rows.reduce((total, row) => total + Number(row[column] ?? 0), 0)
function ensure(condition: unknown, invariant: string, detail: string): asserts condition {
    if (!condition) throw new Error(`hosted_integrity: ${invariant}: ${detail}`)
}
function near(actual: number, expected: number, invariant: string, detail: string, epsilon = 0.0005) {
    ensure(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= epsilon, invariant, `${detail}; expected ${expected}, actual ${actual}`)
}
export const INVARIANTS = [
    'tenant-graph', 'order-identity', 'commercial-arithmetic', 'unit-quantities', 'stock-conservation', 'batch-conservation',
    'movement-history', 'payment-reversal-conservation', 'order-money', 'account-effects', 'financing', 'schedule',
    'return-links', 'financed-return-value', 'immutable-corrections', 'commission-effects', 'per-currency-ledger',
    'terminal-state', 'idempotency', 'atomicity-and-recovery', 'complete-independent-reads', 'invoice-metadata', 'no-orphans', 'audit-evidence'
] as const

/** These calculations deliberately do not import production calculation or integrity-audit helpers. */
export function assertGraph(graph: Graph, baseline?: Graph): string[] {
    const t = graph.tables
    for (const [table, rows] of Object.entries(t)) {
        ensure(new Set(rows.map(row => row.id)).size === rows.length, 'order-identity', `duplicate ${table} primary key`)
        for (const row of rows) ensure(row.workspace_id === graph.workspaceId, 'tenant-graph', `${table}/${row.id}`)
    }
    const orderById = new Map(t.orders.map(row => [row.id, row]))
    const products = new Map(t.products.map(row => [row.id, row]))
    const paymentById = new Map(t.payments.map(row => [row.id, row]))
    const returnById = new Map(t.returns.map(row => [row.id, row]))
    const loanById = new Map(t.loans.map(row => [row.id, row]))
    ensure(new Set(t.orders.map(row => row.order_number)).size === t.orders.length, 'order-identity', 'duplicate order number')
    for (const order of t.orders) {
        ensure(order.id && order.order_number && Number(order.version) >= 1, 'order-identity', order.id)
        ensure(['usd', 'eur', 'iqd', 'try'].includes(order.currency), 'commercial-arithmetic', `${order.id} currency`)
        ensure(Array.isArray(order.items) && order.items.length > 0, 'commercial-arithmetic', `${order.id} items`)
        ensure(new Set(order.items.map((line: Row) => line.id)).size === order.items.length, 'order-identity', `${order.id} line IDs`)
        for (const line of order.items) {
            ensure(products.has(line.productId), 'no-orphans', `${order.id} product ${line.productId}`)
            const factor = Number(line.unitFactor ?? 1)
            ensure(Number.isFinite(factor) && factor > 0 && Number(line.quantity) >= 0, 'unit-quantities', line.id)
            near(Number(line.inventoryQuantity ?? Number(line.quantity) * factor), quantity(Number(line.quantity) * factor), 'unit-quantities', `${line.id} paid`, 0.000001)
            near(Number(line.freeBonusInventoryQuantity ?? Number(line.freeBonusQuantity ?? 0) * factor), quantity(Number(line.freeBonusQuantity ?? 0) * factor), 'unit-quantities', `${line.id} free`, 0.000001)
            near(Number(line.lineTotal), money(Number(line.quantity) * Number(line.convertedUnitPrice)), 'commercial-arithmetic', `${line.id} total`)
        }
        const adjustments = Array.isArray(order.order_adjustments) ? order.order_adjustments.filter((row: Row) => row.scope !== 'post_return') : []
        const adjustment = adjustments.reduce((total: number, row: Row) => total + (row.type === 'addition' ? 1 : -1) * Number(row.convertedAmount), 0)
        const remainingShare = order.original_total_amount > 0 ? Number(order.total) / Number(order.original_total_amount) : 1
        near(Number(order.total), money(Math.max(0, Number(order.subtotal) - Number(order.discount) + Number(order.tax) + adjustment * remainingShare)), 'commercial-arithmetic', `${order.id} totals`)
        const financed = ['loan', 'installments'].includes(order.payment_method) || !!order.linked_loan_id
        const awaitingLoan = order.status === 'draft' && order.payment_method === 'loan' && !order.linked_loan_id
        const awaitingApproval = order.approval_status === 'requested'
        const payments = active(t.payments).filter(row => row.source_type === 'sales_order' && row.source_record_id === order.id)
        if (!financed && !awaitingApproval) near(Number(order.paid_amount), money(sum(payments, 'amount')), 'order-money', order.id)
        if (order.status === 'draft' && order.payment_method === 'installments' && !order.linked_loan_id && !awaitingApproval) near(Number(order.paid_amount), money(sum(payments, 'amount')), 'order-money', `${order.id} posted installment down payment`)
        if (!awaitingApproval && !awaitingLoan && order.status !== 'cancelled') near(Number(order.balance_amount), money(Math.max(0, Number(order.total) - Number(order.paid_amount))), 'order-money', `${order.id} balance`)
        if (awaitingApproval) ensure(payments.length === 0, 'order-money', 'approval request posted money')
        if (order.linked_loan_id) {
            const loan = loanById.get(order.linked_loan_id)
            ensure(loan && loan.order_id === order.id && loan.order_type === 'sales' && !loan.is_deleted, 'financing', order.id)
        }
        if (order.status === 'cancelled') {
            near(Number(order.paid_amount), 0, 'terminal-state', `${order.id} cancellation money`)
            ensure(!order.linked_loan_id, 'terminal-state', `${order.id} cancellation loan link`)
        }
        if (order.is_archived) ensure(order.status === 'cancelled' || order.status === 'returned' || (order.status === 'completed' && order.return_status === 'full'), 'terminal-state', `${order.id} archive eligibility`)
        if (order.status === 'completed') ensure(!!order.actual_delivery_date, 'audit-evidence', `${order.id} completion date`)
        const corrections = (order.order_adjustments ?? []).filter((row: Row) => row.scope === 'post_return')
        for (const correction of corrections) {
            ensure(returnById.get(correction.returnId)?.order_id === order.id && !!correction.createdAt, 'immutable-corrections', correction.id)
            ensure(Number(correction.amount) > 0 && Number.isFinite(Number(correction.convertedAmount)), 'immutable-corrections', `${correction.id} amount`)
        }
    }
    for (const row of t.movements) near(Number(row.new_quantity) - Number(row.previous_quantity), Number(row.quantity_delta), 'movement-history', row.id, 0.000001)
    for (const movement of active(t.movements).filter(row => ['sales_order_return', 'order_return'].includes(row.reference_type))) ensure(returnById.has(movement.reference_id), 'no-orphans', `${movement.id} stock restored without posted return`)
    for (const order of t.orders.filter(row => row.status === 'completed' && row.source_channel !== 'marketplace')) {
        const positions = new Map<string, number>()
        for (const line of order.items.filter((line: Row) => !products.get(line.productId)?.is_service)) {
            const key = `${line.productId}/${line.storageId}`
            positions.set(key, (positions.get(key) ?? 0) + Number(line.inventoryQuantity ?? Number(line.quantity) * Number(line.unitFactor ?? 1)) + Number(line.freeBonusInventoryQuantity ?? 0))
        }
        for (const [position, demand] of positions) {
            const movements = active(t.movements).filter(row => row.reference_id === order.id && row.reference_type === 'sales_order' && `${row.product_id}/${row.storage_id}` === position)
            near(sum(movements, 'quantity_delta'), -demand, 'stock-conservation', `${order.id}/${position} fulfillment`, 0.000001)
        }
    }
    for (const returned of active(t.returns)) {
        const positions = new Map<string, number>()
        for (const item of active(t.returnItems).filter(row => row.return_id === returned.id)) {
            const line = orderById.get(item.order_id)?.items.find((line: Row) => line.id === item.order_item_id)
            ensure(line, 'return-links', `${item.id} original line`)
            if (products.get(line.productId)?.is_service) continue
            const position = `${line.productId}/${item.restored_storage_id}`
            positions.set(position, (positions.get(position) ?? 0) + Number(item.inventory_quantity ?? item.quantity))
        }
        for (const [position, restoredQuantity] of positions) {
            const movements = active(t.movements).filter(row => row.reference_id === returned.id && ['sales_order_return', 'order_return'].includes(row.reference_type) && `${row.product_id}/${row.storage_id}` === position)
            near(sum(movements, 'quantity_delta'), restoredQuantity, 'stock-conservation', `${returned.id}/${position} return restoration`, 0.000001)
        }
    }
    for (const row of active(t.inventory)) {
        ensure(Number.isFinite(Number(row.quantity)) && Number(row.quantity) >= -0.000001, 'stock-conservation', row.id)
        const batches = active(t.batches).filter(batch => batch.product_id === row.product_id && batch.storage_id === row.storage_id)
        ensure(batches.every(batch => Number.isFinite(Number(batch.quantity)) && Number(batch.quantity) >= -0.000001), 'batch-conservation', row.id)
        ensure(sum(batches, 'quantity') <= Number(row.quantity) + 0.000001, 'batch-conservation', `${row.id} batches exceed position`)
    }
    if (baseline) {
        const oldMovementIds = new Set(baseline.tables.movements.map(row => row.id))
        for (const row of t.inventory) {
            const old = baseline.tables.inventory.find(item => item.id === row.id)
            if (!old) continue
            const changes = t.movements.filter(item => !oldMovementIds.has(item.id) && item.product_id === row.product_id && item.storage_id === row.storage_id && !item.is_deleted)
            near(Number(row.quantity), Number(old.quantity) + sum(changes, 'quantity_delta'), 'stock-conservation', row.id, 0.000001)
        }
        for (const old of baseline.tables.batches) {
            const current = t.batches.find(row => row.id === old.id)
            ensure(current, 'batch-conservation', `lost batch ${old.id}`)
            ensure(Number(current.quantity) >= -0.000001, 'batch-conservation', old.id)
        }
        for (const table of ['returns', 'returnItems']) for (const old of baseline.tables[table]) {
            const current = t[table].find(row => row.id === old.id)
            ensure(current && canonical(current) === canonical(old), 'immutable-corrections', `${table}/${old.id} history changed`)
        }
    }
    for (const original of t.payments.filter(row => Number(row.amount) > 0)) {
        const reversals = t.payments.filter(row => row.reversal_of_transaction_id === original.id && !row.is_deleted)
        ensure(sum(reversals, 'amount') >= -Number(original.amount) - 0.0005, 'payment-reversal-conservation', original.id)
        for (const reversal of reversals) {
            ensure(Number(reversal.amount) < 0 && reversal.currency === original.currency && reversal.source_record_id === original.source_record_id, 'payment-reversal-conservation', reversal.id)
            ensure(!original.is_deleted && !reversal.is_deleted, 'payment-reversal-conservation', 'hidden reversal history')
        }
    }
    for (const payment of active(t.payments)) {
        ensure(Number.isFinite(Number(payment.amount)) && Number(payment.amount) !== 0, 'per-currency-ledger', payment.id)
        ensure(['usd', 'eur', 'iqd', 'try'].includes(payment.currency), 'per-currency-ledger', `${payment.id} currency`)
        if (payment.reversal_of_transaction_id) ensure(paymentById.has(payment.reversal_of_transaction_id), 'no-orphans', `${payment.id} reversal link`)
        if (payment.source_type === 'sales_order') ensure(orderById.has(payment.source_record_id), 'no-orphans', `${payment.id} missing source order`)
        const movements = active(t.accountMovements).filter(row => row.payment_transaction_id === payment.id)
        if (payment.account_id) {
            ensure(movements.length === 1 && movements[0].account_id === payment.account_id, 'account-effects', payment.id)
            near(Number(movements[0].delta_amount), (payment.direction === 'outgoing' ? -1 : 1) * Number(payment.amount), 'account-effects', payment.id)
        } else ensure(movements.length === 0, 'account-effects', `${payment.id} no account`)
    }
    for (const balance of active(t.accountBalances)) {
        const movements = active(t.accountMovements).filter(row => row.account_id === balance.account_id && row.currency === balance.currency)
        near(Number(balance.balance_amount), money(sum(movements, 'delta_amount')), 'account-effects', balance.id)
    }
    for (const loan of active(t.loans)) {
        ensure(orderById.has(loan.order_id) && loan.order_type === 'sales', 'no-orphans', loan.id)
        ensure(Number(loan.balance_amount) >= -0.0005 && Number(loan.total_paid_amount) >= 0, 'financing', `${loan.id} balances`)
        const installments = active(t.loanInstallments).filter(row => row.loan_id === loan.id)
        ensure(installments.length > 0, 'schedule', `${loan.id} empty schedule`)
        near(sum(installments, 'balance_amount'), Number(loan.balance_amount), 'schedule', `${loan.id} outstanding`)
        ensure(new Set(installments.map(row => row.installment_no)).size === installments.length, 'schedule', `${loan.id} duplicate number`)
    }
    for (const receipt of active(t.loanPayments)) {
        ensure(loanById.has(receipt.loan_id), 'no-orphans', receipt.id)
        const payment = paymentById.get(receipt.payment_transaction_id)
        ensure(payment && payment.source_record_id === receipt.loan_id, 'financing', `${receipt.id} transaction`)
        const reversed = active(t.payments).filter(row => row.reversal_of_transaction_id === payment.id)
        near(Number(receipt.amount), money(Number(payment.amount) + sum(reversed, 'amount')), 'financing', `${receipt.id} remaining amount`)
    }
    for (const item of active(t.returnItems)) {
        const returned = returnById.get(item.return_id)
        const order = orderById.get(item.order_id)
        ensure(returned?.order_id === item.order_id && order?.items.some((line: Row) => line.id === item.order_item_id), 'return-links', item.id)
        near(Number(item.inventory_quantity ?? item.quantity), Number(item.paid_inventory_quantity ?? item.quantity) + Number(item.free_inventory_quantity ?? 0), 'return-links', `${item.id} parts`, 0.000001)
        near(Number(item.paid_inventory_quantity ?? item.quantity), quantity(Number(item.paid_selected_unit_quantity ?? item.selected_unit_quantity ?? item.quantity) * Number(item.unit_factor ?? 1)), 'return-links', `${item.id} factor`, 0.000001)
    }
    for (const returned of active(t.returns)) {
        const order = orderById.get(returned.order_id)
        ensure(order && returned.status === 'posted' && !!returned.reason && !!returned.returned_at, 'return-links', returned.id)
        near(sum(active(t.returnItems).filter(row => row.return_id === returned.id), 'refund_amount'), Number(returned.refund_amount), 'return-links', `${returned.id} value`)
    }
    for (const order of t.orders) for (const line of order.items) {
        const returnedLines = active(t.returnItems).filter(item => item.order_id === order.id && item.order_item_id === line.id)
        const paid = sum(returnedLines, 'paid_inventory_quantity')
        const free = sum(returnedLines, 'free_inventory_quantity')
        ensure(paid <= Number(line.inventoryQuantity ?? Number(line.quantity) * Number(line.unitFactor ?? 1)) + 0.000001, 'return-links', `${line.id} paid over-return`)
        ensure(free <= Number(line.freeBonusInventoryQuantity ?? 0) + 0.000001, 'return-links', `${line.id} free over-return`)
    }
    for (const order of t.orders.filter(row => row.return_status && row.return_status !== 'none')) {
        near(Number(order.original_total_amount) - Number(order.total), Number(order.returned_amount), 'financed-return-value', order.id)
        near(sum(active(t.returns).filter(row => row.order_id === order.id), 'refund_amount'), Number(order.returned_amount), 'financed-return-value', `${order.id} return total`)
    }
    for (const table of ['commissions', 'productCommissions', 'trackedCommissions', 'trackedProductCommissions']) for (const row of active(t[table])) {
        ensure(orderById.has(row.order_id) && t.assignments.some(assignment => assignment.id === row.assignment_id && assignment.order_id === row.order_id), 'commission-effects', row.id)
        ensure(Number.isFinite(Number(row.amount)), 'commission-effects', `${row.id} amount`)
        if (table.startsWith('tracked')) ensure(!['payout', 'recovery'].includes(row.kind), 'commission-effects', 'tracked monetary settlement')
    }
    for (const invoice of t.invoices) ensure(orderById.has(invoice.order_id) && invoice.origin === 'sales_order', 'invoice-metadata', invoice.id)
    for (const version of t.invoiceVersions) ensure(t.invoices.some(row => row.id === version.invoice_id) && Number(version.version_number) > 0, 'invoice-metadata', version.id)
    // Workflow properties such as replay identity and atomic rejection belong to explicit step assertions.
    return INVARIANTS.filter(invariant => !['idempotency', 'atomicity-and-recovery'].includes(invariant))
}
