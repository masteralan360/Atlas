export const APP_MAINTENANCE_REALTIME_CHANNEL = 'atlas-app-maintenance-state'

function requestUrl(input: RequestInfo | URL, baseUrl: string) {
    try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
            return new URL(input.url)
        }
        return new URL(String(input), baseUrl)
    } catch {
        return null
    }
}

export function shouldBlockSupabaseRequest(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    supabaseUrl: string,
    isBlocking: () => boolean
) {
    if (!isBlocking()) return false

    const url = requestUrl(input, supabaseUrl)
    let base: URL
    try {
        base = new URL(supabaseUrl)
    } catch {
        return false
    }
    if (!url || url.origin !== base.origin) return false

    const basePath = base.pathname.replace(/\/+$/, '')
    const pathname = basePath && url.pathname.startsWith(`${basePath}/`)
        ? url.pathname.slice(basePath.length)
        : url.pathname
    if (pathname.startsWith('/auth/v1/')) return false

    const method = (init?.method ?? (
        typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET'
    )).toUpperCase()
    if (pathname === '/rest/v1/app_maintenance' && method === 'GET') return false

    return pathname.startsWith('/rest/v1/')
        || pathname.startsWith('/storage/v1/')
        || pathname.startsWith('/functions/v1/')
        || pathname.startsWith('/graphql/v1/')
        || pathname.startsWith('/realtime/v1/')
}

export function createMaintenanceAwareFetch(
    fetchImpl: typeof fetch,
    supabaseUrl: string,
    isBlocking: () => boolean
): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (shouldBlockSupabaseRequest(input, init, supabaseUrl, isBlocking)) {
            return new Response(JSON.stringify({
                code: 'APP_MAINTENANCE',
                message: 'The server is temporarily under maintenance.'
            }), {
                status: 503,
                statusText: 'Service Unavailable',
                headers: { 'Content-Type': 'application/json' }
            })
        }
        return fetchImpl(input, init)
    }) as typeof fetch
}

/** Covers direct Supabase HTTP requests as well as calls made by the client. */
export function installGlobalMaintenanceFetchGate(supabaseUrl: string, isBlocking: () => boolean) {
    const runtime = globalThis as typeof globalThis & { __atlasMaintenanceFetchInstalled?: boolean }
    if (runtime.__atlasMaintenanceFetchInstalled) return
    globalThis.fetch = createMaintenanceAwareFetch(globalThis.fetch.bind(globalThis), supabaseUrl, isBlocking)
    runtime.__atlasMaintenanceFetchInstalled = true
}

type ChannelLike = {
    topic?: string
    state?: string
    subscribe: (...args: any[]) => any
    unsubscribe: (...args: any[]) => Promise<unknown>
    send?: (...args: any[]) => Promise<unknown>
    httpSend?: (...args: any[]) => Promise<unknown>
}

type RealtimeClientLike = {
    channel: (name: string, options?: unknown) => ChannelLike
    getChannels: () => ChannelLike[]
    removeChannel: (channel: ChannelLike) => Promise<unknown>
}

type ChannelState = {
    isMaintenanceChannel: boolean
    subscribeArgs: any[] | null
    suspended: boolean
    removed: boolean
    unsubscribe: (...args: any[]) => Promise<unknown>
    subscribe: (...args: any[]) => any
}

export function installMaintenanceRealtimeGate(
    client: RealtimeClientLike,
    isBlocking: () => boolean
) {
    const channels = client as RealtimeClientLike
    const originalChannel = channels.channel.bind(channels)
    const originalRemoveChannel = channels.removeChannel.bind(channels)
    const channelStates = new WeakMap<ChannelLike, ChannelState>()
    const suspendedChannels = new Set<ChannelLike>()
    let reconcileTask: Promise<void> | null = null

    const getState = (channel: ChannelLike) => {
        let state = channelStates.get(channel)
        if (state) return state

        const subscribe = channel.subscribe.bind(channel)
        const unsubscribe = channel.unsubscribe.bind(channel)
        state = {
            isMaintenanceChannel: false,
            subscribeArgs: null,
            suspended: false,
            removed: false,
            subscribe,
            unsubscribe
        }
        channelStates.set(channel, state)

        channel.subscribe = ((...args: any[]) => {
            state!.subscribeArgs = args
            state!.removed = false
            if (isBlocking() && !state!.isMaintenanceChannel) {
                state!.suspended = true
                suspendedChannels.add(channel)
                return channel
            }
            state!.suspended = false
            suspendedChannels.delete(channel)
            return subscribe(...args)
        }) as ChannelLike['subscribe']

        if (channel.send) {
            const send = channel.send.bind(channel)
            channel.send = ((...args: any[]) => (
                isBlocking() && !state!.isMaintenanceChannel
                    ? Promise.resolve('error')
                    : send(...args)
            )) as ChannelLike['send']
        }
        if (channel.httpSend) {
            const httpSend = channel.httpSend.bind(channel)
            channel.httpSend = ((...args: any[]) => (
                isBlocking() && !state!.isMaintenanceChannel
                    ? Promise.resolve({ success: false, status: 503, error: 'Server maintenance is active.' })
                    : httpSend(...args)
            )) as ChannelLike['httpSend']
        }

        return state
    }

    channels.channel = ((name: string, options?: unknown) => {
        const channel = originalChannel(name, options)
        const state = getState(channel)
        state.isMaintenanceChannel = name === APP_MAINTENANCE_REALTIME_CHANNEL
        return channel
    }) as RealtimeClientLike['channel']

    channels.removeChannel = (async (channel: ChannelLike) => {
        const state = channelStates.get(channel)
        if (state) {
            state.removed = true
            state.suspended = false
            suspendedChannels.delete(channel)
        }
        return originalRemoveChannel(channel)
    }) as RealtimeClientLike['removeChannel']

    const reconcile = () => {
        if (reconcileTask) return reconcileTask
        reconcileTask = (async () => {
            while (true) {
                const shouldSuspend = isBlocking()
                if (shouldSuspend) {
                    const pauseTasks = channels.getChannels().map(async (channel) => {
                        const state = getState(channel)
                        if (state.isMaintenanceChannel || state.removed || state.suspended || !state.subscribeArgs) return
                        state.suspended = true
                        suspendedChannels.add(channel)
                        await state.unsubscribe()
                    })
                    await Promise.allSettled(pauseTasks)
                } else {
                    const resumeTasks = [...suspendedChannels].map(async (channel) => {
                        const state = channelStates.get(channel)
                        if (!state || state.removed || state.isMaintenanceChannel || !state.subscribeArgs) {
                            suspendedChannels.delete(channel)
                            return
                        }
                        if (shouldSuspend || isBlocking()) return
                        state.suspended = false
                        suspendedChannels.delete(channel)
                        state.subscribe(...state.subscribeArgs)
                    })
                    await Promise.allSettled(resumeTasks)
                }

                if (shouldSuspend === isBlocking()) break
            }
        })().finally(() => {
            reconcileTask = null
            if (suspendedChannels.size > 0 && !isBlocking()) void reconcile()
        })
        return reconcileTask
    }

    return {
        createMaintenanceChannel(name = APP_MAINTENANCE_REALTIME_CHANNEL) {
            return channels.channel(name)
        },
        reconcile
    }
}
