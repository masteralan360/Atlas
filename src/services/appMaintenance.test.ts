import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    createChannel: vi.fn(),
    from: vi.fn(),
    removeChannel: vi.fn(),
    notifyAvailability: vi.fn()
}))

vi.mock('@/auth/supabase', () => ({
    isSupabaseConfigured: true,
    supabase: {
        from: mocks.from,
        removeChannel: mocks.removeChannel
    },
    createAppMaintenanceRealtimeChannel: mocks.createChannel
}))

vi.mock('@/lib/connectionManager', () => ({
    connectionManager: {
        notifyMaintenanceAvailabilityChanged: mocks.notifyAvailability
    }
}))

vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: vi.fn((_label, action) => Promise.resolve(action()))
}))

import {
    ensureAppMaintenanceMonitoring,
    stopAppMaintenanceMonitoring
} from './appMaintenance'
import {
    getAppMaintenanceSnapshot,
    isAppMaintenanceActive,
    isAppMaintenanceBlockingDataAccess
} from '@/lib/appMaintenanceState'
import {
    beginAppMaintenanceCheck,
    clearAppMaintenanceState,
    setAppMaintenanceStatus
} from '@/lib/appMaintenanceState'
import { isWorkspaceMaintenanceBlockingDataAccess } from '@/lib/appMaintenanceAccess'
import { getNetworkStatus, isOnline as isBusinessDataOnline, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

let channelHandler: ((payload: { new?: unknown }) => void) | null = null
let channel: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }
let queryResult: { data: { maintenance: boolean } | null; error: unknown }

function configureMocks() {
    channelHandler = null
    channel = {
        on: vi.fn((_type, _filter, handler) => {
            channelHandler = handler
            return channel
        }),
    subscribe: vi.fn((callback) => {
        callback?.('SUBSCRIBED')
        return channel
    })
    }
    queryResult = { data: { maintenance: false }, error: null }
    const maybeSingle = vi.fn(async () => queryResult)
    const setHeader = vi.fn(() => ({ maybeSingle }))
    const eq = vi.fn(() => ({ setHeader }))
    const select = vi.fn(() => ({ eq }))
    mocks.createChannel.mockReset().mockReturnValue(channel)
    mocks.from.mockReset().mockReturnValue({ select })
    mocks.removeChannel.mockReset().mockResolvedValue('ok')
    mocks.notifyAvailability.mockReset()
}

describe('app maintenance monitor', () => {
    beforeEach(() => {
        configureMocks()
        setNetworkStatus(true)
        setActiveBusinessWorkspace(null)
    })
    afterEach(() => {
        stopAppMaintenanceMonitoring()
        setActiveBusinessWorkspace(null)
    })

    it('does not inspect or subscribe for Local workspaces', () => {
        ensureAppMaintenanceMonitoring('local-workspace', 'local')

        expect(mocks.from).not.toHaveBeenCalled()
        expect(mocks.createChannel).not.toHaveBeenCalled()
        expect(isAppMaintenanceBlockingDataAccess('local-workspace')).toBe(false)
        writeWorkspaceModeSnapshot({ workspaceId: 'local-workspace', dataMode: 'local' })
        setActiveBusinessWorkspace('local-workspace')
        expect(getNetworkStatus()).toBe(true)
        expect(getAppMaintenanceSnapshot()).toMatchObject({ eligible: false, active: false, checking: false })
    })

    it('does not block a Local workspace even if stale maintenance state exists for it', () => {
        writeWorkspaceModeSnapshot({ workspaceId: 'local-workspace', dataMode: 'local' })
        beginAppMaintenanceCheck('local-workspace', true)
        setAppMaintenanceStatus('local-workspace', true)
        setActiveBusinessWorkspace('local-workspace')

        expect(isWorkspaceMaintenanceBlockingDataAccess('local-workspace')).toBe(false)
        expect(getNetworkStatus()).toBe(true)
        clearAppMaintenanceState()
    })

    it.each(['cloud', 'hybrid'] as const)('checks, subscribes, and follows Realtime for %s workspaces', async (dataMode) => {
        queryResult = { data: { maintenance: true }, error: null }
        ensureAppMaintenanceMonitoring(`${dataMode}-workspace`, dataMode)

        expect(isAppMaintenanceBlockingDataAccess(`${dataMode}-workspace`)).toBe(true)
        expect(channel.subscribe).toHaveBeenCalledTimes(1)
        expect(mocks.from).toHaveBeenCalledWith('app_maintenance')
        expect(channel.on).toHaveBeenCalledWith('postgres_changes', expect.objectContaining({
            event: '*', schema: 'public', table: 'app_maintenance'
        }), expect.any(Function))

        await Promise.resolve()
        await Promise.resolve()
        expect(isAppMaintenanceActive(`${dataMode}-workspace`)).toBe(true)
        expect(isWorkspaceMaintenanceBlockingDataAccess('another-cloud-workspace')).toBe(true)
        expect(isBusinessDataOnline(`${dataMode}-workspace`)).toBe(false)
        expect(getNetworkStatus()).toBe(false)

        channelHandler?.({ new: { maintenance: false } })
        expect(isAppMaintenanceActive(`${dataMode}-workspace`)).toBe(false)
        expect(isAppMaintenanceBlockingDataAccess(`${dataMode}-workspace`)).toBe(false)
        expect(getNetworkStatus()).toBe(true)
    })

    it('keeps the startup gate closed and retries when the state read fails', async () => {
        queryResult = { data: null, error: new Error('temporary read failure') }
        ensureAppMaintenanceMonitoring('cloud-workspace', 'cloud')
        ensureAppMaintenanceMonitoring('cloud-workspace', 'cloud')
        expect(mocks.createChannel).toHaveBeenCalledTimes(1)

        await Promise.resolve()
        await Promise.resolve()
        expect(isAppMaintenanceBlockingDataAccess('cloud-workspace')).toBe(true)
        expect(isAppMaintenanceActive('cloud-workspace')).toBe(false)
        expect(getAppMaintenanceSnapshot()).toMatchObject({ checking: true, eligible: true })
    })

    it('replaces the old workspace listener and never leaves the previous workspace blocked', () => {
        ensureAppMaintenanceMonitoring('cloud-workspace', 'cloud')
        ensureAppMaintenanceMonitoring('hybrid-workspace', 'hybrid')

        expect(mocks.removeChannel).toHaveBeenCalledWith(channel)
        expect(isAppMaintenanceBlockingDataAccess('cloud-workspace')).toBe(false)
        expect(isAppMaintenanceBlockingDataAccess('hybrid-workspace')).toBe(true)
        expect(mocks.createChannel).toHaveBeenCalledTimes(2)
    })
})
