import { beforeEach, describe, expect, it, vi } from 'vitest'

const { normalizeSupabaseActionError } = vi.hoisted(() => ({
    normalizeSupabaseActionError: vi.fn((error: unknown) => {
        const message = error && typeof error === 'object' && 'message' in error
            ? String((error as { message: unknown }).message)
            : String(error)
        return new Error(message === 'Failed to fetch'
            ? 'The request did not finish. Please try again.'
            : message)
    })
}))

vi.mock('@/lib/supabaseRequest', () => ({ normalizeSupabaseActionError }))

import { executeMarketplaceOrderTransition } from './MarketplaceOrderTransition'

describe('marketplace order transition request', () => {
    beforeEach(() => normalizeSupabaseActionError.mockClear())

    it('uses the existing RPC contract and returns its successful result', async () => {
        const response = {
            status: 'delivered' as const,
            sales_order_id: 'sales-order-1',
            warning: null
        }
        const rpc = vi.fn(async () => ({ data: response, error: null }))

        await expect(executeMarketplaceOrderTransition({
            rpc,
            orderId: 'marketplace-order-1',
            nextStatus: 'delivered'
        })).resolves.toEqual(response)

        expect(rpc).toHaveBeenCalledTimes(1)
        expect(rpc).toHaveBeenCalledWith('transition_marketplace_order', {
            order_id: 'marketplace-order-1',
            next_status: 'delivered',
            cancel_reason: null
        })
    })

    it('passes the cancellation reason through the same RPC contract', async () => {
        const rpc = vi.fn(async () => ({ data: { status: 'cancelled' as const }, error: null }))

        await executeMarketplaceOrderTransition({
            rpc,
            orderId: 'marketplace-order-2',
            nextStatus: 'cancelled',
            cancelReason: 'Customer request'
        })

        expect(rpc).toHaveBeenCalledWith('transition_marketplace_order', {
            order_id: 'marketplace-order-2',
            next_status: 'cancelled',
            cancel_reason: 'Customer request'
        })
    })

    it('preserves server validation details for the UI error toast', async () => {
        const rpc = vi.fn(async () => ({
            data: null,
            error: { message: 'Pending orders can only move to confirmed or cancelled' }
        }))

        await expect(executeMarketplaceOrderTransition({
            rpc,
            orderId: 'marketplace-order-3',
            nextStatus: 'processing'
        })).rejects.toThrow('Pending orders can only move to confirmed or cancelled')
        expect(normalizeSupabaseActionError).toHaveBeenCalledTimes(1)
    })

    it('normalizes network failures to a user-friendly retry message', async () => {
        const rpc = vi.fn(async () => ({
            data: null,
            error: { message: 'Failed to fetch' }
        }))

        await expect(executeMarketplaceOrderTransition({
            rpc,
            orderId: 'marketplace-order-4',
            nextStatus: 'confirmed'
        })).rejects.toThrow('The request did not finish. Please try again.')
        expect(normalizeSupabaseActionError).toHaveBeenCalledTimes(1)
    })
})
