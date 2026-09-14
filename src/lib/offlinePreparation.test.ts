import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    dbOpen: vi.fn(),
    appSettingsCount: vi.fn(),
    checkPwaSqliteReadiness: vi.fn(),
    getPersistentStorageStatus: vi.fn(),
    getStorageEstimate: vi.fn(),
    requestPersistentStorage: vi.fn(),
    getAppSetting: vi.fn(),
    setAppSetting: vi.fn(),
    getPwaOfflineShellStatus: vi.fn(),
    preparePwaOfflineShell: vi.fn(),
    areApplicationUpdatesDisabled: vi.fn(),
    runManagedFullSync: vi.fn()
}))

vi.mock('@/local-db/database', () => ({
    db: {
        open: mocks.dbOpen,
        app_settings: { count: mocks.appSettingsCount }
    }
}))

vi.mock('@/local-db/pwaSqlite', () => ({
    checkPwaSqliteReadiness: mocks.checkPwaSqliteReadiness
}))

vi.mock('@/local-db/storagePersist', () => ({
    getPersistentStorageStatus: mocks.getPersistentStorageStatus,
    getStorageEstimate: mocks.getStorageEstimate,
    requestPersistentStorage: mocks.requestPersistentStorage
}))

vi.mock('@/local-db/settings', () => ({
    getAppSetting: mocks.getAppSetting,
    setAppSetting: mocks.setAppSetting
}))

vi.mock('@/lib/pwaUpdateControl', () => ({
    getPwaOfflineShellStatus: mocks.getPwaOfflineShellStatus,
    preparePwaOfflineShell: mocks.preparePwaOfflineShell
}))

vi.mock('@/lib/updatePreference', () => ({
    areApplicationUpdatesDisabled: mocks.areApplicationUpdatesDisabled
}))

vi.mock('@/sync/syncCoordinator', () => ({
    runManagedFullSync: mocks.runManagedFullSync
}))

import {
    OfflinePreparationError,
    getOfflineReadinessSnapshot,
    prepareForOfflineUse
} from './offlinePreparation'
import type { AuthUser } from '@/auth/AuthContext'

const user: AuthUser = {
    id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    role: 'admin',
    workspaceId: 'workspace-1',
    sourceWorkspaceId: 'workspace-1',
    workspaceCode: 'WS-1',
    workspaceMode: 'hybrid'
}

describe('offline preparation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.dbOpen.mockResolvedValue(undefined)
        mocks.appSettingsCount.mockResolvedValue(1)
        mocks.requestPersistentStorage.mockResolvedValue(true)
        mocks.getPersistentStorageStatus.mockResolvedValue(true)
        mocks.getStorageEstimate.mockResolvedValue({ usage: 1024, quota: 4096, percentage: 25 })
        mocks.runManagedFullSync.mockResolvedValue({ success: true, pushed: 0, pulled: 5, errors: [] })
        mocks.preparePwaOfflineShell.mockResolvedValue({
            ready: true,
            status: 'ready',
            buildId: 'build-1',
            cachedAssets: 30
        })
        mocks.getPwaOfflineShellStatus.mockResolvedValue({ ready: true, buildId: 'build-1', cachedAssets: 30 })
        mocks.areApplicationUpdatesDisabled.mockReturnValue(false)
        mocks.getAppSetting.mockResolvedValue(undefined)
        mocks.checkPwaSqliteReadiness.mockResolvedValue({
            ready: true,
            scope: { workspaceId: 'workspace-1', userId: 'user-1' }
        })
    })

    it('fully synchronizes Cloud Sync data and records verified readiness', async () => {
        const result = await prepareForOfflineUse({ user, dataMode: 'hybrid' })

        expect(result.outcome).toBe('ready')
        expect(mocks.runManagedFullSync).toHaveBeenCalledWith('user-1', 'workspace-1', null)
        expect(mocks.setAppSetting).toHaveBeenCalledWith(
            expect.stringContaining('offline_readiness:v1:workspace-1:user-1'),
            expect.any(String)
        )
    })

    it('reports a non-destructive failure when the full pull is incomplete', async () => {
        mocks.runManagedFullSync.mockResolvedValue({
            success: false,
            pushed: 0,
            pulled: 2,
            errors: ['products unavailable']
        })

        await expect(prepareForOfflineUse({ user, dataMode: 'hybrid' })).rejects.toMatchObject({
            code: 'data-sync-failed'
        })
        expect(mocks.preparePwaOfflineShell).not.toHaveBeenCalled()
        expect(mocks.setAppSetting).not.toHaveBeenCalled()
    })

    it('verifies OPFS SQLite in local mode without cloud authentication or sync', async () => {
        const localUser = { ...user, workspaceMode: 'local' as const }
        await expect(prepareForOfflineUse({ user: localUser, dataMode: 'local' })).resolves.toMatchObject({
            outcome: 'ready'
        })

        expect(mocks.runManagedFullSync).not.toHaveBeenCalled()
        expect(mocks.checkPwaSqliteReadiness).toHaveBeenCalledWith({
            workspaceId: 'workspace-1',
            userId: 'user-1'
        })
    })

    it('keeps readiness unrecorded when the complete shell cannot be verified', async () => {
        mocks.preparePwaOfflineShell.mockResolvedValue({ ready: false, status: 'failed' })

        await expect(prepareForOfflineUse({ user, dataMode: 'hybrid' })).rejects.toBeInstanceOf(OfflinePreparationError)
        expect(mocks.setAppSetting).not.toHaveBeenCalled()
    })

    it('requires the readiness record to match the active shell build', async () => {
        mocks.getAppSetting.mockResolvedValue(JSON.stringify({
            version: 1,
            userId: 'user-1',
            workspaceId: 'workspace-1',
            dataMode: 'hybrid',
            preparedAt: '2026-09-08T00:00:00.000Z',
            dataSyncedAt: '2026-09-08T00:00:00.000Z',
            shellBuildId: 'older-build',
            cachedAssets: 20,
            storagePersisted: true,
            storageUsage: 1,
            storageQuota: 2
        }))

        await expect(getOfflineReadinessSnapshot(user, 'hybrid')).resolves.toMatchObject({ ready: false })
    })

    it('accepts a matching legacy readiness record without requiring an offline lease', async () => {
        mocks.getAppSetting.mockResolvedValue(JSON.stringify({
            version: 1,
            userId: 'user-1',
            workspaceId: 'workspace-1',
            dataMode: 'hybrid',
            preparedAt: '2026-09-08T00:00:00.000Z',
            dataSyncedAt: '2026-09-08T00:00:00.000Z',
            shellBuildId: 'build-1',
            cachedAssets: 30,
            storagePersisted: true,
            storageUsage: 1,
            storageQuota: 2,
            offlineLeaseExpiresAt: 1
        }))

        await expect(getOfflineReadinessSnapshot(user, 'hybrid')).resolves.toMatchObject({ ready: true })
    })
})
