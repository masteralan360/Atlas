import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveWorkspaceAccess } from '@/workspace/workspaceAccessResolution'
import { writeWorkspaceCache, readWorkspaceCache, clearWorkspaceCache } from '@/workspace/workspaceCache'
import { resolveWorkspacePermission } from '@/permissions/resolveWorkspacePermission'
import type { WorkspacePermissionKey } from '@/permissions/workspacePermissionDefinitions'
import type { WorkspaceAccessOverride } from '@/plans/workspacePlans'
import { installTestBrowser } from '../fixtures/browser'
import { entitlementScenarios } from './scenarios/entitlementScenarios'
import { LabSqlite } from './fixtures/sqlite'
import { isSupabasePublicKey } from '@/auth/supabasePublicKey'

describe('Sales Order Resilience Lab · plan, grant, permission and offline resolution', () => {
    beforeAll(() => installTestBrowser())
    for (const scenario of entitlementScenarios) it(`${scenario.id} ${scenario.label} Orders entitlement survives Local/Hybrid cache reconstruction`, async () => {
        const workspaceId = crypto.randomUUID()
        const overrides: WorkspaceAccessOverride[] = scenario.override ? [{ id: crypto.randomUUID(), workspace_id: workspaceId,
            type: 'module', key: 'orders', value: scenario.override, created_by: null, created_at: '2026-10-02T00:00:00Z' }] : []
        const online = resolveWorkspaceAccess(scenario.plan, overrides)
        expect(online.modules.includes('orders')).toBe(scenario.allowed)
        writeWorkspaceCache({ workspaceId, workspaceName: 'DEV TEST SORL entitlement', features: { plan: scenario.plan }, overrides })
        const cached = readWorkspaceCache<{ plan: string }>(workspaceId)!
        expect(resolveWorkspaceAccess(scenario.plan, cached.overrides).modules.includes('orders')).toBe(scenario.allowed)
        // A real SQLite restart proves the persisted access snapshot, independent of browser storage.
        const sqlite = await LabSqlite.open()
        try {
            await sqlite.execute('INSERT INTO local_entities(entity_type,entity_id,workspace_id,payload) VALUES($1,$2,$3,$4)',
                ['workspaces', workspaceId, workspaceId, JSON.stringify({ plan: scenario.plan, cachedAccessOverrides: overrides })])
            const restarted = await LabSqlite.open(sqlite.database.export())
            try {
                const rows = await restarted.select<{ payload: string }[]>('SELECT payload FROM local_entities WHERE entity_id = $1', [workspaceId])
                const restored = JSON.parse(rows[0].payload)
                expect(resolveWorkspaceAccess(restored.plan, restored.cachedAccessOverrides).modules.includes('orders')).toBe(scenario.allowed)
            } finally { await restarted.close() }
        } finally { await sqlite.close(); clearWorkspaceCache(workspaceId) }
    })
    it('SORL-AUTH-006 Enterprise staff needs the specific Sales Orders permission; admin needs no permission row', () => {
        expect(isSupabasePublicKey('sb_publishable_' + 'x'.repeat(32))).toBe(true)
        expect(isSupabasePublicKey('sb_secret_' + 'x'.repeat(32))).toBe(false)
        expect(isSupabasePublicKey('your_supabase_anon_key')).toBe(false)
        expect(isSupabasePublicKey(`header.${btoa(JSON.stringify({ role: 'anon' }))}.signature`)).toBe(true)
        expect(isSupabasePublicKey(`header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`)).toBe(false)
        const access = new Set<WorkspacePermissionKey>(['orders.saleOrdersAccess'])
        expect(resolveWorkspacePermission('staff', true, access, 'orders.saleOrdersAccess')).toBe(true)
        expect(resolveWorkspacePermission('staff', true, new Set(), 'orders.saleOrdersAccess')).toBe(false)
        expect(resolveWorkspacePermission('staff', true, new Set(['global.NOprint']), 'orders.saleOrdersAccess')).toBe(false)
        expect(resolveWorkspacePermission('admin', true, new Set(), 'orders.saleOrdersAccess')).toBe(true)
        expect(resolveWorkspacePermission('viewer', true, new Set(), 'orders.saleOrdersAccess')).toBe(false)
        expect(resolveWorkspacePermission('viewer', true, access, 'orders.saleOrdersAccess')).toBe(true)
    })
})
