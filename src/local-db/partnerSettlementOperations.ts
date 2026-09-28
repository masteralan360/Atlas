import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { toSnakeCase } from '@/lib/utils'
import { isOnline } from '@/lib/network'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { addToOfflineMutations } from './offlineMutations'
import { db } from './database'
import type { PartnerSettlementOperation, PaymentTransaction } from './models'

type NewPartnerSettlementOperation = Omit<
  PartnerSettlementOperation,
  'createdAt' | 'updatedAt' | 'version' | 'isDeleted' | 'syncStatus' | 'lastSyncedAt'
> & { id: string }

function syncMetadata(workspaceId: string, timestamp: string) {
  return isLocalWorkspaceMode(workspaceId)
    ? { syncStatus: 'synced' as const, lastSyncedAt: timestamp }
    : { syncStatus: 'pending' as const, lastSyncedAt: null }
}

async function markPendingMutationSynced(entityType: 'partner_settlement_operations' | 'payment_transactions', entityId: string) {
  const pendingIds = await db.offline_mutations
    .where('[entityType+entityId+status]')
    .equals([entityType, entityId, 'pending'])
    .primaryKeys()
  if (pendingIds.length > 0) {
    await db.offline_mutations.bulkUpdate(pendingIds.map((id) => ({
      key: id,
      changes: { status: 'synced' as const, error: undefined }
    })))
  }
}

async function saveOperation(operation: PartnerSettlementOperation, mutation: 'create' | 'update') {
  await db.partner_settlement_operations.put(operation)
  if (isLocalWorkspaceMode(operation.workspaceId)) return operation

  if (!isOnline(operation.workspaceId)) {
    await addToOfflineMutations(
      'partner_settlement_operations',
      operation.id,
      mutation,
      operation as unknown as Record<string, unknown>,
      operation.workspaceId
    )
    return operation
  }

  try {
    const client = getSupabaseClientForTable('partner_settlement_operations')
    const payload = toSnakeCase({
      ...operation,
      syncStatus: undefined,
      lastSyncedAt: undefined
    })
    const { error } = await client
      .from('partner_settlement_operations')
      .upsert(payload, { onConflict: 'id' })
    if (error) throw error

    const syncedAt = new Date().toISOString()
    const syncedOperation = { ...operation, syncStatus: 'synced' as const, lastSyncedAt: syncedAt }
    await db.partner_settlement_operations.put(syncedOperation)
    await markPendingMutationSynced('partner_settlement_operations', operation.id)
    return syncedOperation
  } catch (error) {
    console.warn('[Payments] Settlement operation sync is queued:', error)
    await addToOfflineMutations(
      'partner_settlement_operations',
      operation.id,
      mutation,
      operation as unknown as Record<string, unknown>,
      operation.workspaceId
    )
    return operation
  }
}

export async function createPartnerSettlementOperation(input: NewPartnerSettlementOperation) {
  const now = new Date().toISOString()
  const operation: PartnerSettlementOperation = {
    ...input,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...syncMetadata(input.workspaceId, now)
  }
  return saveOperation(operation, 'create')
}

export async function finishPartnerSettlementOperation(
  operationId: string,
  status: PartnerSettlementOperation['status']
) {
  const current = await db.partner_settlement_operations.get(operationId)
  if (!current) return null
  const now = new Date().toISOString()
  const operation: PartnerSettlementOperation = {
    ...current,
    status,
    updatedAt: now,
    version: current.version + 1,
    ...syncMetadata(current.workspaceId, now)
  }
  return saveOperation(operation, 'update')
}

/** Attach an individual posted payment to its user action without changing its accounting values. */
export async function linkPaymentTransactionToSettlement(
  workspaceId: string,
  transactionId: string,
  settlementOperationId: string
): Promise<PaymentTransaction | null> {
  const transaction = await db.payment_transactions.get(transactionId)
  if (!transaction || transaction.workspaceId !== workspaceId || transaction.isDeleted) return null
  if (transaction.settlementOperationId === settlementOperationId) return transaction

  const now = new Date().toISOString()
  const linked: PaymentTransaction = {
    ...transaction,
    settlementOperationId,
    updatedAt: now,
    version: transaction.version + 1,
    ...syncMetadata(workspaceId, now)
  }
  await db.payment_transactions.put(linked)
  if (isLocalWorkspaceMode(workspaceId)) return linked

  if (isOnline(workspaceId)) {
    try {
      const client = getSupabaseClientForTable('payment_transactions')
      const payload = toSnakeCase({
        settlementOperationId,
        updatedAt: now,
        version: linked.version
      })
      const { error } = await client
        .from('payment_transactions')
        .update(payload)
        .eq('id', transactionId)
        .eq('workspace_id', workspaceId)
        .select('id')
        .single()
      if (error) throw error

      const synced = { ...linked, syncStatus: 'synced' as const, lastSyncedAt: new Date().toISOString() }
      await db.payment_transactions.put(synced)
      await markPendingMutationSynced('payment_transactions', transactionId)
      return synced
    } catch (error) {
      console.warn('[Payments] Settlement link sync is queued:', error)
    }
  }

  await addToOfflineMutations(
    'payment_transactions',
    linked.id,
    'update',
    linked as unknown as Record<string, unknown>,
    workspaceId
  )
  return linked
}
