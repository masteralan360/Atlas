import { describe, expect, it, vi } from 'vitest'
import { isStaticFallback, validatePwaRelease, verifyPwaRelease, waitForApiGateway } from './verify-cloudflare-deployment.mjs'

const staticFallback = {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><body>Atlas</body></html>',
}

const apiResponse = {
    status: 401,
    contentType: 'application/json; charset=utf-8',
    body: '{"error":"Workspace authentication is required"}',
}

describe('Cloudflare deployment verification', () => {
    it('recognizes the temporary SPA fallback returned before the Worker API is ready', () => {
        expect(isStaticFallback(staticFallback)).toBe(true)
        expect(isStaticFallback(apiResponse)).toBe(false)
    })

    it('retries a temporary static response until the Worker API returns JSON', async () => {
        const requestApi = vi.fn()
            .mockResolvedValueOnce(staticFallback)
            .mockResolvedValueOnce(apiResponse)
        const sleep = vi.fn().mockResolvedValue(undefined)
        const onRetry = vi.fn()

        await expect(waitForApiGateway(requestApi, {
            attempts: 3,
            delayMs: 1,
            sleep,
            onRetry,
        })).resolves.toEqual(apiResponse)

        expect(requestApi).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalledWith(1)
        expect(onRetry).toHaveBeenCalledWith(1, 3, 1)
    })

    it('keeps the static response as a failure after the bounded retry window', async () => {
        const requestApi = vi.fn().mockResolvedValue(staticFallback)
        const sleep = vi.fn().mockResolvedValue(undefined)

        await expect(waitForApiGateway(requestApi, {
            attempts: 3,
            delayMs: 1,
            sleep,
        })).resolves.toEqual(staticFallback)

        expect(requestApi).toHaveBeenCalledTimes(3)
        expect(sleep).toHaveBeenCalledTimes(2)
    })

    it('verifies the deployed build ID and every declared PWA asset', async () => {
        const release = {
            schemaVersion: 1,
            buildId: `sha256-${'a'.repeat(64)}`,
            assets: [
                { url: '/', bytes: 10, sha256: 'b'.repeat(64) },
                { url: '/assets/app.js', bytes: 20, sha256: 'c'.repeat(64) },
            ],
        }
        const fetchImpl = vi.fn(async (input, init = {}) => {
            const url = new URL(input)
            if (url.pathname === '/pwa-release.json') {
                return Response.json(release, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
            }
            expect(init.method).toBe('HEAD')
            return new Response(null, { status: 200 })
        })

        expect(validatePwaRelease(release)).toBe(true)
        await expect(verifyPwaRelease(fetchImpl, 'https://atlas.example', release)).resolves.toEqual(release)
        expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('rejects a release descriptor that points to a different deployment', async () => {
        const deployed = {
            schemaVersion: 1,
            buildId: `sha256-${'a'.repeat(64)}`,
            assets: [{ url: '/', bytes: 10, sha256: 'b'.repeat(64) }],
        }
        const fetchImpl = vi.fn(async () => Response.json(deployed, {
            headers: { 'Cache-Control': 'no-store' },
        }))

        await expect(verifyPwaRelease(fetchImpl, 'https://atlas.example', {
            buildId: `sha256-${'c'.repeat(64)}`,
        })).rejects.toThrow('build mismatch')
    })
})
