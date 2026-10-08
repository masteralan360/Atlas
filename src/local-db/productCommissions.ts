import { useEffect, useMemo, useState } from 'react'
import type { Table } from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toCamelCase, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { canReconcileCloudWorkspaceData } from './cloudReconciliation'
import { fetchTableFromSupabase } from './hooks'
import { sortLiveCollection, useLiveCollection } from './liveCollection'
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

function useRows<T extends ProductCommissionEntity>(
    table: ProductCommissionTable,
    workspaceId?: string,
    options: { hydrateRemote?: boolean; agentIds?: readonly string[] } = {}
) {
    const online = useNetworkStatus()
    const hydrateRemote = options.hydrateRemote ?? true
    const agentIds = options.agentIds
    const agentIdKey = agentIds ? [...agentIds].sort().join('|') : null
    const rows = useLiveQuery(async () => {
        if (!workspaceId) return [] as T[]
        const dexieTable = getTable(table) as unknown as Table<T, string>
        if (agentIds) {
            if (agentIds.length === 0) return [] as T[]
            return dexieTable.where('agentId').anyOf([...agentIds])
                .and((row) => row.workspaceId === workspaceId && !row.isDeleted)
                .toArray()
        }
        return dexieTable.where('workspaceId').equals(workspaceId)
            .and((row) => !row.isDeleted).toArray()
    }, [agentIdKey, table, workspaceId])
    useEffect(() => {
        if (!hydrateRemote || !workspaceId || !online || !shouldUseCloudData(workspaceId)) return
        void fetchTableFromSupabase(table, getTable(table), workspaceId).catch((error) => {
            console.error(`[Product commissions] Failed to hydrate ${table}:`, error)
        })
    }, [hydrateRemote, online, table, workspaceId])
    return useLiveCollection(rows, Boolean(workspaceId) && rows === undefined)
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

export function useAgentProductCommissionEntries(
    workspaceId?: string,
    options: { hydrateRemote?: boolean; agentIds?: readonly string[] } = {}
) {
    const rows = useRows<AgentProductCommissionEntry>(LINE_ENTRY_TABLE, workspaceId, options)
    return useMemo(() => sortLiveCollection(
        rows,
        (left, right) => String(right.occurredAt || right.updatedAt || right.createdAt || '')
            .localeCompare(String(left.occurredAt || left.updatedAt || left.createdAt || '')),
    ), [rows])
}

/**
 * Refresh only one partner's product commission rows for the account statement.
 * This deliberately does not mark the workspace table fully hydrated: other
 * consumers still need the normal complete-table reconciliation.
 */
export async function refreshPartnerStatementProductCommissionEntries(
    workspaceId: string,
    partnerId: string
) {
    if (!shouldUseCloudData(workspaceId) || !await canReconcileCloudWorkspaceData(workspaceId)) return

    // The statement refresh also hydrates agents in parallel. Share that
    // hydration lease here so the partner-to-agent mapping is current before
    // constructing the commission query.
    await fetchTableFromSupabase('agents', db.agents, workspaceId)
    if (!await canReconcileCloudWorkspaceData(workspaceId)) return

    const agents = await db.agents
        .where('workspaceId')
        .equals(workspaceId)
        .and((agent) => !agent.isDeleted && agent.agentType === 'field_agent' && agent.businessPartnerId === partnerId)
        .toArray()
    const agentIds = [...new Set(agents.map((agent) => agent.id))]
    if (agentIds.length === 0) return

    const client = getSupabaseClientForTable(LINE_ENTRY_TABLE)
    const remoteRows: Record<string, unknown>[] = []
    for (let from = 0; ; from += 1000) {
        const { data, error } = await client
            .from(LINE_ENTRY_TABLE)
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('is_deleted', false)
            .in('agent_id', agentIds)
            .order('occurred_at', { ascending: false })
            .order('id', { ascending: true })
            .range(from, from + 999)

        if (error) throw error
        if (!data) throw new Error('No product commission rows returned for the partner statement')
        remoteRows.push(...data as Record<string, unknown>[])
        if (data.length < 1000) break
    }

    if (!await canReconcileCloudWorkspaceData(workspaceId)) return
    const syncedAt = new Date().toISOString()
    const remoteItems = remoteRows.map((remoteRow) => ({
        ...toCamelCase(remoteRow),
        syncStatus: 'synced',
        lastSyncedAt: syncedAt
    } as unknown as AgentProductCommissionEntry))
    const remoteIds = new Set(remoteItems.map((entry) => entry.id))

    // Reconcile only the selected agents' synced cache slice. Pending local
    // mutations and all other agents' rows remain untouched.
    await db.transaction('rw', db.agent_product_commission_entries, async () => {
        const localRows = await db.agent_product_commission_entries
            .where('workspaceId')
            .equals(workspaceId)
            .toArray()
        const staleIds = localRows
            .filter((entry) => (
                agentIds.includes(entry.agentId)
                && entry.syncStatus === 'synced'
                && !remoteIds.has(entry.id)
            ))
            .map((entry) => entry.id)
        if (staleIds.length) await db.agent_product_commission_entries.bulkDelete(staleIds)
        if (remoteItems.length) await db.agent_product_commission_entries.bulkPut(remoteItems)
    })
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
    const [retryNonce, setRetryNonce] = useState(0)

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
        ]).then((results) => {
            if (!results.every(Boolean)) {
                throw new Error('product_commission_catalog_load_failed')
            }
            if (!cancelled) setIsReady(true)
        }).catch((nextError) => {
            if (!cancelled) {
                setError(nextError)
                setIsReady(false)
            }
        })
        return () => { cancelled = true }
    }, [enabled, online, retryNonce, workspaceId])

    return {
        rules,
        recipients,
        isReady,
        error,
        retry: () => setRetryNonce((value) => value + 1)
    }
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
