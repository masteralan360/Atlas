import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
    const channel = {
        on: vi.fn(),
        subscribe: vi.fn()
    }

    return {
        channel,
        channelFactory: vi.fn(),
        removeChannel: vi.fn(),
        changeCallback: undefined as ((payload: unknown) => void) | undefined,
        statusCallback: undefined as ((status: string) => void) | undefined
    }
})

vi.mock('@/auth/supabase', () => ({
    supabase: {
        channel: testState.channelFactory,
        removeChannel: testState.removeChannel
    }
}))

import {
    getMarketplaceOrderRefreshDetail,
    subscribeToMarketplaceOrderChanges
} from './marketplaceOrderRealtime'

function configureChannelMock() {
    testState.channelFactory.mockReturnValue(testState.channel)
    testState.channel.on.mockImplementation((_type, _config, callback) => {
        testState.changeCallback = callback as (payload: unknown) => void
        return testState.channel
    })
    testState.channel.subscribe.mockImplementation((callback) => {
        testState.statusCallback = callback as (status: string) => void
        return testState.channel
    })
}

describe('marketplace order Realtime subscription', () => {
    beforeEach(() => {
        testState.channelFactory.mockReset()
        testState.removeChannel.mockReset()
        testState.channel.on.mockReset()
        testState.channel.subscribe.mockReset()
        testState.changeCallback = undefined
        testState.statusCallback = undefined
        configureChannelMock()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('subscribes with the workspace-scoped Postgres Changes contract and forwards a successful change', () => {
        const listener = vi.fn()
        const unsubscribe = subscribeToMarketplaceOrderChanges('workspace-a', listener)

        expect(testState.channelFactory).toHaveBeenCalledWith('marketplace-orders-workspace-a')
        expect(testState.channel.on).toHaveBeenCalledWith(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'marketplace_orders',
                filter: 'workspace_id=eq.workspace-a'
            },
            expect.any(Function)
        )

        testState.changeCallback?.({
            eventType: 'INSERT',
            new: { id: 'order-1', customer_phone: '+964000000000' },
            old: {},
            schema: 'public',
            table: 'marketplace_orders',
            commit_timestamp: '2026-09-16T10:00:00.000Z',
            errors: null
        })

        expect(listener).toHaveBeenCalledWith(expect.objectContaining({
            type: 'change',
            payload: expect.objectContaining({ eventType: 'INSERT' })
        }))
        expect(getMarketplaceOrderRefreshDetail('workspace-a', listener.mock.calls[0][0])).toEqual({
            workspaceId: 'workspace-a',
            source: 'realtime',
            eventType: 'INSERT',
            orderId: 'order-1'
        })

        unsubscribe()
        expect(testState.removeChannel).toHaveBeenCalledWith(testState.channel)
    })

    it('shares one channel and closes it only after the final consumer leaves', () => {
        const first = vi.fn()
        const second = vi.fn()
        const unsubscribeFirst = subscribeToMarketplaceOrderChanges('workspace-a', first)
        const unsubscribeSecond = subscribeToMarketplaceOrderChanges('workspace-a', second)

        expect(testState.channelFactory).toHaveBeenCalledTimes(1)

        testState.changeCallback?.({
            eventType: 'UPDATE',
            new: { id: 'order-2' },
            old: { id: 'order-2' },
            schema: 'public',
            table: 'marketplace_orders',
            commit_timestamp: '2026-09-16T10:00:00.000Z',
            errors: null
        })

        expect(first).toHaveBeenCalledTimes(1)
        expect(second).toHaveBeenCalledTimes(1)

        unsubscribeFirst()
        expect(testState.removeChannel).not.toHaveBeenCalled()

        unsubscribeSecond()
        expect(testState.removeChannel).toHaveBeenCalledTimes(1)
    })

    it('requests reconciliation after a reconnected channel and logs non-fatal channel failures', () => {
        const listener = vi.fn()
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const unsubscribe = subscribeToMarketplaceOrderChanges('workspace-a', listener)

        testState.statusCallback?.('SUBSCRIBED')
        expect(listener).not.toHaveBeenCalled()

        testState.statusCallback?.('SUBSCRIBED')
        expect(listener).toHaveBeenCalledWith({ type: 'reconnected' })
        expect(getMarketplaceOrderRefreshDetail('workspace-a', listener.mock.calls[0][0])).toEqual({
            workspaceId: 'workspace-a',
            source: 'reconnected'
        })

        testState.statusCallback?.('CHANNEL_ERROR')
        expect(warning).toHaveBeenCalledWith('[MarketplaceOrders] Realtime subscription: CHANNEL_ERROR')

        unsubscribe()
    })
})
