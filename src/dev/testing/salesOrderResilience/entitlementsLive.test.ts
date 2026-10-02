import { describe, expect, it } from 'vitest'
import { resolveWorkspaceAccess } from '@/workspace/workspaceAccessResolution'
import { resolveWorkspacePermission } from '@/permissions/resolveWorkspacePermission'
import type { WorkspacePermissionKey } from '@/permissions/workspacePermissionDefinitions'
import type { WorkspaceAccessOverride } from '@/plans/workspacePlans'
import { authenticateActor, dataOrThrow } from './fixtures/testActor'
import { entitlementScenarios } from './scenarios/entitlementScenarios'
import { isSupabasePublicKey } from '@/auth/supabasePublicKey'

async function customerProbe(label: string) {
    const admin = await authenticateActor(`${label}.admin`)
    try {
        const partners = dataOrThrow(await admin.client.schema('crm').rpc('list_visible_business_partners', { p_workspace_id: admin.workspaceId }), 'access customers')
        const partner = partners.find((row: { partner_name: string }) => row.partner_name.endsWith(' access customer'))
        expect(partner).toBeDefined()
        return { customer_id: partner.customer_facet_id, business_partner_id: partner.id, customer_name: partner.partner_name }
    } finally { await admin.client.auth.signOut({ scope: 'local' }) }
}

describe('Sales Order Resilience Lab · real actors, stored grants and RLS', () => {
    for (const scenario of entitlementScenarios) it(`${scenario.id} resolves the stored ${scenario.label} access state`, async () => {
        const actor = await authenticateActor(`${scenario.label}.admin`)
        try {
            const customer = await customerProbe(scenario.label)
            const workspace = dataOrThrow(await actor.client.from('workspaces').select('*').eq('id', actor.workspaceId).single(), 'workspace')
            const overrides = dataOrThrow(await actor.client.from('workspace_access_overrides').select('*').eq('workspace_id', actor.workspaceId), 'overrides') as WorkspaceAccessOverride[]
            expect(resolveWorkspaceAccess(workspace.plan, overrides).modules.includes('orders')).toBe(scenario.allowed)
            expect(workspace.is_configured).toBe(true); expect(workspace.locked_workspace).toBe(false)
            const permissions = dataOrThrow(await actor.client.from('workspace_permissions').select('key').eq('user_uuid', actor.userId), 'admin permissions')
            expect(permissions).toHaveLength(0)
            const draft = await actor.client.schema('crm').from('sales_orders').insert({ id: crypto.randomUUID(), workspace_id: actor.workspaceId,
                order_number: `SORL-${scenario.id}`, ...customer, created_by: actor.userId, items: [], subtotal: 0, total: 0,
                currency: 'iqd', status: 'draft', payment_method: 'cash', paid_amount: 0, balance_amount: 0 }).select('id')
            if (scenario.allowed) { expect(draft.error).toBeNull(); expect(draft.data).toHaveLength(1) }
            else expect(draft.error?.code).toBe('42501')
            // RLS must reject cross-tenant writes even when a UUID is known.
            const result = await actor.client.from('workspace_permissions').insert({ workspace_id: crypto.randomUUID(), user_uuid: actor.userId, module: 'orders', key: 'orders.saleOrdersAccess' })
            expect(result.error).not.toBeNull()
        } finally { await actor.client.auth.signOut({ scope: 'local' }) }
    })
    it('SORL-AUTH-006 reads actual staff permissions and rejects viewer edits and tenant leakage', async () => {
        expect(isSupabasePublicKey(process.env.ATLAS_LIVE_SUPABASE_KEY!)).toBe(true)
        const customer = await customerProbe('enterprise')
        for (const name of ['allowed', 'denied', 'viewer']) {
            const actor = await authenticateActor(`enterprise.${name}`)
            try {
                const permissions = dataOrThrow(await actor.client.from('workspace_permissions').select('key').eq('workspace_id', actor.workspaceId).eq('user_uuid', actor.userId), 'staff permissions')
                const keys = new Set(permissions.map(row => row.key as WorkspacePermissionKey))
                expect(resolveWorkspacePermission(actor.role, true, keys, 'orders.saleOrdersAccess')).toBe(name !== 'denied')
                const own = await actor.client.schema('crm').from('sales_orders').insert({ id: crypto.randomUUID(), workspace_id: actor.workspaceId,
                    order_number: `SORL-${name}`, ...customer, created_by: actor.userId, items: [], subtotal: 0, total: 0,
                    currency: 'iqd', status: 'draft', payment_method: 'cash', paid_amount: 0, balance_amount: 0 }).select('id')
                if (name === 'allowed') { expect(own.error).toBeNull(); expect(own.data).toHaveLength(1) }
                else expect(own.error?.code).toBe('42501')
                const provision = await actor.client.rpc('register_resilience_actor_permit', { p_user_id: crypto.randomUUID(), p_workspace_id: actor.workspaceId,
                    p_run_id: crypto.randomUUID(), p_email: 'sorl-forged@example.com', p_role: 'admin' })
                expect(provision.error?.code).toBe('42501')
                const foreign = await authenticateActor('foreign.admin')
                try {
                    const foreignCustomer = await customerProbe('foreign')
                    const foreignId = crypto.randomUUID()
                    const seed = await foreign.client.schema('crm').from('sales_orders').insert({ id: foreignId, workspace_id: foreign.workspaceId,
                        order_number: `SORL-FOREIGN-${name}`, ...foreignCustomer, created_by: foreign.userId, items: [], subtotal: 0, total: 0,
                        currency: 'iqd', status: 'draft', payment_method: 'cash', paid_amount: 0, balance_amount: 0 }).select('id')
                    expect(seed.error).toBeNull(); expect(seed.data).toHaveLength(1)
                    const excluded = dataOrThrow(await actor.client.schema('crm').from('sales_orders').select('id').eq('workspace_id', foreign.workspaceId), 'foreign orders')
                    expect(excluded).toHaveLength(0)
                    const write = await actor.client.schema('crm').from('sales_orders').insert({ id: crypto.randomUUID(), workspace_id: foreign.workspaceId,
                        order_number: 'SORL-FORBIDDEN', ...foreignCustomer, created_by: actor.userId, items: [], subtotal: 0, total: 0,
                        currency: 'iqd', status: 'draft', payment_method: 'cash', paid_amount: 0, balance_amount: 0 })
                    expect(write.error).toMatchObject({ code: 'P0001', message: 'Order workspace does not match the authenticated workspace' })
                } finally { await foreign.client.auth.signOut({ scope: 'local' }) }
                if (name === 'viewer') {
                    const write = await actor.client.schema('crm').from('sales_orders').insert({ id: crypto.randomUUID(), workspace_id: actor.workspaceId,
                        order_number: 'SORL-VIEWER', ...customer, created_by: actor.userId, items: [], subtotal: 0, total: 0,
                        currency: 'iqd', status: 'draft', payment_method: 'cash', paid_amount: 0, balance_amount: 0 })
                    expect(write.error?.code).toBe('42501')
                }
            } finally { await actor.client.auth.signOut({ scope: 'local' }) }
        }
    })
})
