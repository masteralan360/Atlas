import { useEffect, useState } from 'react'
import type { Table } from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { fetchTableFromSupabase } from './hooks'
import type {
    AgentProductCommissionEntry,
    CommissionPlanType,
    CurrencyCode,
    ProductCommissionRecipientScope,
    ProductCommissionRule,
    ProductCommissionRuleAgent
} from './models'
import { addToOfflineMutations } from './offlineMutations'
import { getSalesOrderCommissionMode } from './commissionMode'

const RULE_TABLE = 'product_commission_rules'
const RULE_AGENT_TABLE = 'product_commission_rule_agents'
const LINE_ENTRY_TABLE = 'agent_product_commission_entries'

type ProductCommissionTable = typeof RULE_TABLE | typeof RULE_AGENT_TABLE | typeof LINE_ENTRY_TABLE
type ProductCommissionEntity = ProductCommissionRule | ProductCommissionRuleAgent | AgentProductCommissionEntry

export type ProductCommissionRuleInput = {
    commissionType: CommissionPlanType
    ratePercent?: number
    fixedAmount?: number | null
    fixedCurrency?: CurrencyCode | null
    recipientScope: ProductCommissionRecipientScope
    agentIds?: string[]
    effectiveFrom?: string
    effectiveTo?: string | null
    isActive?: boolean
    notes?: string | null
    createdBy?: string | null
}

function shouldUseCloudData(workspaceId?: string | null) {
    return Boolean(workspaceId) && !isLocalWorkspaceMode(workspaceId)
}

function syncMetadata(workspaceId: string, timestamp: string) {
    return shouldUseCloudData(workspaceId)
        ? { syncStatus: 'pending' as const, lastSyncedAt: null }
        : { syncStatus: 'synced' as const, lastSyncedAt: timestamp }
}

function getTable(table: ProductCommissionTable) {
    switch (table) {
        case RULE_TABLE: return db.product_commission_rules
        case RULE_AGENT_TABLE: return db.product_commission_rule_agents
        case LINE_ENTRY_TABLE: return db.agent_product_commission_entries
    }
}

function entityPayload(entity: ProductCommissionEntity) {
    const payload = toSnakeCase(entity as unknown as Record<string, unknown>)
    delete payload.sync_status
    delete payload.last_synced_at
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
}

async function syncEntity(table: ProductCommissionTable, entity: ProductCommissionEntity) {
    if (!shouldUseCloudData(entity.workspaceId)) return
    try {
        const client = getSupabaseClientForTable(table)
        const payload = entityPayload(entity)
        const { error } = await runSupabaseAction(`${table}.sync`, () => (
            table === LINE_ENTRY_TABLE ? client.from(table).insert(payload) : client.from(table).upsert(payload)
        )) as { error?: unknown }
        if (error) throw error
        await getTable(table).update(entity.id, {
            syncStatus: 'synced',
            lastSyncedAt: new Date().toISOString()
        } as never)
    } catch (error) {
        await addToOfflineMutations(
            table,
            entity.id,
            entity.version > 1 ? 'update' : 'create',
            entity as unknown as Record<string, unknown>,
            entity.workspaceId
        )
    }
}

export async function appendAgentProductCommissionEntry(
    workspaceId: string,
    input: Omit<AgentProductCommissionEntry,
        'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'version' | 'isDeleted' | 'syncStatus' | 'lastSyncedAt'>
) {
    const now = new Date().toISOString()
    const linkedOrder = await db.sales_orders.get(input.orderId)
    const entry: AgentProductCommissionEntry = {
        ...input,
        commissionMode: linkedOrder
            ? getSalesOrderCommissionMode(linkedOrder)
            : input.commissionMode ?? 'payable',
        id: generateId(),
        workspaceId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...syncMetadata(workspaceId, now)
    }
    await db.agent_product_commission_entries.put(entry)
    await syncEntity(LINE_ENTRY_TABLE, entry)
    return entry
}

function cleanAgentIds(agentIds: readonly string[] | undefined) {
    return [...new Set((agentIds || []).map((id) => id.trim()).filter(Boolean))]
}

function validateRule(input: ProductCommissionRuleInput) {
    if (input.commissionType === 'percentage') {
        const ratePercent = Number(input.ratePercent)
        if (!Number.isFinite(ratePercent) || ratePercent <= 0 || ratePercent > 100) {
            throw new Error('Product commission percentage must be greater than zero and no more than 100')
        }
        return { ratePercent, fixedAmount: null, fixedCurrency: null }
    }
    const fixedAmount = Number(input.fixedAmount)
    if (!Number.isFinite(fixedAmount) || fixedAmount <= 0) {
        throw new Error('Product fixed commission amount must be greater than zero')
    }
    if (!input.fixedCurrency) throw new Error('Select a product commission currency')
    return { ratePercent: 0, fixedAmount, fixedCurrency: input.fixedCurrency }
}

/** Replaces a product's current rule using a new effective-dated revision. */
export async function replaceProductCommissionRule(
    workspaceId: string,
    productId: string,
    input: ProductCommissionRuleInput | null
) {
    const existingRules = await db.product_commission_rules
        .where('[workspaceId+productId]')
        .equals([workspaceId, productId])
        .and((row) => !row.isDeleted && row.isActive && !row.effectiveTo)
        .toArray()
    const now = new Date().toISOString()

    if (!input) {
        const retired = existingRules.map((rule) => ({
            ...rule,
            isActive: false,
            effectiveTo: now,
            updatedAt: now,
            version: rule.version + 1,
            ...syncMetadata(workspaceId, now)
        } satisfies ProductCommissionRule))
        await db.product_commission_rules.bulkPut(retired)
        await Promise.all(retired.map((rule) => syncEntity(RULE_TABLE, rule)))
        return null
    }

    const terms = validateRule(input)
    const agentIds = cleanAgentIds(input.agentIds)
    if (input.recipientScope === 'selected_assigned' && agentIds.length === 0) {
        throw new Error('Select at least one agent for this product commission')
    }
    if (agentIds.length > 0) {
        const recipients = await db.agents.bulkGet(agentIds)
        if (recipients.some((agent) => (
            !agent
            || agent.workspaceId !== workspaceId
            || agent.isDeleted
            || agent.status !== 'active'
            || agent.agentType !== 'field_agent'
        ))) {
            throw new Error('Select eligible field agents for this product commission')
        }
    }

    const retired = existingRules.map((rule) => ({
        ...rule,
        isActive: false,
        effectiveTo: now,
        updatedAt: now,
        version: rule.version + 1,
        ...syncMetadata(workspaceId, now)
    } satisfies ProductCommissionRule))
    const rule: ProductCommissionRule = {
        id: generateId(),
        workspaceId,
        productId,
        commissionType: input.commissionType,
        ...terms,
        recipientScope: input.recipientScope,
        effectiveFrom: input.effectiveFrom || now,
        effectiveTo: input.effectiveTo || null,
        isActive: input.isActive !== false,
        notes: input.notes?.trim() || null,
        createdBy: input.createdBy || null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...syncMetadata(workspaceId, now)
    }
    const recipients: ProductCommissionRuleAgent[] = input.recipientScope === 'selected_assigned'
        ? agentIds.map((agentId) => ({
            id: generateId(), workspaceId, ruleId: rule.id, agentId,
            createdAt: now, updatedAt: now, version: 1, isDeleted: false,
            ...syncMetadata(workspaceId, now)
        }))
        : []

    await db.transaction('rw', db.product_commission_rules, db.product_commission_rule_agents, async () => {
        if (retired.length) await db.product_commission_rules.bulkPut(retired)
        await db.product_commission_rules.put(rule)
        if (recipients.length) await db.product_commission_rule_agents.bulkPut(recipients)
    })
    // The selected-recipient rows have a database FK to the new revision.
    // Keep the online path in the same dependency order as the offline queue
    // instead of racing both writes from the product form.
    for (const entry of retired) await syncEntity(RULE_TABLE, entry)
    await syncEntity(RULE_TABLE, rule)
    for (const entry of recipients) await syncEntity(RULE_AGENT_TABLE, entry)
    return rule
}

function useRows<T extends ProductCommissionEntity>(table: ProductCommissionTable, workspaceId?: string) {
    const online = useNetworkStatus()
    const rows = useLiveQuery(async () => {
        if (!workspaceId) return [] as T[]
        return (getTable(table) as unknown as Table<T, string>)
            .where('workspaceId').equals(workspaceId)
            .and((row) => !row.isDeleted).toArray()
    }, [table, workspaceId])
    useEffect(() => {
        if (!workspaceId || !online || !shouldUseCloudData(workspaceId)) return
        void fetchTableFromSupabase(table, getTable(table), workspaceId).catch((error) => {
            console.error(`[Product commissions] Failed to hydrate ${table}:`, error)
        })
    }, [online, table, workspaceId])
    return rows || []
}

export function useProductCommissionRules(workspaceId?: string) {
    return useRows<ProductCommissionRule>(RULE_TABLE, workspaceId)
        // Older local-cache rows can predate the effective-dating fields. Keep
        // them readable until the authoritative CRM pull replaces them.
        .sort((left, right) => String(right.effectiveFrom || right.updatedAt || right.createdAt || '')
            .localeCompare(String(left.effectiveFrom || left.updatedAt || left.createdAt || '')))
}

export function useProductCommissionRuleAgents(workspaceId?: string) {
    return useRows<ProductCommissionRuleAgent>(RULE_AGENT_TABLE, workspaceId)
}

export function useAgentProductCommissionEntries(workspaceId?: string) {
    return useRows<AgentProductCommissionEntry>(LINE_ENTRY_TABLE, workspaceId)
        .sort((left, right) => String(right.occurredAt || right.updatedAt || right.createdAt || '')
            .localeCompare(String(left.occurredAt || left.updatedAt || left.createdAt || '')))
}

/**
 * A form-facing loader that waits for the authoritative CRM rule data before
 * a cloud or hybrid editor can replace an existing effective-dated rule.
 */
export function useProductCommissionCatalogState(workspaceId?: string, enabled = true) {
    const rules = useProductCommissionRules(enabled ? workspaceId : undefined)
    const recipients = useProductCommissionRuleAgents(enabled ? workspaceId : undefined)
    const online = useNetworkStatus()
    const [isReady, setIsReady] = useState(() => !enabled || !workspaceId || isLocalWorkspaceMode(workspaceId))
    const [error, setError] = useState<unknown>(null)

    useEffect(() => {
        let cancelled = false
        if (!enabled || !workspaceId || isLocalWorkspaceMode(workspaceId)) {
            setIsReady(true)
            setError(null)
            return
        }
        if (!online) {
            setIsReady(false)
            return
        }
        setIsReady(false)
        setError(null)
        void Promise.all([
            fetchTableFromSupabase(RULE_TABLE, db.product_commission_rules, workspaceId),
            fetchTableFromSupabase(RULE_AGENT_TABLE, db.product_commission_rule_agents, workspaceId)
        ]).then(() => {
            if (!cancelled) setIsReady(true)
        }).catch((nextError) => {
            if (!cancelled) {
                setError(nextError)
                setIsReady(false)
            }
        })
        return () => { cancelled = true }
    }, [enabled, online, workspaceId])

    return { rules, recipients, isReady, error }
}

export function activeProductCommissionRule(
    rules: readonly ProductCommissionRule[],
    productId: string,
    at: string
) {
    return rules
        .filter((rule) => !rule.isDeleted && rule.productId === productId && rule.isActive
            && String(rule.effectiveFrom || rule.updatedAt || rule.createdAt || '') <= at
            && (!rule.effectiveTo || rule.effectiveTo > at))
        .sort((left, right) => String(right.effectiveFrom || right.updatedAt || right.createdAt || '')
            .localeCompare(String(left.effectiveFrom || left.updatedAt || left.createdAt || '')))[0] || null
}
