import type { SupabaseClient } from '@supabase/supabase-js'

export type Row = Record<string, any>
export type HostedClient = SupabaseClient
export interface Family { id: string; name: string; path: string; integrity: string }
export interface Domain { id: string; name: string; route: string; db: string; cross: string; cases: Family[] }
export interface RequestEvidence { method: string; path: string; status?: number; fault?: string }
export interface Graph {
    workspaceId: string
    tables: Record<string, Row[]>
}
export interface Scope {
    workspaceId: string
    tag: string
    orderIds: Set<string>
    productIds: Set<string>
    partnerIds: Set<string>
    accountIds: Set<string>
    operationIds: Set<string>
    marketplaceIds: Set<string>
}
export interface HostedEvidence {
    caseId: string; step: string; outcome: 'passed' | 'failed' | 'blocked'
    requests: RequestEvidence[]; before: string; after: string
    rowCounts: Record<string, number>; invariants: string[]; error?: string
    variant?: Row; fixtureTag?: string
}
export interface Persona {
    email: string; password: string; role: string; workspaceId: string; workspaceName: string
}
/** Optional, gitignored, local fixtures. Credentials never belong in the registry/report. */
export interface ExtendedConfig {
    personas?: Record<string, Persona>
    fixtures?: Record<string, { orderId?: string; marketplaceOrderId?: string; agentId?: string; accountId?: string; [key: string]: unknown }>
    observer?: { url: string; bearer: string }
}
export class HostedBlocked extends Error {
    constructor(readonly requirement: string) { super(`hosted_blocked: ${requirement}`); this.name = 'HostedBlocked' }
}
