import { describe, expect, it, vi } from 'vitest'

const clients = vi.hoisted(() => ({
    public: {},
    crm: {},
    schema: vi.fn((schemaName: string) => schemaName === 'crm' ? clients.crm : {})
}))

vi.mock('@/auth/supabase', () => ({
    supabase: {
        ...clients.public,
        schema: clients.schema
    }
}))

import {
    getPartnerSyncWriteRpc,
    getSupabaseClientForTable,
    getWorkspaceScopedPartnerReadRpc,
    isCrmTable
} from './supabaseSchema'

describe('commission Supabase schema routing', () => {
    it.each([
        'agent_commission_entries',
        'agent_commission_memberships',
        'agent_commission_plans',
        'sales_order_agent_assignments'
    ])('routes %s through the crm schema', (tableName) => {
        expect(isCrmTable(tableName)).toBe(true)
        expect(getSupabaseClientForTable(tableName)).toBe(clients.crm)
    })
})

describe('business partner workspace-scoped schema routing', () => {
    it.each([
        ['business_partners', 'list_visible_business_partners', 'sync_business_partner'],
        ['customers', 'list_visible_customers', 'sync_customer'],
        ['suppliers', 'list_visible_suppliers', 'sync_supplier']
    ])('routes %s through its workspace-scoped read and authorized write RPCs', (tableName, readRpc, writeRpc) => {
        expect(getWorkspaceScopedPartnerReadRpc(tableName)).toBe(readRpc)
        expect(getPartnerSyncWriteRpc(tableName)).toBe(writeRpc)
    })
})
