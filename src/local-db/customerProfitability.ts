import { useLiveQuery } from 'dexie-react-hooks'

import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isOnline } from '@/lib/network'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import type {
  CustomerProfitabilityAttribution,
  CustomerProfitabilityEngagement,
  CustomerProfitabilityFinancialKind,
  CustomerProfitabilitySourceType,
  SyncStatus,
} from './models'

type CustomerProfitabilityTable =
  | 'customer_profitability_engagements'
  | 'customer_profitability_attributions'

type CustomerProfitabilityEntity =
  | CustomerProfitabilityEngagement
  | CustomerProfitabilityAttribution

function getSyncMetadata(workspaceId: string, timestamp: string) {
  return isLocalWorkspaceMode(workspaceId)
    ? { syncStatus: 'synced' as const, lastSyncedAt: timestamp }
    : { syncStatus: 'pending' as const, lastSyncedAt: null }
}

async function assertCustomerProfitabilityLinks(
  workspaceId: string,
  businessPartnerId: string,
  engagementId?: string | null,
  vehicleId?: string | null,
) {
  const partner = await db.business_partners.get(businessPartnerId)
  if (
    !partner
    || partner.isDeleted
    || partner.workspaceId !== workspaceId
    || !['customer', 'both', 'online_customer'].includes(partner.role)
  ) {
    throw new Error('Select a customer in this workspace')
  }

  if (engagementId) {
    const engagement = await db.customer_profitability_engagements.get(engagementId)
    if (
      !engagement
      || engagement.isDeleted
      || !engagement.isActive
      || engagement.workspaceId !== workspaceId
      || engagement.businessPartnerId !== businessPartnerId
    ) {
      throw new Error('Select an active engagement for this customer')
    }
  }

  if (vehicleId) {
    const vehicle = await db.fleet_vehicles.get(vehicleId)
    if (!vehicle || vehicle.isDeleted || vehicle.workspaceId !== workspaceId) {
      throw new Error('Select a vehicle in this workspace')
    }
  }
}

function getTable(tableName: CustomerProfitabilityTable) {
  return tableName === 'customer_profitability_engagements'
    ? db.customer_profitability_engagements
    : db.customer_profitability_attributions
}

async function persistEntity(
  tableName: CustomerProfitabilityTable,
  entity: CustomerProfitabilityEntity,
  operation: 'create' | 'update',
) {
  const table = getTable(tableName)
  const workspaceId = entity.workspaceId
  const cloudEnabled = !isLocalWorkspaceMode(workspaceId)
  let next = entity

  if (cloudEnabled && isOnline(workspaceId)) {
    const payload = toSnakeCase(entity as unknown as Record<string, unknown>)
    delete payload.sync_status
    delete payload.last_synced_at
    try {
      const { error } = await runSupabaseAction(`${tableName}.sync`, () =>
        getSupabaseClientForTable(tableName).from(tableName).upsert(payload),
      )
      if (error) throw error
      next = { ...entity, syncStatus: 'synced' as SyncStatus, lastSyncedAt: new Date().toISOString() }
    } catch (error) {
      console.error(`[Customer Profitability] Failed to sync ${tableName}:`, error)
      await addToOfflineMutations(
        tableName,
        entity.id,
        operation,
        entity as unknown as Record<string, unknown>,
        workspaceId,
      )
    }
  } else if (cloudEnabled) {
    await addToOfflineMutations(
      tableName,
      entity.id,
      operation,
      entity as unknown as Record<string, unknown>,
      workspaceId,
    )
  }

  await table.put(next as never)
  return next
}

export async function saveCustomerProfitabilityEngagement(
  workspaceId: string,
  input: Pick<CustomerProfitabilityEngagement, 'businessPartnerId' | 'name' | 'notes' | 'isActive'>,
  existing?: CustomerProfitabilityEngagement | null,
) {
  await assertCustomerProfitabilityLinks(workspaceId, input.businessPartnerId)
  const now = new Date().toISOString()
  const entity: CustomerProfitabilityEngagement = existing
    ? {
        ...existing,
        ...input,
        name: input.name.trim(),
        notes: input.notes?.trim() || null,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(workspaceId, now),
      }
    : {
        id: generateId(),
        workspaceId,
        ...input,
        name: input.name.trim(),
        notes: input.notes?.trim() || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now),
      }

  return persistEntity(
    'customer_profitability_engagements',
    entity,
    existing ? 'update' : 'create',
  )
}

export async function saveCustomerProfitabilityAttribution(
  workspaceId: string,
  input: {
    sourceType: CustomerProfitabilitySourceType
    sourceRecordId: string
    sourceSubrecordId?: string | null
    financialKind: CustomerProfitabilityFinancialKind
    businessPartnerId: string
    engagementId?: string | null
    vehicleId?: string | null
  },
) {
  await assertCustomerProfitabilityLinks(
    workspaceId,
    input.businessPartnerId,
    input.engagementId,
    input.vehicleId,
  )
  const sourceSubrecordId = input.sourceSubrecordId ?? ''
  const existing = await db.customer_profitability_attributions
    .where('[workspaceId+sourceType+sourceRecordId+sourceSubrecordId]')
    .equals([workspaceId, input.sourceType, input.sourceRecordId, sourceSubrecordId])
    .first()
  const now = new Date().toISOString()
  const entity: CustomerProfitabilityAttribution = existing
    ? {
        ...existing,
        ...input,
        sourceSubrecordId,
        engagementId: input.engagementId || null,
        vehicleId: input.vehicleId || null,
        isDeleted: false,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(workspaceId, now),
      }
    : {
        id: generateId(),
        workspaceId,
        ...input,
        sourceSubrecordId,
        engagementId: input.engagementId || null,
        vehicleId: input.vehicleId || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now),
      }

  return persistEntity(
    'customer_profitability_attributions',
    entity,
    existing ? 'update' : 'create',
  )
}

export async function unlinkCustomerProfitabilitySource(
  workspaceId: string,
  sourceType: CustomerProfitabilitySourceType,
  sourceRecordId: string,
  sourceSubrecordId = '',
) {
  const existing = await db.customer_profitability_attributions
    .where('[workspaceId+sourceType+sourceRecordId+sourceSubrecordId]')
    .equals([workspaceId, sourceType, sourceRecordId, sourceSubrecordId])
    .first()
  if (!existing) return

  const now = new Date().toISOString()
  await persistEntity('customer_profitability_attributions', {
    ...existing,
    isDeleted: true,
    updatedAt: now,
    version: existing.version + 1,
    ...getSyncMetadata(workspaceId, now),
  }, 'update')
}

export function useCustomerProfitabilityEngagements(workspaceId: string | undefined) {
  return useLiveQuery(
    () => workspaceId
      ? db.customer_profitability_engagements.where('workspaceId').equals(workspaceId)
        .and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []
}

export function useCustomerProfitabilityAttributions(workspaceId: string | undefined) {
  return useLiveQuery(
    () => workspaceId
      ? db.customer_profitability_attributions.where('workspaceId').equals(workspaceId)
        .and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  ) ?? []
}

export interface CustomerProfitabilitySourceAccess {
  expenses: boolean
  payroll: boolean
  directTransactions: boolean
}

export function useCustomerProfitabilitySourceRows(
  workspaceId: string | undefined,
  access: CustomerProfitabilitySourceAccess,
) {
  return useLiveQuery(async () => {
    if (!workspaceId) return { expenses: [], expenseSeries: [], payments: [] }
    const [expenses, expenseSeries, payments] = await Promise.all([
      access.expenses
        ? db.expense_items.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted && !row.voidId && row.status === 'paid').toArray()
        : Promise.resolve([]),
      access.expenses
        ? db.expense_series.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted && !row.voidId).toArray()
        : Promise.resolve([]),
      access.payroll || access.directTransactions
        ? db.payment_transactions.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted && !row.voidId).toArray()
        : Promise.resolve([]),
    ])
    return { expenses, expenseSeries, payments }
  }, [workspaceId, access.expenses, access.payroll, access.directTransactions])
}

/** Hydrate each source independently so freshness always reflects the tables this report reads. */
export async function refreshCustomerProfitabilitySources(
  workspaceId: string,
  access: CustomerProfitabilitySourceAccess,
) {
  if (isLocalWorkspaceMode(workspaceId) || !isOnline(workspaceId)) return
  const requests: Promise<unknown>[] = [
    fetchTableFromSupabase('customer_profitability_engagements', db.customer_profitability_engagements, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('customer_profitability_attributions', db.customer_profitability_attributions, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('fleet_vehicles', db.fleet_vehicles, workspaceId),
  ]
  if (access.expenses) {
    requests.push(
      fetchTableFromSupabase('expense_items', db.expense_items, workspaceId, { includeDeleted: true }),
      fetchTableFromSupabase('expense_series', db.expense_series, workspaceId, { includeDeleted: true }),
      fetchTableFromSupabase('expense_categories', db.expense_categories, workspaceId),
    )
  }
  if (access.payroll || access.directTransactions) {
    requests.push(fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true }))
  }
  await Promise.all(requests)
}
