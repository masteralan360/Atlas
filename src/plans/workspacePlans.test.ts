import { describe, expect, it } from 'vitest'

import {
    WORKSPACE_PLANS,
    applyWorkspaceOverrides,
    getPlanCapabilities,
    planHasCapability,
    planHasModule,
    planHasWorkspaceFeature
} from './workspacePlans'

describe('Agents workspace module access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasModule(plan, 'agents')).toBe(false)
        }
    })

    it('is enabled only by a workspace module grant override', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-agents',
            workspace_id: 'workspace-1',
            type: 'module',
            key: 'agents',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }])

        expect(resolved.modules).toContain('agents')
    })
})

describe('Sales Agent Commissions workspace module access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasModule(plan, 'sales_agent_commissions')).toBe(false)
            expect(planHasWorkspaceFeature(plan, 'sales_agent_commissions')).toBe(false)
        }
    })

    it('is enabled only by an explicit grant with Agents and Orders available', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [
            {
                id: 'override-agents',
                workspace_id: 'workspace-1',
                type: 'module',
                key: 'agents',
                value: 'grant',
                created_by: null,
                created_at: new Date(0).toISOString()
            },
            {
                id: 'override-sales-agent-commissions',
                workspace_id: 'workspace-1',
                type: 'module',
                key: 'sales_agent_commissions',
                value: 'grant',
                created_by: null,
                created_at: new Date(0).toISOString()
            }
        ])

        expect(resolved.modules).toContain('sales_agent_commissions')
    })

    it('ignores an orphaned grant when Agents or Orders is unavailable', () => {
        const override = {
            id: 'override-sales-agent-commissions',
            workspace_id: 'workspace-1',
            type: 'module' as const,
            key: 'sales_agent_commissions',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }

        expect(
            applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [override]).modules
        ).not.toContain('sales_agent_commissions')

        expect(
            applyWorkspaceOverrides(getPlanCapabilities('basic'), [
                {
                    ...override,
                    id: 'override-agents',
                    key: 'agents'
                },
                override
            ]).modules
        ).not.toContain('sales_agent_commissions')
    })
})

describe('Post Service workspace module access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasModule(plan, 'post_service')).toBe(false)
        }
    })

    it('is enabled only by a workspace module grant override', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-post-service',
            workspace_id: 'workspace-1',
            type: 'module',
            key: 'post_service',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }])

        expect(resolved.modules).toContain('post_service')
    })
})

describe('Agent Sales Accounts workspace module access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasModule(plan, 'agent_sales_accounts')).toBe(false)
            expect(planHasWorkspaceFeature(plan, 'agent_sales_accounts')).toBe(false)
        }
    })

    it('is effective only with an explicit grant and both Agents and Orders', () => {
        const agentSalesAccountGrant = {
            id: 'override-agent-sales-accounts',
            workspace_id: 'workspace-1',
            type: 'module' as const,
            key: 'agent_sales_accounts',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }

        expect(
            applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [agentSalesAccountGrant]).modules
        ).not.toContain('agent_sales_accounts')

        expect(
            applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [
                {
                    ...agentSalesAccountGrant,
                    id: 'override-agents',
                    key: 'agents'
                },
                agentSalesAccountGrant
            ]).modules
        ).toContain('agent_sales_accounts')
    })
})

describe('Car Rental Service workspace module access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasModule(plan, 'car_rental')).toBe(false)
            expect(planHasWorkspaceFeature(plan, 'car_rental')).toBe(false)
        }
    })

    it('is enabled only by a workspace module grant override', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-car-rental',
            workspace_id: 'workspace-1',
            type: 'module',
            key: 'car_rental',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }])

        expect(resolved.modules).toContain('car_rental')
    })
})

describe('Instant POS and KDS workspace module access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasModule(plan, 'instant_pos')).toBe(false)
            expect(planHasModule(plan, 'kds')).toBe(false)
        }
    })

    it('is enabled only by workspace module grant overrides', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [
            {
                id: 'override-instant-pos',
                workspace_id: 'workspace-1',
                type: 'module',
                key: 'instant_pos',
                value: 'grant',
                created_by: null,
                created_at: new Date(0).toISOString()
            },
            {
                id: 'override-kds',
                workspace_id: 'workspace-1',
                type: 'module',
                key: 'kds',
                value: 'grant',
                created_by: null,
                created_at: new Date(0).toISOString()
            }
        ])

        expect(resolved.modules).toEqual(expect.arrayContaining(['instant_pos', 'kds']))
    })
})

describe('Business Partner Group Privacy workspace capability', () => {
    it('is not included in a plan and is available only through an admin-granted capability override', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasCapability(plan, 'businessPartnerGroupPrivacy')).toBe(false)
        }

        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-business-partner-group-privacy',
            workspace_id: 'workspace-1',
            type: 'capability',
            key: 'businessPartnerGroupPrivacy',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString(),
        }])

        expect(resolved.capabilities).toContain('businessPartnerGroupPrivacy')
    })
})

describe('Orders workspace module access', () => {
    it('maps the orders feature to the revocable orders module', () => {
        expect(planHasWorkspaceFeature('enterprise', 'orders')).toBe(true)
        expect(planHasWorkspaceFeature('basic', 'orders')).toBe(false)
    })

    it('can be revoked from an enterprise workspace by module override', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-orders',
            workspace_id: 'workspace-1',
            type: 'module',
            key: 'orders',
            value: 'revoke',
            created_by: null,
            created_at: new Date(0).toISOString()
        }])

        expect(resolved.modules).not.toContain('orders')
    })
})

describe('Order free bonus capability access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasCapability(plan, 'orderFreeBonus')).toBe(false)
        }
    })

    it('is enabled only by a workspace capability grant override', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-order-free-bonus',
            workspace_id: 'workspace-1',
            type: 'capability',
            key: 'orderFreeBonus',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }])

        expect(resolved.capabilities).toContain('orderFreeBonus')
    })
})

describe('Price Books capability access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasCapability(plan, 'priceBooks')).toBe(false)
        }
    })

    it('is enabled only by a workspace capability grant override', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-price-books',
            workspace_id: 'workspace-1',
            type: 'capability',
            key: 'priceBooks',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }])

        expect(resolved.capabilities).toContain('priceBooks')
    })
})

describe('Quick Order capability access', () => {
    it('is not included in any workspace subscription plan', () => {
        for (const plan of WORKSPACE_PLANS) {
            expect(planHasCapability(plan, 'quickOrder')).toBe(false)
        }
    })

    it('is enabled only by a workspace capability grant override', () => {
        const resolved = applyWorkspaceOverrides(getPlanCapabilities('enterprise'), [{
            id: 'override-quick-order',
            workspace_id: 'workspace-1',
            type: 'capability',
            key: 'quickOrder',
            value: 'grant',
            created_by: null,
            created_at: new Date(0).toISOString()
        }])

        expect(resolved.capabilities).toContain('quickOrder')
    })
})
