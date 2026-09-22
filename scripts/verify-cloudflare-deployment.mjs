import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const workerOrigin = process.env.ATLAS_WORKER_ORIGIN ?? 'https://atlas.alanepic360.workers.dev'
const apiPath = '/api-workspace-data/profiles?select=id&limit=1'
const requiredAnonKey = process.env.SUPABASE_ANON_KEY
const maximumReadinessAttempts = 15
const readinessRetryDelayMs = 2_000
const releasePath = '/pwa-release.json'

function failure(message) {
    console.error(`[cf:verify] ${message}`)
    process.exit(1)
}

async function request(headers = {}) {
    const response = await fetch(new URL(apiPath, workerOrigin), {
        headers,
        redirect: 'error',
    })
    return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: await response.text(),
    }
}

function assertJsonApiResponse(label, response) {
    if (!response.contentType.includes('application/json')) {
        failure(`${label} returned ${response.status} with a non-JSON response. The API gateway may have been replaced by static assets.`)
    }
    if (/<!doctype|<html/i.test(response.body)) {
        failure(`${label} returned an HTML fallback instead of an API response.`)
    }
    if (/Missing required Worker secret/i.test(response.body)) {
        failure(`${label} reports a missing required Worker secret.`)
    }
}

export function isStaticFallback(response) {
    return response.status === 200 && (
        !response.contentType.includes('application/json') || /<!doctype|<html/i.test(response.body)
    )
}

export async function waitForApiGateway(requestApi, {
    attempts = maximumReadinessAttempts,
    delayMs = readinessRetryDelayMs,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onRetry = () => {},
} = {}) {
    let response

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        response = await requestApi()
        if (!isStaticFallback(response) || attempt === attempts) return response

        onRetry(attempt, attempts, delayMs)
        await sleep(delayMs)
    }

    return response
}

export function validatePwaRelease(value) {
    if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return false
    if (!/^sha256-[a-f0-9]{64}$/i.test(value.buildId || '')) return false
    if (!Array.isArray(value.assets) || value.assets.length === 0) return false
    return value.assets.every((asset) => (
        typeof asset?.url === 'string'
        && asset.url.startsWith('/')
        && Number.isSafeInteger(asset.bytes)
        && asset.bytes >= 0
        && /^[a-f0-9]{64}$/i.test(asset.sha256 || '')
    ))
}

export async function verifyPwaRelease(fetchImpl, origin, expectedRelease) {
    const response = await fetchImpl(new URL(releasePath, origin), {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`PWA release descriptor returned ${response.status}`)
    if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('PWA release descriptor did not return JSON')
    }
    if (!response.headers.get('cache-control')?.includes('no-store')) {
        throw new Error('PWA release descriptor is missing Cache-Control: no-store')
    }
    const release = await response.json()
    if (!validatePwaRelease(release)) throw new Error('PWA release descriptor is invalid')
    if (expectedRelease?.buildId && release.buildId !== expectedRelease.buildId) {
        throw new Error(`PWA release build mismatch: deployed ${release.buildId}, expected ${expectedRelease.buildId}`)
    }

    const failures = []
    let nextIndex = 0
    async function verifyNextAsset() {
        while (true) {
            const index = nextIndex++
            if (index >= release.assets.length) return
            const asset = release.assets[index]
            const assetResponse = await fetchImpl(new URL(asset.url, origin), {
                method: 'HEAD',
                cache: 'no-store',
            })
            if (!assetResponse.ok) failures.push(`${asset.url} (${assetResponse.status})`)
        }
    }
    await Promise.all(Array.from({ length: Math.min(8, release.assets.length) }, () => verifyNextAsset()))
    if (failures.length > 0) throw new Error(`PWA release has unavailable assets: ${failures.join(', ')}`)
    return release
}

async function main() {
    if (!requiredAnonKey?.trim()) {
        failure('SUPABASE_ANON_KEY is required to verify the Worker runtime bindings.')
    }

    try {
        // A just-deployed edge location can briefly serve the previous SPA-only
        // version. Retry that specific transitional response, but do not hide
        // API, secret, or authentication failures once JSON is available.
        const anonymous = await waitForApiGateway(request, {
            onRetry(attempt, attempts, delayMs) {
                console.log(`[cf:verify] API route is still serving static assets; retrying in ${delayMs / 1_000}s (${attempt}/${attempts - 1}).`)
            },
        })
        assertJsonApiResponse('Unauthenticated API check', anonymous)
        if (anonymous.status !== 401) {
            failure(`Unauthenticated API check returned ${anonymous.status}; expected 401.`)
        }

        const localReleasePath = path.resolve(process.cwd(), 'dist', 'pwa-release.json')
        if (!existsSync(localReleasePath)) failure('The local build is missing dist/pwa-release.json.')
        const expectedRelease = JSON.parse(readFileSync(localReleasePath, 'utf8'))
        const deployedRelease = await verifyPwaRelease(fetch, workerOrigin, expectedRelease)

        // Supplying the public key forces the Worker to read its Supabase runtime
        // values while still using no user data or privileged credentials.
        const configured = await request({
            apikey: requiredAnonKey,
            authorization: `Bearer ${requiredAnonKey}`,
        })
        assertJsonApiResponse('Configured API check', configured)

        console.log(`[cf:verify] Worker API routing, runtime bindings, and PWA release ${deployedRelease.buildId} are present.`)
    } catch (error) {
        failure(error instanceof Error ? error.message : String(error))
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main()
}
