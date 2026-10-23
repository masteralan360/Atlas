import { describe, expect, it } from 'vitest'

import { prepareRemoteMutationPayload } from './syncPayloadContract'

it('removes retired per-post fees from legacy agent retries while preserving the agent identity', () => {
    expect(prepareRemoteMutationPayload('agents', {
        id: 'courier-1', workspaceId: 'workspace-1', agentType: 'courier', courierDeliveryFee: 5,
    })).toEqual({ id: 'courier-1', workspace_id: 'workspace-1', agent_type: 'courier' })
})

describe('Price Book sync payload', () => {
    it('includes assigned and cleared colors in remote mutations', () => {
        expect(prepareRemoteMutationPayload('price_books', {
            id: 'price-book-1',
            workspaceId: 'workspace-1',
            color: '#12abef',
            syncStatus: 'pending',
            lastSyncedAt: null
        })).toMatchObject({ color: '#12abef' })

        expect(prepareRemoteMutationPayload('price_books', {
            id: 'price-book-1',
            workspaceId: 'workspace-1',
            color: null
        })).toMatchObject({ color: null })
    })
})

describe('partner summary upload retirement', () => {
    it.each([
        ['business_partners', { totalSalesOrders:9, receivableBalance:20, netExposure:10,
            receivableCurrencyTotals:[{currency:'USD',amount:20}], summarySource:'server' }],
        ['customers', {totalOrders:9,totalSpent:20,outstandingBalance:10}],
        ['suppliers', {totalPurchases:9,totalSpent:20}],
    ])('strips derived fields from old %s queue entries while preserving business changes', (table,summary) => {
        expect(prepareRemoteMutationPayload(table, {id:'partner',workspaceId:'workspace',
            partnerName:'Renamed',creditLimit:100, ...summary})).toEqual({
            id:'partner',workspace_id:'workspace',partner_name:'Renamed',credit_limit:100,
        })
    })
})
