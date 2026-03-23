import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { supabase } from '@/auth/supabase'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isOnline } from '@/lib/network'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isCloudWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { createInventoryTransferTransactions } from './inventoryTransferTransactions'
import { transferInventoryQuantity, getInventoryQuantityForProductStorage } from './inventory'
import { addToOfflineMutations } from './offlineMutations'
import type { ReorderTransferRule } from './models'

const runningRuleIds = new Set<string>()
const initializedWorkspaceEvaluations = new Set<string>()

export interface ReorderTransferRuleInput {
    productId: string
    sourceStorageId: string
    destinationStorageId: string
    minStockLevel: number
    transferQuantity: number
    expiresOn?: string | null
    isIndefinite?: boolean
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && isCloudWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    return {
        syncStatus: 'pending' as const,
        lastSyncedAt: null
    }
}

function getTodayDateKey() {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function sanitizeRulePayload(rule: Record<string, unknown>) {
    const payload = toSnakeCase({
        ...rule,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })

    return payload
}

function isRuleExpired(rule: Pick<ReorderTransferRule, 'isDeleted' | 'isIndefinite' | 'expiresOn'>, today = getTodayDateKey()) {
    return !rule.isDeleted && !rule.isIndefinite && !!rule.expiresOn && rule.expiresOn < today
}

function normalizeRuleInput(input: ReorderTransferRuleInput) {
    const productId = input.productId.trim()
    const sourceStorageId = input.sourceStorageId.trim()
    const destinationStorageId = input.destinationStorageId.trim()
    const minStockLevel = Number(input.minStockLevel)
    const transferQuantity = Number(input.transferQuantity)
    const isIndefinite = Boolean(input.isIndefinite)
    const expiresOn = isIndefinite ? null : (input.expiresOn?.trim() || null)

    if (!productId) {
        throw new Error('Select a product')
    }

    if (!sourceStorageId) {
        throw new Error('Select a source storage')
    }

    if (!destinationStorageId) {
        throw new Error('Select a destination storage')
    }

    if (sourceStorageId === destinationStorageId) {
        throw new Error('Source and destination storages must be different')
    }

    if (!Number.isInteger(minStockLevel) || minStockLevel < 0) {
        throw new Error('Minimum stock level must be a whole number of zero or more')
    }

    if (!Number.isInteger(transferQuantity) || transferQuantity <= 0) {
        throw new Error('Transfer quantity must be a whole number greater than zero')
    }

    if (!isIndefinite && !expiresOn) {
        throw new Error('Select an expiry date or mark the rule as indefinite')
    }

    if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
        throw new Error('Expiry date is invalid')
    }

    return {
        productId,
        sourceStorageId,
        destinationStorageId,
        minStockLevel,
        transferQuantity,
        expiresOn,
        isIndefinite
    }
}

async function runMutation<T>(label: string, promiseFactory: () => PromiseLike<T>) {
    return runSupabaseAction(label, promiseFactory)
}

async function markRulesSynced(ids: string[]) {
    if (ids.length === 0) {
        return
    }

    const syncedAt = new Date().toISOString()
    await Promise.all(ids.map((id) =>
        db.reorder_transfer_rules.update(id, {
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        })
    ))
}

async function queueOfflineUpserts(
    rules: Array<ReorderTransferRule & { version: number }>,
    workspaceId: string
) {
    await Promise.all(rules.map((rule) =>
        addToOfflineMutations(
            'reorder_transfer_rules',
            rule.id,
            rule.version > 1 ? 'update' : 'create',
            rule as unknown as Record<string, unknown>,
            workspaceId
        )
    ))
}

async function syncUpsertRules(rules: Array<ReorderTransferRule & { version: number }>, workspaceId: string) {
    if (!rules.length || !shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline()) {
        await queueOfflineUpserts(rules, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable('reorder_transfer_rules')
        const payload = rules.map((rule) => sanitizeRulePayload(rule as unknown as Record<string, unknown>))
        const { error } = await runMutation('reorder_transfer_rules.sync', () =>
            client.from('reorder_transfer_rules').upsert(payload)
        )

        if (error) {
            throw error
        }

        await markRulesSynced(rules.map((rule) => rule.id))
    } catch (error) {
        console.error('[ReorderTransferRules] Failed to sync rules:', error)
        await queueOfflineUpserts(rules, workspaceId)
    }
}

async function syncSoftDeleteRule(ruleId: string, workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    if (!isOnline()) {
        await addToOfflineMutations('reorder_transfer_rules', ruleId, 'delete', { id: ruleId }, workspaceId)
        return
    }

    try {
        const client = getSupabaseClientForTable('reorder_transfer_rules')
        const { error } = await runMutation('reorder_transfer_rules.delete', () =>
            client
                .from('reorder_transfer_rules')
                .update({ is_deleted: true, updated_at: new Date().toISOString() })
                .eq('id', ruleId)
        )

        if (error) {
            throw error
        }

        await markRulesSynced([ruleId])
    } catch (error) {
        console.error('[ReorderTransferRules] Failed to delete rule:', error)
        await addToOfflineMutations('reorder_transfer_rules', ruleId, 'delete', { id: ruleId }, workspaceId)
    }
}

async function persistRuleUpdate(existing: ReorderTransferRule, changes: Partial<ReorderTransferRule>) {
    const now = changes.updatedAt || new Date().toISOString()
    const updatedRule: ReorderTransferRule = {
        ...existing,
        ...changes,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    }

    await db.reorder_transfer_rules.put(updatedRule)
    await syncUpsertRules([updatedRule], existing.workspaceId)
    return updatedRule
}

export async function cleanupExpiredReorderTransferRules(workspaceId: string) {
    const today = getTodayDateKey()
    const expiredRules = await db.reorder_transfer_rules
        .where('workspaceId')
        .equals(workspaceId)
        .and((rule) => isRuleExpired(rule, today))
        .toArray()

    await Promise.all(expiredRules.map((rule) => deleteReorderTransferRule(rule.id)))
    return expiredRules.length
}

export async function evaluateReorderTransferRule(ruleId: string) {
    const rule = await db.reorder_transfer_rules.get(ruleId)
    if (!rule || rule.isDeleted) {
        return false
    }

    if (runningRuleIds.has(ruleId)) {
        return false
    }

    if (isRuleExpired(rule)) {
        await deleteReorderTransferRule(rule.id)
        return false
    }

    runningRuleIds.add(ruleId)

    try {
        const [product, sourceStorage, destinationStorage] = await Promise.all([
            db.products.get(rule.productId),
            db.storages.get(rule.sourceStorageId),
            db.storages.get(rule.destinationStorageId)
        ])

        if (!product || product.isDeleted || !sourceStorage || sourceStorage.isDeleted || !destinationStorage || destinationStorage.isDeleted) {
            return false
        }

        const destinationQuantity = await getInventoryQuantityForProductStorage(rule.productId, rule.destinationStorageId)
        if (destinationQuantity >= rule.minStockLevel) {
            return false
        }

        const sourceQuantity = await getInventoryQuantityForProductStorage(rule.productId, rule.sourceStorageId)
        if (sourceQuantity < rule.transferQuantity) {
            return false
        }

        const now = new Date().toISOString()
        await transferInventoryQuantity({
            workspaceId: rule.workspaceId,
            productId: rule.productId,
            sourceStorageId: rule.sourceStorageId,
            targetStorageId: rule.destinationStorageId,
            quantity: rule.transferQuantity,
            timestamp: now,
            skipReorderCheck: true
        })

        try {
            await createInventoryTransferTransactions(
                rule.workspaceId,
                [{
                    productId: rule.productId,
                    sourceStorageId: rule.sourceStorageId,
                    destinationStorageId: rule.destinationStorageId,
                    quantity: rule.transferQuantity,
                    transferType: 'automation',
                    reorderRuleId: rule.id
                }],
                { timestamp: now }
            )
        } catch (error) {
            try {
                await transferInventoryQuantity({
                    workspaceId: rule.workspaceId,
                    productId: rule.productId,
                    sourceStorageId: rule.destinationStorageId,
                    targetStorageId: rule.sourceStorageId,
                    quantity: rule.transferQuantity,
                    timestamp: new Date().toISOString(),
                    skipReorderCheck: true
                })
            } catch (rollbackError) {
                console.error('[ReorderTransferRules] Failed to rollback automated transfer:', rollbackError)
            }

            throw error
        }

        await persistRuleUpdate(rule, {
            lastTriggeredAt: now
        })

        return true
    } finally {
        runningRuleIds.delete(ruleId)
    }
}

export async function evaluateReorderTransferRulesForProduct(workspaceId: string, productId: string) {
    await cleanupExpiredReorderTransferRules(workspaceId)

    const rules = await db.reorder_transfer_rules
        .where('[workspaceId+productId]')
        .equals([workspaceId, productId])
        .and((rule) => !rule.isDeleted)
        .toArray()

    let triggeredCount = 0
    for (const rule of rules.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        if (await evaluateReorderTransferRule(rule.id)) {
            triggeredCount += 1
        }
    }

    return triggeredCount
}

export async function evaluateAllReorderTransferRules(workspaceId: string) {
    await cleanupExpiredReorderTransferRules(workspaceId)

    const rules = await db.reorder_transfer_rules
        .where('workspaceId')
        .equals(workspaceId)
        .and((rule) => !rule.isDeleted)
        .toArray()

    let triggeredCount = 0
    for (const rule of rules.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        if (await evaluateReorderTransferRule(rule.id)) {
            triggeredCount += 1
        }
    }

    return triggeredCount
}

export function useReorderTransferRules(workspaceId: string | undefined) {
    const online = useNetworkStatus()

    const rules = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const rows = await db.reorder_transfer_rules
                .where('workspaceId')
                .equals(workspaceId)
                .and((rule) => !rule.isDeleted)
                .toArray()

            return rows.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
        },
        [workspaceId]
    )

    useEffect(() => {
        if (!workspaceId) {
            return
        }

        void cleanupExpiredReorderTransferRules(workspaceId)
    }, [workspaceId])

    useEffect(() => {
        if (!workspaceId || !rules || rules.length === 0 || initializedWorkspaceEvaluations.has(workspaceId)) {
            return
        }

        initializedWorkspaceEvaluations.add(workspaceId)
        void evaluateAllReorderTransferRules(workspaceId)
    }, [workspaceId, rules])

    useEffect(() => {
        async function fetchFromSupabase() {
            if (!online || !workspaceId || !shouldUseCloudBusinessData(workspaceId)) {
                return
            }

            const { data, error } = await supabase
                .from('reorder_transfer_rules')
                .select('*')
                .eq('workspace_id', workspaceId)
                .eq('is_deleted', false)

            if (!data || error || !shouldUseCloudBusinessData(workspaceId)) {
                return
            }

            await db.transaction('rw', db.reorder_transfer_rules, async () => {
                const remoteIds = new Set(data.map((item) => item.id))
                const localItems = await db.reorder_transfer_rules.where('workspaceId').equals(workspaceId).toArray()

                for (const local of localItems) {
                    if (!remoteIds.has(local.id) && local.syncStatus === 'synced') {
                        await db.reorder_transfer_rules.delete(local.id)
                    }
                }

                for (const remoteItem of data) {
                    const localItem = toCamelCase(remoteItem as Record<string, unknown>) as unknown as ReorderTransferRule
                    localItem.syncStatus = 'synced'
                    localItem.lastSyncedAt = new Date().toISOString()
                    await db.reorder_transfer_rules.put(localItem)
                }
            })

            await evaluateAllReorderTransferRules(workspaceId)
        }

        void fetchFromSupabase()
    }, [online, workspaceId])

    return rules ?? []
}

export async function createReorderTransferRule(workspaceId: string, input: ReorderTransferRuleInput) {
    const now = new Date().toISOString()
    const normalized = normalizeRuleInput(input)
    const rule: ReorderTransferRule = {
        id: generateId(),
        workspaceId,
        ...normalized,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        lastTriggeredAt: null,
        ...getSyncMetadata(workspaceId, now)
    }

    await db.reorder_transfer_rules.put(rule)
    await syncUpsertRules([rule], workspaceId)
    await evaluateReorderTransferRule(rule.id)
    return (await db.reorder_transfer_rules.get(rule.id)) as ReorderTransferRule
}

export async function updateReorderTransferRule(id: string, input: ReorderTransferRuleInput) {
    const existing = await db.reorder_transfer_rules.get(id)
    if (!existing || existing.isDeleted) {
        throw new Error('Reorder rule not found')
    }

    const normalized = normalizeRuleInput(input)
    const updatedRule = await persistRuleUpdate(existing, normalized)
    await evaluateReorderTransferRule(updatedRule.id)
    return (await db.reorder_transfer_rules.get(updatedRule.id)) as ReorderTransferRule
}

export async function deleteReorderTransferRule(id: string) {
    const existing = await db.reorder_transfer_rules.get(id)
    if (!existing || existing.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    await db.reorder_transfer_rules.put({
        ...existing,
        isDeleted: true,
        updatedAt: now,
        version: existing.version + 1,
        ...getSyncMetadata(existing.workspaceId, now)
    })

    await syncSoftDeleteRule(id, existing.workspaceId)
}
