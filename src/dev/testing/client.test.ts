import { afterEach, describe, expect, it, vi } from 'vitest'
import { runnerErrorKey, testRunnerClient } from './client'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('developer runner client', () => {
    it('sends only suite options and the per-session token, then handles the resulting run', async () => {
        const run = { id: 'run', status: 'running' }
        const fetch = vi.fn(async () => new Response(JSON.stringify(run)))
        vi.stubGlobal('fetch', fetch)
        const options = { suiteId: 'sale-orders', groupIds: ['matrix'], seed: 42, samples: 3 }
        expect(await testRunnerClient.start('session-token', options)).toEqual(run)
        expect(fetch).toHaveBeenCalledWith('/__atlas-dev-testing/runs', expect.objectContaining({
            method: 'POST', credentials: 'omit', cache: 'no-store', body: JSON.stringify(options),
            headers: { 'X-Atlas-Test-Token': 'session-token', 'Content-Type': 'application/json' }
        }))
    })

    it('reattaches to an existing session and reads its latest run', async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'token', suites: {}, run: { id: 'run' } })))
            .mockResolvedValueOnce(new Response('null'))
        vi.stubGlobal('fetch', fetch)
        const session = await testRunnerClient.session()
        expect(session.run?.id).toBe('run')
        expect(await testRunnerClient.run(session.token)).toBeNull()
    })

    it.each(['run_busy', 'local_only', 'invalid_session'])('maps %s to a localized, friendly failure', async (error) => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error }), { status: 403 }))
        await expect(testRunnerClient.start('token', { suiteId: 'sale-orders', groupIds: ['matrix'], seed: 0, samples: 1 })).rejects.toThrow(error)
        expect(runnerErrorKey(new Error(error))).toBe(`devTesting.errors.${error}`)
    })

    it('does not show an arbitrary backend diagnostic as a user-facing error', async () => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'internal secret details' }), { status: 500 }))
        await expect(testRunnerClient.session()).rejects.toThrow('unavailable')
        expect(runnerErrorKey(new Error('internal secret details'))).toBe('devTesting.errors.unavailable')
    })

    it('cancels a run by identity without changing any workspace data', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'run', cancelRequested: true })))
        vi.stubGlobal('fetch', fetch)
        expect((await testRunnerClient.cancel('token', 'run')).cancelRequested).toBe(true)
        expect(fetch).toHaveBeenCalledWith('/__atlas-dev-testing/cancel', expect.objectContaining({ method: 'POST', body: '{"id":"run"}' }))
    })

    it('times out a stalled request and allows the modal to reconnect', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', (_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
        }))
        const pending = testRunnerClient.session()
        const rejection = expect(pending).rejects.toThrow('aborted')
        await vi.advanceTimersByTimeAsync(10_000)
        await rejection
    })
})
