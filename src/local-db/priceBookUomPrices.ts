import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { getActiveBusinessUserId, isOnline } from '@/lib/network'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { fetchTableFromSupabase } from './hooks'
import type { CurrencyCode, PriceBookUnitPrice, UnitRef } from './models'
import { addToOfflineMutations } from './offlineMutations'

const TABLE = 'price_book_unit_prices'
const SUPPORTED_CURRENCIES = new Set<CurrencyCode>(['usd', 'eur', 'iqd', 'try'])

function usesCloud(workspaceId: string) {
  return !isLocalWorkspaceMode(workspaceId)
}

function syncMetadata(workspaceId: string, timestamp: string) {
  const synced = !usesCloud(workspaceId) || isOnline(workspaceId)
  return {
    syncStatus: synced ? 'synced' as const : 'pending' as const,
    lastSyncedAt: synced ? timestamp : null,
  }
}

/** Price Book overrides for a product's selected UoM. */
export function usePriceBookUomPrices(workspaceId?: string) {
  const online = useNetworkStatus()
  const rows = useLiveQuery(
    () => workspaceId
      ? db.price_book_unit_prices.where('workspaceId').equals(workspaceId).and((row) => !row.isDeleted).toArray()
      : [],
    [workspaceId],
  )

  useEffect(() => {
    if (!online || !workspaceId || isLocalWorkspaceMode(workspaceId)) return
    void fetchTableFromSupabase(TABLE, db.price_book_unit_prices, workspaceId)
  }, [online, workspaceId])

  return rows ?? []
}

export async function replaceProductPriceBookUomPrices(
  workspaceId: string,
  productId: string,
  inputs: Array<{ priceBookId: string; unitRef: UnitRef; price: number; currency: CurrencyCode }>,
) {
  const seen = new Set<string>()
  for (const input of inputs) {
    const key = `${input.priceBookId}:${input.unitRef}`
    if (!input.priceBookId || !input.unitRef || seen.has(key)) throw new Error('price_book_uom_duplicate')
    if (!Number.isFinite(input.price) || input.price < 0) throw new Error('price_book_uom_price_invalid')
    if (!SUPPORTED_CURRENCIES.has(input.currency)) throw new Error('price_book_uom_currency_invalid')
    seen.add(key)
  }

  const existing = await db.price_book_unit_prices
    .where('[workspaceId+productId]')
    .equals([workspaceId, productId])
    .toArray()
  const existingByKey = new Map(existing.map((row) => [`${row.priceBookId}:${row.unitRef}`, row]))
  const now = new Date().toISOString()
  const actorId = getActiveBusinessUserId() ?? null
  const metadata = syncMetadata(workspaceId, now)
  const rows: PriceBookUnitPrice[] = inputs.map((input) => {
    const prior = existingByKey.get(`${input.priceBookId}:${input.unitRef}`)
    return {
      id: prior?.id ?? generateId(),
      workspaceId,
      productId,
      ...input,
      createdBy: prior?.createdBy ?? actorId,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      version: (prior?.version ?? 0) + 1,
      isDeleted: false,
      ...metadata,
    }
  })
  const desiredKeys = new Set(inputs.map((row) => `${row.priceBookId}:${row.unitRef}`))
  for (const prior of existing) {
    if (prior.isDeleted || desiredKeys.has(`${prior.priceBookId}:${prior.unitRef}`)) continue
    rows.push({
      ...prior,
      isDeleted: true,
      updatedAt: now,
      version: prior.version + 1,
      ...metadata,
    })
  }

  if (usesCloud(workspaceId) && isOnline(workspaceId) && rows.length > 0) {
    const payload = rows.map((row) => toSnakeCase({
      ...row,
      syncStatus: undefined,
      lastSyncedAt: undefined,
    } as unknown as Record<string, unknown>))
    const { data, error } = await runSupabaseAction('priceBookUomPrices.replaceProduct', () => supabase
      .from(TABLE)
      .upsert(payload, { onConflict: 'price_book_id,product_id,unit_ref' })
      .select('*'))
    if (error) throw normalizeSupabaseActionError(error)
    const savedAt = new Date().toISOString()
    const savedRows = (data ?? []).map((row) => ({
      ...(toCamelCase(row as Record<string, unknown>) as unknown as PriceBookUnitPrice),
      syncStatus: 'synced' as const,
      lastSyncedAt: savedAt,
    }))
    const persistedRows = savedRows.length > 0 ? savedRows : rows.map((row) => ({
      ...row,
      syncStatus: 'synced' as const,
      lastSyncedAt: savedAt,
    }))
    await db.price_book_unit_prices.bulkPut(persistedRows)
    return persistedRows.filter((row) => !row.isDeleted)
  }

  if (usesCloud(workspaceId)) {
    await Promise.all(rows.map((row) => addToOfflineMutations(
      TABLE,
      row.id,
      existingByKey.has(`${row.priceBookId}:${row.unitRef}`) ? 'update' : 'create',
      row as unknown as Record<string, unknown>,
      workspaceId,
    )))
  }
  if (rows.length > 0) await db.price_book_unit_prices.bulkPut(rows)
  return rows.filter((row) => !row.isDeleted)
}
