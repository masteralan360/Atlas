import { describe, expect, it, vi } from 'vitest'
import {
    APP_MAINTENANCE_REALTIME_CHANNEL,
    createMaintenanceAwareFetch,
    installGlobalMaintenanceFetchGate,
    installMaintenanceRealtimeGate
} from './supabaseMaintenanceGate'

describe('maintenance Supabase traffic gate', () => {
    it('installs a global fetch gate for direct Supabase API calls', async () => {
        const runtime = globalThis as typeof globalThis & { __atlasMaintenanceFetchInstalled?: boolean }
        const originalFetch = globalThis.fetch
        const originalFlag = runtime.__atlasMaintenanceFetchInstalled
        const fetchMock = vi.fn(async () => new Response('ok')) as typeof fetch
        globalThis.fetch = fetchMock
        delete runtime.__atlasMaintenanceFetchInstalled
        try {
            installGlobalMaintenanceFetchGate('https://atlas.example', () => true)
            const response = await globalThis.fetch('https://atlas.example/functions/v1/register-device-token', { method: 'POST' })
            expect(response.status).toBe(503)
            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
            if (originalFlag === undefined) delete runtime.__atlasMaintenanceFetchInstalled
            else runtime.__atlasMaintenanceFetchInstalled = originalFlag
        }
    })

    it('blocks Supabase data and storage requests but keeps auth and maintenance reads available', async () => {
        let blocked = true
        const fetchImpl = vi.fn(async () => new Response('ok')) as typeof fetch
        const gatedFetch = createMaintenanceAwareFetch(fetchImpl, 'https://atlas.example', () => blocked)

        const dataResponse = await gatedFetch('https://atlas.example/rest/v1/products')
        const storageResponse = await gatedFetch('https://atlas.example/storage/v1/object/products/a.png')
        const functionResponse = await gatedFetch('https://atlas.example/functions/v1/register-device-token', { method: 'POST' })
        expect(dataResponse.status).toBe(503)
        expect(await dataResponse.json()).toMatchObject({ code: 'APP_MAINTENANCE' })
        expect(storageResponse.status).toBe(503)
        expect(functionResponse.status).toBe(503)
        expect(fetchImpl).not.toHaveBeenCalled()

        await gatedFetch('https://atlas.example/auth/v1/token?grant_type=refresh_token')
        await gatedFetch('https://atlas.example/rest/v1/app_maintenance?id=eq.true')
        await gatedFetch('https://atlas.example/rest/v1/app_maintenance?select=maintenance', { method: 'PATCH' })
        expect(fetchImpl).toHaveBeenCalledTimes(2)

        blocked = false
        await gatedFetch('https://atlas.example/rest/v1/products')
        expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('suspends normal channels, defers new subscriptions, and resumes each once', async () => {
        let blocked = false
        const channels: Array<any> = []
        const originalSubscribeMocks: Array<ReturnType<typeof vi.fn>> = []
        const client: any = {
            channel: vi.fn((name: string) => {
                const channel = {
                    topic: name,
                    state: 'closed',
                    subscribe: vi.fn((callback?: (status: string) => void) => {
                        channel.state = 'joined'
                        callback?.('SUBSCRIBED')
                        return channel
                    }),
                    unsubscribe: vi.fn(async () => {
                        channel.state = 'closed'
                        return 'ok'
                    }),
                    send: vi.fn(async () => 'ok'),
                    httpSend: vi.fn(async () => ({ success: true }))
                }
                originalSubscribeMocks.push(channel.subscribe)
                channels.push(channel)
                return channel
            }),
            getChannels: () => channels,
            removeChannel: vi.fn(async (channel: any) => {
                await channel.unsubscribe()
                return 'ok'
            })
        }
        const gate = installMaintenanceRealtimeGate(client, () => blocked)
        const normal = client.channel('normal-workspace-channel')
        normal.subscribe()
        expect(normal.state).toBe('joined')

        blocked = true
        await gate.reconcile()
        expect(normal.state).toBe('closed')
        expect(await normal.send({ type: 'broadcast', event: 'update' })).toBe('error')

        const newNormal = client.channel('created-during-maintenance')
        newNormal.subscribe()
        expect(newNormal.state).toBe('closed')
        const maintenance = gate.createMaintenanceChannel()
        maintenance.subscribe()
        expect(maintenance.topic).toContain(APP_MAINTENANCE_REALTIME_CHANNEL)
        expect(maintenance.state).toBe('joined')
        expect(maintenance.unsubscribe).not.toHaveBeenCalled()

        blocked = false
        await gate.reconcile()
        expect(normal.state).toBe('joined')
        expect(originalSubscribeMocks[0]).toHaveBeenCalledTimes(2)
        expect(newNormal.state).toBe('joined')
        expect(originalSubscribeMocks[1]).toHaveBeenCalledTimes(1)
        expect(originalSubscribeMocks[2]).toHaveBeenCalledTimes(1)
    })

    it('does not resume a channel removed while maintenance is active', async () => {
        let blocked = false
        const channels: Array<any> = []
        let originalSubscribe: ReturnType<typeof vi.fn>
        const client: any = {
            channel: vi.fn((name: string) => {
                const channel = {
                    topic: name,
                    state: 'closed',
                    subscribe: vi.fn(() => { channel.state = 'joined'; return channel }),
                    unsubscribe: vi.fn(async () => { channel.state = 'closed'; return 'ok' })
                }
                originalSubscribe = channel.subscribe
                channels.push(channel)
                return channel
            }),
            getChannels: () => channels,
            removeChannel: vi.fn(async (channel: any) => {
                await channel.unsubscribe()
                channels.splice(channels.indexOf(channel), 1)
                return 'ok'
            })
        }
        const gate = installMaintenanceRealtimeGate(client, () => blocked)
        const channel = client.channel('temporary-channel')
        channel.subscribe()
        blocked = true
        await gate.reconcile()
        await client.removeChannel(channel)
        blocked = false
        await gate.reconcile()

        expect(originalSubscribe!).toHaveBeenCalledTimes(1)
    })
})
