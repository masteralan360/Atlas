import Dexie from 'dexie'
import i18n from '@/i18n/config'
import { getActiveBusinessUserId, getActiveBusinessUserRole, isOnline } from '@/lib/network'
import { generateId, toCamelCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { supabase } from '@/auth/supabase'
import { prepareRemoteMutationPayload } from '@/sync/syncPayloadContract'
import { db } from './database'
import { readStockAliases, persistStockAliases, resolveStockAlias, resolveStockEffect, resolveStockRow, type StockOperationAliases } from './offlineStockAliases'
import { queryClient } from '@/query/queryClient'
import { queryKeys } from '@/query/queryKeys'
import type { PaymentTransaction } from './models'
import { replaceOfflineStockAvailability } from './offlineStockAvailability'
import { STOCK_EFFECT_TABLES, attachStockOperation, currentStockOperation, type StockOperationContext, type StockOperationEffect, type StockOperationKind, type StockOperationRpc } from './offlineStockContext'

export interface OfflineStockOperation {
  version: 1
  id: string
  workspaceId: string
  actorId: string
  kind: StockOperationKind
  sequence: number
  dependencies: string[]
  effects: StockOperationEffect[]
  rpc?: StockOperationRpc
  count?: StockOperationContext['count']
}

// Derived balances and account movements are deliberately excluded. Their
// authority is payment_transactions; server triggers create the projections.

let installed = false

function refreshOperationQueries(workspaceId: string) {
  for (const queryKey of [queryKeys.invoiceHistory.all(workspaceId), queryKeys.stockAdjustments.all(workspaceId), queryKeys.stockReservations.all(workspaceId), queryKeys.inventoryTransactions.all(workspaceId), queryKeys.stockBatches.all(workspaceId), queryKeys.orders.all(workspaceId, 'sales'), queryKeys.orders.all(workspaceId, 'purchase')]) {
    void queryClient.invalidateQueries({ queryKey })
  }
}

function effectResources(effect: StockOperationEffect) {
  const row = effect.after ?? effect.before
  return [`${effect.table}:${effect.id}`, ...(effect.table === 'inventory' && row
    ? [`inventory-position:${row.workspaceId}:${row.productId}:${row.storageId}`] : [])]
}

function capture(table: string, id: unknown, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const context = currentStockOperation()
  if (!context || typeof id !== 'string') return
  const row = after ?? before
  if (row?.workspaceId !== context.workspaceId) throw new Error(i18n.t('inventory.offline.workspaceMismatch'))
  const key = `${table}:${id}`
  const previous = context.effects.get(key)
  context.effects.set(key, { table, id, before: previous ? previous.before : structuredClone(before), after: structuredClone(after) })
}

function installCapture() {
  if (installed) return
  installed = true
  for (const table of db.tables.filter(table => STOCK_EFFECT_TABLES.has(table.name))) {
    table.hook('creating', (key, row) => { capture(table.name, key ?? row.id, null, row) })
    table.hook('updating', (mods, key, row) => {
      const next = structuredClone(row)
      for (const [path, value] of Object.entries(mods)) Dexie.setByKeyPath(next, path, value)
      capture(table.name, key, row, next)
    })
    table.hook('deleting', (key, row) => { capture(table.name, key, row, null) })
  }
}

export async function needsOfflineStockOperation(workspaceId: string) {
  if (isLocalWorkspaceMode(workspaceId) || currentStockOperation(workspaceId)) return false
  if (!isOnline(workspaceId)) return true
  // Preserve ordering when connectivity has returned but earlier work is not
  // confirmed yet. A new online write must not jump ahead of the outbox.
  return await db.offline_mutations.where('workspaceId').equals(workspaceId)
    .filter(row => row.entityType === 'stock_operations' && row.status !== 'synced' && row.status !== 'discarded').count() > 0
}

export async function runOfflineStockOperation<T>(workspaceId: string, kind: StockOperationKind, task: () => Promise<T>, options: { id?: string; rpc?: StockOperationRpc } = {}): Promise<T> {
  if (currentStockOperation(workspaceId) || isLocalWorkspaceMode(workspaceId)) return task()
  const actorId = getActiveBusinessUserId()
  if (!actorId || !['admin', 'staff'].includes(getActiveBusinessUserRole(workspaceId) ?? '')) throw new Error(i18n.t('inventory.offline.identityRequired'))
  // Resolve lazy domain modules before opening IndexedDB's write transaction.
  // Native dynamic imports inside an active transaction can auto-commit it.
  if (kind === 'sales_order' || kind === 'purchase_order' || kind === 'return' || kind === 'exchange') {
    await Promise.all([import('./agentCommissions'), import('./reorderTransferRules'), import('./orderCancellation'), import('./payments'), import('./businessPartners')])
  }
  installCapture()
  const outcome = await db.transaction('rw', db.tables, async transaction => {
    const id = options.id ?? generateId()
    const existing = await db.offline_mutations.get(id)
    if (existing) throw new Error(i18n.t('inventory.offline.alreadyRecorded'))
    const context: StockOperationContext = { id, workspaceId, kind, effects: new Map(), rpc: options.rpc }
    attachStockOperation(transaction, context)
    const result = await task()
    const effects = [...context.effects.values()]
    if (!effects.length) return result
    if (effects.length > 2000) throw new Error(i18n.t('inventory.offline.operationTooLarge'))
    const cancelledOrder = effects.find(effect => ['sales_orders', 'purchase_orders'].includes(effect.table)
      && effect.after?.status === 'cancelled' && effect.before?.linkedLoanId)
    if (cancelledOrder) context.rpc = { name: 'cancel_order_with_financing', args: {
      p_order_type: cancelledOrder.table === 'sales_orders' ? 'sales' : 'purchase', p_order_id: cancelledOrder.id,
    } }
    if (!context.rpc && kind === 'return') {
      const returned = effects.find(effect => effect.table === 'sale_returns')?.after
      if (returned) context.rpc = { name: 'process_sale_return_with_loan', args: {
        p_return_id: returned.id, p_sale_id: returned.saleId, p_return_reason: returned.reason, p_refund_method: null,
        p_items: effects.filter(effect => effect.table === 'sale_return_items').map(effect => ({ id: effect.id, sale_item_id: effect.after?.saleItemId, quantity: effect.after?.quantity })),
      } }
    }
    // Independent incoming receipts can repair a shortage without depending on
    // the rejected outgoing sale. Document, batch and financial dependencies
    // still retain their order; absolute counts are never reordered this way.
    const inventoryEffects = effects.filter(effect => effect.table === 'inventory')
    const incoming = !context.count && (kind === 'purchase_order' || kind === 'adjustment') && inventoryEffects.length > 0
      && inventoryEffects.every(effect => Number(effect.after?.quantity ?? 0) >= Number(effect.before?.quantity ?? 0))
    const keys = new Set(effects.filter(effect => !incoming || !['inventory', 'products', 'inventory_transactions'].includes(effect.table)).flatMap(effectResources))
    const latest = new Map<string, { id: string; sequence: number }>()
    let sequence = 1
    await db.offline_mutations.where('workspaceId').equals(workspaceId).each(row => {
      if (row.entityType !== 'stock_operations' || row.status === 'synced' || row.status === 'discarded') return
      const previousSequence = Number(row.payload.sequence) || 0
      sequence = Math.max(sequence, previousSequence + 1)
      for (const effect of (row.payload.effects as StockOperationEffect[] | undefined) ?? []) {
        for (const key of effectResources(effect)) {
          if (keys.has(key) && row.stockCancelRequested) throw new Error(i18n.t('inventory.offline.processing'))
          if (keys.has(key) && previousSequence >= (latest.get(key)?.sequence ?? -1)) latest.set(key, { id: row.id, sequence: previousSequence })
        }
      }
    })
    const dependencies = [...new Set([...latest.values()].map(row => row.id))]
    const payload: OfflineStockOperation = { version: 1, id, workspaceId, actorId, kind, sequence, dependencies, effects, ...(context.rpc ? { rpc: context.rpc } : {}), ...(context.count ? { count: context.count } : {}) }
    // Capture is detached before marking the projection pending; the immutable
    // operation describes business effects, not synchronization bookkeeping.
    context.effects.clear()
    attachStockOperation(transaction, { ...context, effects: new Map() })
    for (const effect of effects) {
      if (effect.after) await db.table(effect.table).update(effect.id, { syncStatus: 'pending', lastSyncedAt: null })
    }
    await db.offline_mutations.add({ id, workspaceId, entityType: 'stock_operations', entityId: id, operation: 'create', payload: payload as unknown as Record<string, unknown>, createdAt: new Date().toISOString(), status: 'pending' })
    return result
  })
  refreshOperationQueries(workspaceId)
  return outcome
}

export async function replayOfflineStockOperation(payload: OfflineStockOperation, discardCount = false) {
  if (payload.version !== 1 || payload.actorId !== getActiveBusinessUserId()) throw new Error(i18n.t('inventory.offline.identityRequired'))
  const dependencies = await db.offline_mutations.bulkGet(payload.dependencies)
  for (const dependency of dependencies) {
    if (!dependency || dependency.status !== 'synced') throw new Error(i18n.t('inventory.offline.dependencyPending'))
  }
  const aliases = await readStockAliases(payload.workspaceId, payload.actorId, [payload])
  const resolved = { ...payload, effects: payload.effects.map(effect => {
    const mapped = resolveStockEffect(aliases, effect)
    const beforeVersion = Number(effect.before?.version)
    if (effect.before && Number.isFinite(beforeVersion)) {
      const revision = dependencies.flatMap(parent => Object.entries(parent?.stockRevisions ?? {})
        .filter(([key, item]) => key.startsWith(`${effect.table}:`) && item.localVersion === beforeVersion
          && (key === `${effect.table}:${effect.id}` || item.serverId === mapped.id)).map(([, item]) => item))[0]
      if (revision) {
        mapped.before = { ...mapped.before, version: revision.serverVersion }
        if (mapped.after && Number.isFinite(Number(effect.after?.version))) mapped.after.version = revision.serverVersion+Number(effect.after?.version)-beforeVersion
      }
    }
    return mapped
  }) }
  const rpc = payload.rpc ? structuredClone(payload.rpc) : undefined
  if (rpc?.args.p_return_sale_item_id) rpc.args.p_return_sale_item_id = resolveStockAlias(aliases, 'sale_items', rpc.args.p_return_sale_item_id)
  if (Array.isArray(rpc?.args.p_items)) rpc.args.p_items = rpc.args.p_items.map(item => ({ ...item, sale_item_id: resolveStockAlias(aliases, 'sale_items', item.sale_item_id) }))
  const { data, error } = await supabase.rpc(discardCount ? 'cancel_offline_stock_count' : 'apply_offline_stock_operation', {
    p_operation: {
      ...resolved, ...(rpc ? { rpc } : {}),
      effects: resolved.effects.map(effect => ({ ...effect,
        before: effect.before ? prepareRemoteMutationPayload(effect.table, effect.before) : null,
        after: effect.after ? prepareRemoteMutationPayload(effect.table, effect.after) : null,
      })),
    },
  })
  if (error) throw error
  if (!data || data.id !== payload.id || !Array.isArray(data.rows)) throw new Error(i18n.t('inventory.errors.authoritativeResultMissing'))
  const [{ mirrorPaymentAccountTransactionLocally }, { syncProductStockSnapshot }] = await Promise.all([import('./paymentAccounts'), import('./inventory')])
  await db.transaction('rw', db.tables, async () => {
    if ((await db.offline_mutations.get(payload.id))?.status === 'synced') return
    const later = await db.offline_mutations.where('workspaceId').equals(payload.workspaceId)
      .filter(row => row.entityType === 'stock_operations' && row.id !== payload.id && row.status !== 'synced' && row.status !== 'discarded').toArray()
    if (data.discarded) {
      for (const effect of payload.effects) if (effect.table === 'inventory_transactions' && !effect.before) await db.inventory_transactions.delete(effect.id)
    }
    const newAliases = (data.aliases ?? []) as StockOperationAliases
    const allAliases = [...await readStockAliases(payload.workspaceId, payload.actorId, [payload, ...later.map(row => row.payload)]), ...newAliases]
    for (const alias of newAliases) {
      if (!STOCK_EFFECT_TABLES.has(alias.table) || typeof alias.from !== 'string' || typeof alias.to !== 'string'
        || !resolved.effects.some(effect => effect.table === alias.table && effect.id === alias.from)
        || !data.rows.some((confirmed: { table: string; row: { id?: string } }) => confirmed.table === alias.table && confirmed.row.id === alias.to)) {
        throw new Error(i18n.t('inventory.errors.authoritativeResultMissing'))
      }
      const previous = await db.table(alias.table).get(alias.from)
      if (previous?.workspaceId !== payload.workspaceId) throw new Error(i18n.t('inventory.offline.workspaceMismatch'))
      if (alias.table === 'payment_transactions') await mirrorPaymentAccountTransactionLocally({ ...previous, isDeleted: true })
      await db.table(alias.table).put(resolveStockRow(allAliases, alias.table, previous))
      await db.table(alias.table).delete(alias.from)
    }
    await persistStockAliases(payload.workspaceId, payload.actorId, newAliases)
    const stockRevisions: NonNullable<import('./models').OfflineMutation['stockRevisions']> = {}
    for (const operation of later) {
      for (const original of (operation.payload as unknown as OfflineStockOperation).effects) {
        const effect = resolveStockEffect(allAliases, original)
        const previous = await db.table(original.table).get(original.id) ?? await db.table(effect.table).get(effect.id)
        if (previous && previous.workspaceId === payload.workspaceId) await db.table(effect.table).put(resolveStockRow(allAliases, effect.table, previous))
      }
    }
    for (const confirmed of data.rows as { table: string; row: Record<string, unknown> }[]) {
      if (!STOCK_EFFECT_TABLES.has(confirmed.table)) throw new Error(i18n.t('inventory.errors.authoritativeResultMissing'))
      const row = toCamelCase(confirmed.row) as Record<string, unknown>
      if (row.workspaceId !== payload.workspaceId || typeof row.id !== 'string') throw new Error(i18n.t('inventory.offline.workspaceMismatch'))
      const sourceIndex = resolved.effects.findIndex(effect => effect.table === confirmed.table && (effect.id === row.id
        || newAliases.some(alias => alias.table === effect.table && alias.from === effect.id && alias.to === row.id)
        || (effect.table === 'inventory' && effect.after?.productId === row.productId && effect.after?.storageId === row.storageId)))
      const source = payload.effects[sourceIndex]
      if (source?.after && Number.isFinite(Number(source.after.version)) && Number.isFinite(Number(row.version))) {
        stockRevisions[`${source.table}:${source.id}`] = { localVersion: Number(source.after.version), serverVersion: Number(row.version), serverId: row.id }
      }
      const remaining = later.flatMap(item => (item.payload as unknown as OfflineStockOperation).effects.map(effect => resolveStockEffect(allAliases, effect)))
        .filter(effect => effect.table === confirmed.table && (effect.id === row.id || (confirmed.table === 'inventory' && effect.after?.productId === row.productId && effect.after?.storageId === row.storageId)))
      if (remaining.length) {
        if (confirmed.table === 'inventory' || confirmed.table === 'stock_batches') {
          const local = await db.table(confirmed.table).get(remaining[remaining.length - 1].id)
          const delta = remaining.reduce((sum, effect) => sum + Number(effect.after?.quantity ?? 0) - Number(effect.before?.quantity ?? 0), 0)
          await db.table(confirmed.table).put({ ...row, ...local, quantity: Number(row.quantity ?? 0) + delta, syncStatus: 'pending', lastSyncedAt: new Date().toISOString() })
        }
        continue
      }
      await db.table(confirmed.table).put({ ...row, syncStatus: 'synced', lastSyncedAt: new Date().toISOString() })
      if (confirmed.table === 'sales' && row.sequenceId) await db.invoices.update(row.id, {
        sequenceId: row.sequenceId as number, invoiceid: `#${String(row.sequenceId).padStart(5, '0')}`, syncStatus: 'synced', lastSyncedAt: new Date().toISOString(),
      })
      if (confirmed.table === 'payment_transactions') await mirrorPaymentAccountTransactionLocally({ ...row, syncStatus: 'synced', lastSyncedAt: new Date().toISOString() } as unknown as PaymentTransaction)
    }
    for (const operation of later) {
      for (const effect of (operation.payload as unknown as OfflineStockOperation).effects) {
        if (effect.table === 'payment_transactions' && effect.after) {
          const payment = await db.payment_transactions.get(resolveStockAlias(allAliases, 'payment_transactions', effect.id) as string)
          if (payment) await mirrorPaymentAccountTransactionLocally({ ...payment, syncStatus: 'pending' })
        }
      }
    }
    await db.offline_mutations.update(payload.id, { status: data.discarded ? 'discarded' : 'synced', stockRevisions, stockCancelRequested: undefined, error: undefined, syncLeaseId: undefined, syncLeaseUntil: undefined, nextAttemptAt: undefined })
    const productIds = [...new Set(payload.effects.filter(effect => effect.table === 'inventory').map(effect => effect.after?.productId as string))]
    for (const productId of productIds) {
      const before = await db.products.get(productId)
      await syncProductStockSnapshot(productId, new Date().toISOString(), 'remote')
      if (later.some(row => (row.payload as unknown as OfflineStockOperation).effects.some(effect => effect.table === 'products' && effect.id === productId
        || effect.table === 'inventory' && effect.after?.productId === productId))) {
        await db.products.update(productId, { syncStatus: before?.syncStatus === 'conflict' ? 'conflict' : 'pending', lastSyncedAt: null })
      }
    }
    const orderIds = [...new Set(payload.effects.filter(effect => effect.table === 'sales_orders').map(effect => effect.id))]
    if (!data.discarded && (productIds.length || orderIds.length)) await db.app_settings.put({ workspaceId: payload.workspaceId, key: `stock-followup:v1:${payload.workspaceId}:${payload.actorId}:${payload.id}`,
      value: JSON.stringify({ workspaceId: payload.workspaceId, actorId: payload.actorId, operationId: payload.id, productIds, orderIds }) })
    if (Array.isArray(data.availability)) await replaceOfflineStockAvailability(payload.workspaceId, data.availability, payload.effects.filter(effect => effect.table === 'inventory').map(effect => ({ productId: String(effect.after?.productId), storageId: String(effect.after?.storageId) })))
  })
  refreshOperationQueries(payload.workspaceId)
}


export async function discardOfflineStockCount(id: string) {
  const mutation = await db.offline_mutations.get(id)
  const payload = mutation?.payload as unknown as OfflineStockOperation | undefined
  if (!mutation || (mutation.status !== 'failed' && !mutation.stockCancelRequested) || !payload || payload.kind !== 'adjustment' || !payload.count
    || !isOnline(payload.workspaceId) || payload.actorId !== getActiveBusinessUserId()
    || payload.effects.some(effect => !['inventory', 'inventory_transactions', 'products'].includes(effect.table))) {
    throw new Error(i18n.t('inventory.offline.discardUnavailable'))
  }
  await db.transaction('rw', db.offline_mutations, async () => {
    const dependants = await db.offline_mutations.where('workspaceId').equals(payload.workspaceId)
      .filter(row => row.entityType === 'stock_operations' && row.status !== 'synced' && row.status !== 'discarded'
        && ((row.payload as unknown as OfflineStockOperation).dependencies ?? []).includes(id)).count()
    if (dependants) throw new Error(i18n.t('inventory.offline.dependentHelp'))
    await db.offline_mutations.update(id, { stockCancelRequested: true })
  })
  try {
    await replayOfflineStockOperation(payload, true)
  } catch (cause) {
    throw Object.assign(new Error(i18n.t('inventory.offline.retryPending')), { cause })
  } finally {
    const current = await db.offline_mutations.get(id)
    if (current?.status === 'synced' || current?.status === 'discarded') await db.offline_mutations.update(id, { stockCancelRequested: undefined })
  }
}
