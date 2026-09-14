import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    downloadWorkspaceResources: vi.fn(),
    isLocalWorkspaceMode: vi.fn(() => false),
    isTauri: vi.fn(() => true)
}))

vi.mock('./platform', () => ({
    isTauri: mocks.isTauri
}))

vi.mock('@/services/platformService', () => ({
    platformService: {}
}))

vi.mock('@/services/r2Service', () => ({
    r2Service: {}
}))

vi.mock('@/local-db', () => ({
    db: {}
}))

vi.mock('@/auth/supabase', () => ({
    supabase: {}
}))

vi.mock('@/workspace/workspaceMode', () => ({
    isLocalWorkspaceMode: mocks.isLocalWorkspaceMode
}))

vi.mock('@/lib/workspaceResourceSync', () => ({
    downloadWorkspaceResources: mocks.downloadWorkspaceResources
}))

import { AssetManager } from './assetManager'

describe('AssetManager Local Mode startup', () => {
    beforeEach(() => {
        mocks.downloadWorkspaceResources.mockReset()
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
            expect(manager.getProgress().isInitialSync).toBe(false)
        }
    )

    it('immediately dismisses the overlay when force enter is requested', () => {
        mocks.downloadWorkspaceResources.mockReturnValue(new Promise(() => undefined))
        const manager = new AssetManager()
        vi.spyOn(manager, 'startWatcher').mockImplementation(() => undefined)

        manager.initialize('workspace-id', 'hybrid')
        expect(manager.getProgress().isInitialSync).toBe(true)

        manager.requestForceEnter()

        expect(manager.getProgress().isInitialSync).toBe(false)
    })
})
