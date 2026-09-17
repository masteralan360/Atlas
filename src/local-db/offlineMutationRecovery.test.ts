import { beforeEach, describe, expect, it, vi } from 'vitest'

const recoveryState = vi.hoisted(() => {
    const mutations: Array<Record<string, any>> = []
    const products: Array<Record<string, any>> = []
    let remoteRow: Record<string, unknown> | null = null
    let remoteError: unknown = null
    let cloudAuthority = true

    const mutationTable = {
        get: vi.fn(async (id: string) => mutations.find((row) => row.id === id)),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
            const row = mutations.find((candidate) => candidate.id === id)
            if (!row) return 0
            Object.assign(row, patch)
            return 1
        }),
        where: vi.fn((indexName: string) => ({
            equals: vi.fn((status: string) => {
                if (indexName !== 'status') throw new Error(`Unexpected mutation index: ${indexName}`)
                return {
                    toArray: vi.fn(async () => mutations.filter((row) => row.status === status))
                }
            })
        }))
    }

    const productsTable = {
        get: vi.fn(async (id: string) => products.find((row) => row.id === id)),
        put: vi.fn(async (row: Record<string, unknown>) => {
            const index = products.findIndex((candidate) => candidate.id === row.id)
            if (index >= 0) products[index] = { ...row }
            else products.push({ ...row })
            return row.id
        }),
        delete: vi.fn(async (id: string) => {
            const index = products.findIndex((row) => row.id === id)
            if (index >= 0) products.splice(index, 1)
        })
    }

    const query = {
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: remoteRow, error: remoteError }))
    }
    const client = {
        from: vi.fn(() => ({
            select: vi.fn(() => query)
        })),
        rpc: vi.fn(() => query)
    }

    return {
        mutations,
        products,
        mutationTable,
        productsTable,
        query,
        client,
        setRemoteRow(row: Record<string, unknown> | null) {
            remoteRow = row
        },
        setRemoteError(error: unknown) {
            remoteError = error
        },
        setCloudAuthority(nextValue: boolean) {
            cloudAuthority = nextValue
        },
        getCloudAuthority() {
            return cloudAuthority
        },
        reset() {
            mutations.splice(0)
            products.splice(0)
            remoteRow = null
            remoteError = null
            cloudAuthority = true
            mutationTable.get.mockClear()
            mutationTable.update.mockClear()
            mutationTable.where.mockClear()
            productsTable.get.mockClear()
            productsTable.put.mockClear()
            productsTable.delete.mockClear()
            query.eq.mockClear()
            query.maybeSingle.mockClear()
            client.from.mockClear()
            client.rpc.mockClear()
        }
    }
})

vi.mock('./database', () => ({
    db: {
        offline_mutations: recoveryState.mutationTable,
        products: recoveryState.productsTable,
        transaction: async (_mode: string, ...args: unknown[]) => {
            const scope = args.at(-1)
            if (typeof scope !== 'function') throw new Error('Expected a transaction scope')
            return scope()
        }
    }
}))

vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: vi.fn(() => recoveryState.client),
    getSupabaseRemoteTableName: vi.fn((tableName: string) => tableName),
    getVisibilityScopedTableRpc: vi.fn(() => undefined)
}))

vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: vi.fn((_label: string, request: () => Promise<unknown>) => request())
}))

vi.mock('@/lib/utils', () => ({
    toCamelCase: (row: Record<string, unknown>) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
            key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
            value
        ])
    )
}))

vi.mock('./cloudReconciliation', () => ({
    canReconcileCloudWorkspaceData: vi.fn(async () => recoveryState.getCloudAuthority())
}))

import {
    canRecoverOfflineMutation,
    discardAndRestoreOfflineMutation
} from './offlineMutationRecovery'

function failedProductMutation(overrides: Record<string, unknown> = {}) {
    return {
        id: 'mutation-1',
        workspaceId: 'workspace-1',
        entityType: 'products' as const,
        entityId: 'product-1',
        operation: 'update' as const,
        payload: { id: 'product-1', name: 'Invalid local name' },
        createdAt: '2026-09-16T08:00:00.000Z',
        status: 'failed' as const,
        error: 'Sync integrity issue: validation failed',
        ...overrides
    }
}

describe('discardAndRestoreOfflineMutation', () => {
    beforeEach(() => {
        recoveryState.reset()
    })

    it('replaces a failed local update with the authoritative Supabase row and retires only its mutation', async () => {
        recoveryState.mutations.push(failedProductMutation(), {
            id: 'independent-mutation',
            workspaceId: 'workspace-1',
            entityType: 'categories',
            entityId: 'category-1',
            operation: 'update',
            payload: { id: 'category-1', name: 'Office' },
            createdAt: '2026-09-16T08:02:00.000Z',
            status: 'pending'
        })
        recoveryState.products.push({
            id: 'product-1', workspaceId: 'workspace-1', name: 'Invalid local name', syncStatus: 'conflict'
        })
        recoveryState.setRemoteRow({
            id: 'product-1', workspace_id: 'workspace-1', name: 'Authoritative product', is_deleted: false
        })

        const result = await discardAndRestoreOfflineMutation('workspace-1', 'mutation-1', 'user-1')

        expect(result).toMatchObject({ status: 'discarded', action: 'restored', mutationId: 'mutation-1' })
        expect(recoveryState.client.from).toHaveBeenCalledWith('products')
        expect(recoveryState.query.eq).toHaveBeenNthCalledWith(1, 'id', 'product-1')
        expect(recoveryState.query.eq).toHaveBeenNthCalledWith(2, 'workspace_id', 'workspace-1')
        expect(recoveryState.products).toEqual([
            expect.objectContaining({
                id: 'product-1', workspaceId: 'workspace-1', name: 'Authoritative product', syncStatus: 'synced'
            })
        ])
        expect(recoveryState.mutations).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'mutation-1', status: 'discarded', discardedBy: 'user-1', error: undefined }),
            expect.objectContaining({ id: 'independent-mutation', status: 'pending' })
        ]))
    })

    it('removes a local-only create when Supabase confirms no record exists', async () => {
        recoveryState.mutations.push(failedProductMutation({ operation: 'create' }))
        recoveryState.products.push({ id: 'product-1', workspaceId: 'workspace-1', name: 'Local only', syncStatus: 'conflict' })
        recoveryState.setRemoteRow(null)

        const result = await discardAndRestoreOfflineMutation('workspace-1', 'mutation-1', 'user-1')

        expect(result).toMatchObject({ status: 'discarded', action: 'removed' })
        expect(recoveryState.products).toEqual([])
        expect(recoveryState.mutations[0]).toMatchObject({ status: 'discarded' })
    })

    it('does not change local data when an update has no authoritative cloud row', async () => {
        recoveryState.mutations.push(failedProductMutation())
        recoveryState.products.push({ id: 'product-1', workspaceId: 'workspace-1', name: 'Conflict', syncStatus: 'conflict' })
        recoveryState.setRemoteRow(null)

        await expect(discardAndRestoreOfflineMutation('workspace-1', 'mutation-1', 'user-1'))
            .resolves.toEqual({ status: 'not_discarded', reason: 'remote_missing' })

        expect(recoveryState.products[0]).toMatchObject({ name: 'Conflict', syncStatus: 'conflict' })
        expect(recoveryState.mutations[0]).toMatchObject({ status: 'failed' })
    })

    it('keeps the queue and local record unchanged when the Supabase read fails', async () => {
        recoveryState.mutations.push(failedProductMutation())
        recoveryState.products.push({ id: 'product-1', workspaceId: 'workspace-1', name: 'Conflict', syncStatus: 'conflict' })
        recoveryState.setRemoteError({ message: 'permission denied' })

        await expect(discardAndRestoreOfflineMutation('workspace-1', 'mutation-1', 'user-1'))
            .resolves.toEqual({ status: 'not_discarded', reason: 'remote_request_failed' })

        expect(recoveryState.products[0]).toMatchObject({ name: 'Conflict', syncStatus: 'conflict' })
        expect(recoveryState.mutations[0]).toMatchObject({ status: 'failed' })
    })

    it('requires confirmed Cloud or Hybrid reconciliation authority before it reads or changes data', async () => {
        recoveryState.mutations.push(failedProductMutation())
        recoveryState.products.push({ id: 'product-1', workspaceId: 'workspace-1', name: 'Conflict', syncStatus: 'conflict' })
        recoveryState.setCloudAuthority(false)

        await expect(discardAndRestoreOfflineMutation('workspace-1', 'mutation-1', 'user-1'))
            .resolves.toEqual({ status: 'not_discarded', reason: 'cloud_authority_unavailable' })

        expect(recoveryState.client.from).not.toHaveBeenCalled()
        expect(recoveryState.products[0]).toMatchObject({ name: 'Conflict', syncStatus: 'conflict' })
        expect(recoveryState.mutations[0]).toMatchObject({ status: 'failed' })
    })

    it('refuses recovery when another queued change depends on the selected record', async () => {
        recoveryState.mutations.push(failedProductMutation(), {
            id: 'dependent-mutation',
            workspaceId: 'workspace-1',
            entityType: 'price_book_items',
            entityId: 'price-book-item-1',
            operation: 'create',
            payload: { id: 'price-book-item-1', productId: 'product-1' },
            createdAt: '2026-09-16T08:01:00.000Z',
            status: 'pending'
        })

        await expect(discardAndRestoreOfflineMutation('workspace-1', 'mutation-1', 'user-1'))
            .resolves.toEqual({ status: 'not_discarded', reason: 'dependent_changes' })

        expect(recoveryState.client.from).not.toHaveBeenCalled()
        expect(recoveryState.mutations[0]).toMatchObject({ status: 'failed' })
    })

    it('never enables generic recovery for payment transactions', () => {
        expect(canRecoverOfflineMutation({
            ...failedProductMutation(),
            entityType: 'payment_transactions'
        })).toBe(false)
    })
})
