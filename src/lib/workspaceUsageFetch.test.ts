import { beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
    activeWorkspaceId: null as string | null,
    localWorkspaceIds: new Set<string>()
}))

vi.mock('@/lib/network', () => ({
    getActiveBusinessUserId: () => null,
    getActiveBusinessWorkspaceId: () => testState.activeWorkspaceId
}))

vi.mock('@/workspace/workspaceMode', () => ({
    getWorkspaceDataMode: (workspaceId?: string | null) => (
        workspaceId && testState.localWorkspaceIds.has(workspaceId) ? 'local' : 'hybrid'
    ),
    isLocalWorkspaceMode: (workspaceId?: string | null) => Boolean(workspaceId && testState.localWorkspaceIds.has(workspaceId))
}))

import {
    createWorkspaceUsageFetch,
    workspaceUsageFetchInternals
} from './workspaceUsageFetch'

const workspaceId = '2f3c9c52-1d56-42d0-9643-a381f14bac6d'
const branchWorkspaceId = 'f33a3adc-5507-4f6a-9ee1-27e75d00bd21'
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

describe('workspace usage fetch metering', () => {
    beforeEach(() => {
        testState.activeWorkspaceId = null
        testState.localWorkspaceIds.clear()
    })

    it('extracts workspace filters from PostgREST URLs', () => {
        const url = new URL(`https://example.supabase.co/rest/v1/products?workspace_id=eq.${workspaceId}`)
        expect(workspaceUsageFetchInternals.extractWorkspaceIdsFromUrl(url, 'products')).toEqual([workspaceId])
    })

    it('classifies Storage object uploads and downloads without metering signing calls', () => {
        const upload = workspaceUsageFetchInternals.getStorageObjectTransfer(
            new URL(`https://example.supabase.co/storage/v1/object/voice/${workspaceId}/reason.flac`),
            'POST',
            'https://example.supabase.co'
        )
        const download = workspaceUsageFetchInternals.getStorageObjectTransfer(
            new URL(`https://example.supabase.co/storage/v1/object/auth/voice/${workspaceId}/reason.flac`),
            'GET',
            'https://example.supabase.co'
        )
        const sign = workspaceUsageFetchInternals.getStorageObjectTransfer(
            new URL(`https://example.supabase.co/storage/v1/object/sign/voice/${workspaceId}/reason.flac`),
            'POST',
            'https://example.supabase.co'
        )

        expect(upload).toMatchObject({
            direction: 'upload',
            bucketId: 'voice',
            objectPathSegments: [workspaceId, 'reason.flac']
        })
        expect(download).toMatchObject({
            direction: 'download',
            bucketId: 'voice',
            objectPathSegments: [workspaceId, 'reason.flac']
        })
        expect(sign).toBeNull()
    })

    it('counts authenticated Storage uploads and downloads against the active workspace', async () => {
        testState.activeWorkspaceId = workspaceId
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })
            if (String(input).includes('/rpc/record_workspace_data_transfer')) {
                return new Response(JSON.stringify({ success: true }), { status: 200 })
            }
            return new Response(String(input).includes('/object/auth/') ? 'fLaC' : JSON.stringify({ Key: 'voice/reason.flac' }), {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream' }
            })
        }) as unknown as typeof fetch
        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        await meteredFetch(`https://example.supabase.co/storage/v1/object/voice/${branchWorkspaceId}/reason.flac`, {
            method: 'POST',
            headers: { Authorization: 'Bearer token', 'Content-Type': 'audio/flac' },
            body: new Blob(['fLaC'])
        })
        await meteredFetch(`https://example.supabase.co/storage/v1/object/auth/voice/${branchWorkspaceId}/reason.flac`, {
            headers: { Authorization: 'Bearer token' }
        })

        expect(calls).toHaveLength(4)
        expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
            p_workspace_id: workspaceId,
            p_source: 'storage_upload:voice'
        })
        expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({
            p_workspace_id: workspaceId,
            p_source: 'storage_download:voice'
        })
    })

    it('routes Web Live Storage transfers through the server-side metering gateway', async () => {
        testState.activeWorkspaceId = workspaceId
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })
            return new Response('fLaC', { status: 200, headers: { 'Content-Type': 'audio/flac' } })
        }) as unknown as typeof fetch
        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            webStorageGatewayUrl: 'https://app.example.com/api-workspace-storage',
            fetchImpl
        })

        const response = await meteredFetch(
            `https://example.supabase.co/storage/v1/object/auth/voice/${workspaceId}/reason.flac`,
            { headers: { Authorization: 'Bearer token' } }
        )

        expect(response.ok).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe(
            `https://app.example.com/api-workspace-storage/object/auth/voice/${workspaceId}/reason.flac`
        )
    })

    it('counts GET table response bytes through the usage RPC', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })

            if (String(input).includes('/rpc/record_workspace_data_transfer')) {
                return new Response(JSON.stringify({ success: true }), { status: 200 })
            }

            return new Response(JSON.stringify([{ id: 'product-1' }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }) as unknown as typeof fetch

        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        const response = await meteredFetch(
            `https://example.supabase.co/rest/v1/products?workspace_id=eq.${workspaceId}`,
            {
                headers: {
                    Authorization: 'Bearer token'
                }
            }
        )

        expect(response.ok).toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(2)

        const usageCall = calls[1]
        expect(usageCall.url).toBe('https://example.supabase.co/rest/v1/rpc/record_workspace_data_transfer')
        expect(JSON.parse(String(usageCall.init?.body))).toMatchObject({
            p_workspace_id: workspaceId,
            p_source: 'table_fetch:products'
        })
        expect(new Headers(usageCall.init?.headers).get('Prefer')).toBe('return=minimal')
        expect(JSON.parse(String(usageCall.init?.body)).p_bytes).toBeGreaterThan(0)
    })

    it('routes Web Live table requests through the gateway without a client-side usage RPC', async () => {
        testState.activeWorkspaceId = workspaceId
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })
            return new Response(JSON.stringify([{ id: 'product-1' }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }) as unknown as typeof fetch

        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            webGatewayUrl: 'https://app.example.com/api-workspace-data',
            fetchImpl
        })

        const response = await meteredFetch(
            `https://example.supabase.co/rest/v1/products?workspace_id=eq.${workspaceId}&select=id`,
            { headers: { Authorization: 'Bearer token' } }
        )

        expect(response.ok).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe(
            `https://app.example.com/api-workspace-data/products?workspace_id=eq.${workspaceId}&select=id`
        )
        expect(calls[0].init?.headers).toBeInstanceOf(Headers)
        expect((calls[0].init?.headers as Headers).get('Authorization')).toBe('Bearer token')
    })

    it('keeps explicitly skipped auth bootstrap reads off the Web Live gateway', async () => {
        testState.activeWorkspaceId = workspaceId
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })
            return new Response(JSON.stringify([{ id: 'profile-1' }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }) as unknown as typeof fetch
        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            webGatewayUrl: 'https://app.example.com/api-workspace-data',
            fetchImpl
        })

        await meteredFetch('https://example.supabase.co/rest/v1/profiles?id=eq.profile-1', {
            headers: {
                Authorization: 'Bearer token',
                'X-Workspace-Usage-Skip': '1'
            }
        })

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://example.supabase.co/rest/v1/profiles?id=eq.profile-1')
        expect(new Headers(calls[0].init?.headers).has('X-Workspace-Usage-Skip')).toBe(false)
    })

    it('sends successful table-write bytes for server-side charging', async () => {
        testState.activeWorkspaceId = workspaceId
        const requestBody = JSON.stringify([
            { workspace_id: workspaceId, name: 'Coffee' },
            { workspace_id: workspaceId, name: 'قهوة' }
        ])
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })

            if (String(input).includes('/rpc/record_workspace_data_transfer')) {
                return new Response(JSON.stringify({ success: true }), { status: 200 })
            }

            return new Response(null, { status: 204 })
        }) as unknown as typeof fetch

        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        const response = await meteredFetch(
            'https://example.supabase.co/rest/v1/products?on_conflict=id',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer token',
                    'Content-Type': 'application/json'
                },
                body: requestBody
            }
        )

        expect(response.ok).toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
            p_workspace_id: workspaceId,
            p_bytes: byteLength(requestBody),
            p_source: 'table_write:products'
        })
    })

    it('counts business RPC request and response bytes together', async () => {
        testState.activeWorkspaceId = workspaceId
        const requestBody = JSON.stringify({
            payload: {
                workspace_id: workspaceId,
                note: 'Paid in full'
            }
        })
        const responseBody = JSON.stringify({ id: 'sale-1', status: 'completed' })
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })

            if (String(input).includes('/rpc/record_workspace_data_transfer')) {
                return new Response(JSON.stringify({ success: true }), { status: 200 })
            }

            return new Response(responseBody, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }) as unknown as typeof fetch

        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        const response = await meteredFetch(
            'https://example.supabase.co/rest/v1/rpc/complete_sale',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer token',
                    'Content-Type': 'application/json'
                },
                body: requestBody
            }
        )

        expect(response.ok).toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
            p_workspace_id: workspaceId,
            p_bytes: byteLength(requestBody) + byteLength(responseBody),
            p_source: 'rpc_transfer:complete_sale'
        })
    })

    it('measures a Request object body without consuming the original request', async () => {
        testState.activeWorkspaceId = workspaceId
        const requestBody = JSON.stringify({ name: 'Updated product' })
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })

            if (String(input).includes('/rpc/record_workspace_data_transfer')) {
                return new Response(JSON.stringify({ success: true }), { status: 200 })
            }

            expect(input).toBeInstanceOf(Request)
            expect((input as Request).bodyUsed).toBe(false)
            return new Response(null, { status: 204 })
        }) as unknown as typeof fetch

        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })
        const request = new Request('https://example.supabase.co/rest/v1/products?id=eq.product-1', {
            method: 'PATCH',
            headers: {
                Authorization: 'Bearer token',
                'Content-Type': 'application/json'
            },
            body: requestBody
        })

        const response = await meteredFetch(request)

        expect(response.ok).toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
            p_workspace_id: workspaceId,
            p_bytes: byteLength(requestBody),
            p_source: 'table_write:products'
        })
    })

    it('counts branch metadata reads against the active workspace', async () => {
        testState.activeWorkspaceId = workspaceId

        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init })

            if (String(input).includes('/rpc/record_workspace_data_transfer')) {
                return new Response(JSON.stringify({ success: true }), { status: 200 })
            }

            return new Response(JSON.stringify([{ id: branchWorkspaceId, name: 'Branch' }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }) as unknown as typeof fetch

        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        const response = await meteredFetch(
            `https://example.supabase.co/rest/v1/workspaces?id=in.(${branchWorkspaceId})`,
            {
                headers: {
                    Authorization: 'Bearer token'
                }
            }
        )

        expect(response.ok).toBe(true)
        expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
            p_workspace_id: workspaceId,
            p_source: 'table_fetch:workspaces'
        })
    })

    it('does not fail the original table fetch when usage recording fails for a non-limit reason', async () => {
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes('/rpc/record_workspace_data_transfer')) {
                return new Response(JSON.stringify({ message: 'Workspace access denied' }), { status: 400 })
            }

            return new Response(JSON.stringify([{ id: 'branch-1' }]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }) as unknown as typeof fetch

        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        const response = await meteredFetch(
            `https://example.supabase.co/rest/v1/workspaces?id=eq.${branchWorkspaceId}`,
            {
                headers: {
                    Authorization: 'Bearer token'
                }
            }
        )

        expect(response.ok).toBe(true)
        await expect(response.json()).resolves.toEqual([{ id: 'branch-1' }])
    })

    it('does not count failed table writes', async () => {
        testState.activeWorkspaceId = workspaceId
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid row' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        })) as unknown as typeof fetch
        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        const response = await meteredFetch('https://example.supabase.co/rest/v1/products', {
            method: 'POST',
            headers: { Authorization: 'Bearer token' },
            body: JSON.stringify({ workspace_id: workspaceId, name: 'Invalid product' })
        })

        expect(response.status).toBe(400)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('does not count internal usage RPCs or explicitly skipped requests', async () => {
        testState.activeWorkspaceId = workspaceId
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch
        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        await meteredFetch(`https://example.supabase.co/rest/v1/rpc/get_workspace_usage_status`, {
            method: 'POST',
            headers: { Authorization: 'Bearer token' }
        })
        await meteredFetch(`https://example.supabase.co/rest/v1/rpc/get_workspace_payg_summary`, {
            method: 'POST',
            headers: { Authorization: 'Bearer token' }
        })
        await meteredFetch(`https://example.supabase.co/rest/v1/rpc/record_workspace_data_transfer`, {
            method: 'POST',
            headers: { Authorization: 'Bearer token' },
            body: JSON.stringify({
                p_workspace_id: workspaceId,
                p_bytes: 128,
                p_source: 'test'
            })
        })
        await meteredFetch(`https://example.supabase.co/rest/v1/rpc/get_workspace_payment_summary`, {
            method: 'POST',
            headers: { Authorization: 'Bearer token' }
        })
        await meteredFetch(`https://example.supabase.co/rest/v1/rpc/submit_workspace_payment`, {
            method: 'POST',
            headers: { Authorization: 'Bearer token' },
            body: JSON.stringify({ p_provider: 'fib' })
        })
        await meteredFetch(`https://example.supabase.co/rest/v1/rpc/complete_sale`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer token',
                'X-Workspace-Usage-Skip': '1'
            },
            body: JSON.stringify({ payload: { workspace_id: workspaceId } })
        })

        expect(fetchImpl).toHaveBeenCalledTimes(6)
    })

    it('does not count table or RPC transfers for local workspaces', async () => {
        testState.activeWorkspaceId = workspaceId
        testState.localWorkspaceIds.add(workspaceId)
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch
        const meteredFetch = createWorkspaceUsageFetch({
            supabaseUrl: 'https://example.supabase.co',
            supabaseAnonKey: 'anon-key',
            fetchImpl
        })

        await meteredFetch(`https://example.supabase.co/rest/v1/products?workspace_id=eq.${workspaceId}`, {
            headers: { Authorization: 'Bearer token' }
        })
        await meteredFetch(`https://example.supabase.co/rest/v1/rpc/complete_sale`, {
            method: 'POST',
            headers: { Authorization: 'Bearer token' },
            body: JSON.stringify({ payload: { workspace_id: workspaceId } })
        })

        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
})
