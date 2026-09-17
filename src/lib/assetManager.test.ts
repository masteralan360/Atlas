import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    downloadWorkspaceResources: vi.fn(),
    isLocalWorkspaceMode: vi.fn(() => false),
    isTauri: vi.fn(() => true),
}))

vi.mock('./platform', () => ({
    isTauri: mocks.isTauri,
}))

vi.mock('@/services/platformService', () => ({
    platformService: {},
}))

vi.mock('@/services/r2Service', () => ({
    r2Service: {},
}))

vi.mock('@/local-db', () => ({
    db: {},
}))

vi.mock('@/auth/supabase', () => ({
    supabase: {},
}))

vi.mock('@/workspace/workspaceMode', () => ({
    isLocalWorkspaceMode: mocks.isLocalWorkspaceMode,
}))

vi.mock('@/lib/workspaceResourceSync', () => ({
    downloadWorkspaceResources: mocks.downloadWorkspaceResources,
}))

import { AssetManager } from './assetManager'

const initializeManager = (workspaceId = 'workspace-id') => {
    const manager = new AssetManager()
    vi.spyOn(manager, 'startWatcher').mockImplementation(() => undefined)
    manager.initialize(workspaceId, 'cloud')
    return manager
}

describe('AssetManager workspace resource sync', () => {
    const sessionValues = new Map<string, string>()

    beforeEach(() => {
        sessionValues.clear()
        vi.stubGlobal('window', {
            sessionStorage: {
                getItem: (key: string) => sessionValues.get(key) ?? null,
                setItem: (key: string, value: string) => sessionValues.set(key, value),
            },
        })
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        mocks.downloadWorkspaceResources.mockReset()
        mocks.downloadWorkspaceResources.mockResolvedValue({
            total: 0,
            downloaded: 0,
            skipped: 0,
            failed: 0,
        })
        mocks.isLocalWorkspaceMode.mockReset()
        mocks.isLocalWorkspaceMode.mockReturnValue(false)
        mocks.isTauri.mockReturnValue(true)
    })

    it.each(['local', 'demo'] as const)(
        'does not start R2 resource sync for %s mode when the persisted snapshot is stale',
        (workspaceMode) => {
            const manager = new AssetManager()

            manager.initialize('workspace-id', workspaceMode)

            expect(mocks.downloadWorkspaceResources).not.toHaveBeenCalled()
            expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'idle' })
        }
    )

    it('reports an up-to-date state when no new resources are downloaded', async () => {
        const manager = initializeManager()

        expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'checking' })
        await vi.waitFor(() => {
            expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'upToDate' })
        })
    })

    it('reports download progress and requires a reload when new resources arrive', async () => {
        mocks.downloadWorkspaceResources.mockImplementation(async ({ onProgress }) => {
            onProgress?.({ current: 2, total: 3, fileName: 'logo.png' })
            return { total: 3, downloaded: 1, skipped: 2, failed: 0 }
        })
        const manager = initializeManager()

        await vi.waitFor(() => {
            expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'reloadRequired' })
        })
        expect(mocks.downloadWorkspaceResources).toHaveBeenCalledWith(expect.objectContaining({
            workspaceId: 'workspace-id',
            onProgress: expect.any(Function),
        }))
    })

    it('keeps a retryable error state when a resource download has failures', async () => {
        mocks.downloadWorkspaceResources.mockResolvedValue({
            total: 2,
            downloaded: 1,
            skipped: 0,
            failed: 1,
        })
        const manager = initializeManager()

        await vi.waitFor(() => {
            expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'error' })
        })
    })

    it('keeps a retryable error state when listing or downloading throws', async () => {
        mocks.downloadWorkspaceResources.mockRejectedValue(new Error('network unavailable'))
        const manager = initializeManager()

        await vi.waitFor(() => {
            expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'error' })
        })
    })

    it('requires a reload after a successful retry when the failed attempt downloaded resources', async () => {
        mocks.downloadWorkspaceResources
            .mockResolvedValueOnce({ total: 2, downloaded: 1, skipped: 0, failed: 1 })
            .mockResolvedValueOnce({ total: 2, downloaded: 0, skipped: 2, failed: 0 })
        const manager = initializeManager()

        await vi.waitFor(() => {
            expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'error' })
        })

        manager.retryColdStartSync()

        await vi.waitFor(() => {
            expect(manager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'reloadRequired' })
        })
        expect(mocks.downloadWorkspaceResources).toHaveBeenCalledTimes(2)
    })

    it('does not run again after a successful sync and reload in the same workspace session', async () => {
        const firstManager = initializeManager()

        await vi.waitFor(() => {
            expect(firstManager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'upToDate' })
        })

        const reloadedManager = new AssetManager()
        vi.spyOn(reloadedManager, 'startWatcher').mockImplementation(() => undefined)
        reloadedManager.initialize('workspace-id', 'cloud')

        expect(mocks.downloadWorkspaceResources).toHaveBeenCalledTimes(1)
        expect(reloadedManager.getWorkspaceResourceSyncProgress()).toEqual({ status: 'idle' })
    })
})
