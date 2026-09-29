import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '@/dev/testing/fixtures/browser'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const remote = vi.hoisted(() => ({
    rpc: vi.fn(),
    data: null as unknown,
    error: null as null | { message: string; code?: string }
}))

vi.mock('@/auth/supabase', () => ({ supabase: { rpc: remote.rpc } }))
vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: (_label: string, action: () => PromiseLike<unknown>) => action(),
    normalizeSupabaseActionError: (error: { message?: string }) => new Error(
        error?.message?.toLowerCase().includes('fetch')
            ? 'Could not validate the minimum selling price. Please retry.'
            : error?.message || 'Could not validate the minimum selling price.'
    )
}))

import { db } from './database'
import { MinimumSellingPriceViolationError, assertStaffMinimumSellingPrices } from './minimumSellingPrice'

const WORKSPACE_ID = 'a7300000-0000-4000-8000-000000000001'
const PRODUCT_ID = 'a7300000-0000-4000-8000-000000000002'
const NOW = '2026-09-18T09:00:00.000Z'

async function seedProduct(minimumSellingPrice: number | null = 12) {
    await db.products.put({
        id: PRODUCT_ID,
        workspaceId: WORKSPACE_ID,
        sku: 'MIN-12',
        name: 'Minimum price item',
        description: '',
        categoryId: null,
        price: 15,
        minimumSellingPrice,
        costPrice: 10,
        canBeReturned: true,
        returnRules: '',
        quantity: 5,
        minStockLevel: 0,
        unit: 'pcs',
        currency: 'usd',
        createdAt: NOW,
        updatedAt: NOW,
        syncStatus: 'synced',
        lastSyncedAt: NOW,
        version: 1,
        isDeleted: false
    })
}

describe('minimum selling price validation service', () => {
    beforeAll(() => installTestBrowser())
    beforeEach(async () => {
        await db.delete()
        await db.open()
        remote.rpc.mockReset()
        remote.data = null
        remote.error = null
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
    })
    afterEach(() => clearWorkspaceModeSnapshot(WORKSPACE_ID))
    afterAll(async () => { await db.delete() })

    it('checks the current Local product floor and permits the exact boundary', async () => {
        await seedProduct()
        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 11.999, currency: 'usd' }]
        })).rejects.toMatchObject({
            name: 'MinimumSellingPriceViolationError',
            violations: [{ productId: PRODUCT_ID, minimumSellingPrice: 12, currency: 'usd' }]
        })
        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 12, currency: 'usd' }]
        })).resolves.toBeUndefined()
    })

    it('lets admins sell below the staff floor and treats null as unrestricted', async () => {
        await seedProduct()
        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'admin',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 1, currency: 'usd' }]
        })).resolves.toBeUndefined()
        await seedProduct(null)
        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 1, currency: 'usd' }]
        })).resolves.toBeUndefined()
    })

    it('does not compare amounts from different currencies without a conversion', async () => {
        await seedProduct()
        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 1_000, currency: 'iqd' }]
        })).rejects.toMatchObject({
            name: 'MinimumSellingPriceViolationError',
            message: expect.stringContaining('Could not verify the selling currency')
        })
    })

    it('sends a scoped validation request in Cloud mode and accepts a valid result', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        remote.data = []
        remote.rpc.mockImplementation(async () => ({ data: remote.data, error: remote.error }))

        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 24, unitFactor: 2, currency: 'usd' }]
        })).resolves.toBeUndefined()

        expect(remote.rpc).toHaveBeenCalledWith('validate_staff_minimum_selling_prices', {
            p_workspace_id: WORKSPACE_ID,
            p_items: [{ product_id: PRODUCT_ID, effective_selling_price: 24, unit_factor: 2, currency: 'usd' }]
        })
    })

    it('turns a server floor result into a line-specific application error', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'hybrid' })
        remote.data = [{
            line_index: 0,
            product_id: PRODUCT_ID,
            product_name: 'Minimum price item',
            minimum_selling_price: '12'
        }]
        remote.rpc.mockImplementation(async () => ({ data: remote.data, error: remote.error }))

        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 20, unitFactor: 2, currency: 'usd' }]
        })).rejects.toMatchObject({
            name: 'MinimumSellingPriceViolationError',
            message: expect.stringContaining('$24'),
            violations: [{ lineIndex: 0, minimumSellingPrice: 24 }]
        })
    })

    it('returns a controlled currency-unavailable result instead of comparing raw currencies', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        remote.data = [{
            line_index: 0,
            product_id: PRODUCT_ID,
            product_name: 'Minimum price item',
            minimum_selling_price: '12',
            validation_error: 'currency_unavailable'
        }]
        remote.rpc.mockImplementation(async () => ({ data: remote.data, error: remote.error }))

        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 1_000, currency: 'iqd' }]
        })).rejects.toMatchObject({
            name: 'MinimumSellingPriceViolationError',
            message: expect.stringContaining('Could not verify the selling currency')
        })
        expect(remote.rpc).toHaveBeenCalledWith('validate_staff_minimum_selling_prices', expect.objectContaining({
            p_items: [{ product_id: PRODUCT_ID, effective_selling_price: 1_000, unit_factor: 1, currency: 'iqd' }]
        }))
    })

    it('normalizes validation request failures into a user-friendly retry message', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        remote.rpc.mockImplementation(async () => ({ data: null, error: { message: 'Failed to fetch' } }))

        await expect(assertStaffMinimumSellingPrices({
            workspaceId: WORKSPACE_ID,
            actingUserRole: 'staff',
            items: [{ productId: PRODUCT_ID, effectiveSellingPrice: 20, currency: 'usd' }]
        })).rejects.toThrow('Could not validate the minimum selling price. Please retry.')
        expect(new MinimumSellingPriceViolationError([]).message).toContain('cannot be lower')
    })
})
