import { getActiveBusinessWorkspaceId } from '@/lib/network'
import { recordNetworkError } from '@/lib/errorLogger'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

// Legacy backend message: this limit is enforced against CHARGED usage, even
// though the stable wire text still says "data transfer".
const WORKSPACE_TRANSFER_LIMIT_MESSAGE = 'Workspace monthly data transfer limit exceeded'
const WORKSPACE_USAGE_UPDATED_EVENT = 'workspace-usage-updated'
// Used only for the small, RLS-protected reads that establish an authenticated
// user's workspace. Routing those reads through the usage gateway would create
// a dependency loop: the gateway itself must first resolve that workspace.
export const WORKSPACE_USAGE_SKIP_HEADER = 'X-Workspace-Usage-Skip'
const MAX_NETWORK_ERROR_BODY_LENGTH = 32_768
const TABLE_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const RPC_METHODS = new Set(['GET', 'POST'])
const UNMETERED_RPC_NAMES = new Set([
    'get_workspace_usage_status',
    'get_workspace_payg_summary',
    'get_current_workspace_usage_access',
    'record_workspace_data_transfer',
    // Renewal must remain reachable after charged usage is exhausted. Metering
    // either call could replace a successful payment response with a quota error.
    'get_workspace_payment_summary',
    'submit_workspace_payment'
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WORKSPACE_FILTER_KEYS = [
    'workspace_id',
    'current_workspace',
    'branch_workspace_id',
    'source_workspace_id',
    'destination_workspace_id',
    'target_workspace_id'
]

type WorkspaceUsageFetchOptions = {
    supabaseUrl: string
    supabaseAnonKey: string
    /** Same-origin REST gateway used only by the Web Live build. */
    webGatewayUrl?: string
    /** Same-origin Storage gateway used only by the Web Live build. */
    webStorageGatewayUrl?: string
    fetchImpl?: typeof fetch
}

type NormalizedWorkspaceUsageFetchOptions = Omit<WorkspaceUsageFetchOptions, 'fetchImpl' | 'webGatewayUrl' | 'webStorageGatewayUrl'> & {
    fetchImpl: typeof fetch
    webGatewayUrl: string
    webStorageGatewayUrl: string
}

type UsageRecordResult = {
    ok: boolean
    limitExceeded?: boolean
    message?: string
}

type WorkspaceTransferContext = {
    workspaceId: string
    authHeader: string | null
    countRequestBody: boolean
    countResponseBody: boolean
    source: string
    gateway: 'rest' | 'storage'
}

type StorageObjectTransfer = {
    direction: 'upload' | 'download'
    bucketId: string
    objectPathSegments: string[]
}

function isUuid(value?: string | null): value is string {
    return UUID_PATTERN.test(value ?? '')
}

function notifyWorkspaceUsageUpdated(workspaceId: string) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(WORKSPACE_USAGE_UPDATED_EVENT, {
        detail: { workspaceId }
    }))
}

function getRequestUrl(input: RequestInfo | URL): URL | null {
    try {
        if (input instanceof Request) {
            return new URL(input.url)
        }

        return new URL(String(input))
    } catch {
        return null
    }
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
    return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
}

function getRequestEndpoint(input: RequestInfo | URL) {
    return getRequestUrl(input)?.pathname ?? 'unknown'
}

async function captureNetworkResponseError(
    response: Response,
    input: RequestInfo | URL,
    init?: RequestInit
) {
    let responseBody: unknown
    try {
        const rawBody = await response.clone().text()
        if (rawBody) {
            if (rawBody.length > MAX_NETWORK_ERROR_BODY_LENGTH) {
                responseBody = {
                    truncated: true,
                    preview: rawBody.slice(0, MAX_NETWORK_ERROR_BODY_LENGTH),
                }
            } else {
                try {
                    responseBody = JSON.parse(rawBody)
                } catch {
                    responseBody = rawBody
                }
            }
        }
    } catch {
        // A readable HTTP status is still useful when the body cannot be cloned.
    }

    recordNetworkError({
        method: getRequestMethod(input, init),
        endpoint: getRequestEndpoint(input),
        status: response.status,
        statusText: response.statusText || undefined,
        ...(responseBody !== undefined ? { responseBody } : {}),
    })
}

function getRequestHeaders(input: RequestInfo | URL, init?: RequestInit) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    }
    return headers
}

function getRestPathSegments(url: URL, supabaseUrl: string): string[] | null {
    let baseUrl: URL
    try {
        baseUrl = new URL(supabaseUrl)
    } catch {
        return null
    }

    if (url.origin !== baseUrl.origin) {
        return null
    }

    const basePath = baseUrl.pathname.replace(/\/+$/, '')
    const restPrefix = `${basePath}/rest/v1/`.replace(/\/{2,}/g, '/')
    if (!url.pathname.startsWith(restPrefix)) {
        return null
    }

    return url.pathname
        .slice(restPrefix.length)
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment))
}

function getStoragePathSegments(url: URL, supabaseUrl: string): string[] | null {
    let baseUrl: URL
    try {
        baseUrl = new URL(supabaseUrl)
    } catch {
        return null
    }

    if (url.origin !== baseUrl.origin) return null

    const basePath = baseUrl.pathname.replace(/\/+$/, '')
    const storagePrefix = `${basePath}/storage/v1/`.replace(/\/{2,}/g, '/')
    if (!url.pathname.startsWith(storagePrefix)) return null

    return url.pathname
        .slice(storagePrefix.length)
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment))
}

function getStorageObjectTransfer(url: URL, method: string, supabaseUrl: string): StorageObjectTransfer | null {
    const segments = getStoragePathSegments(url, supabaseUrl)
    if (!segments?.length) return null

    const isWrite = ['POST', 'PUT', 'PATCH'].includes(method)
    const isRead = method === 'GET'

    if (segments[0] === 'object') {
        const operation = segments[1]
        const namedObjectOperation = ['auth', 'public', 'sign'].includes(operation)
        const controlOperation = ['copy', 'info', 'list', 'move', 'rename', 'sign', 'upload'].includes(operation)
        const bucketIndex = namedObjectOperation ? 2 : 1
        const pathIndex = bucketIndex + 1
        const bucketId = segments[bucketIndex]
        const objectPathSegments = segments.slice(pathIndex)

        if (!bucketId || objectPathSegments.length === 0) return null
        if (isRead && (namedObjectOperation || !controlOperation)) {
            return { direction: 'download', bucketId, objectPathSegments }
        }
        if (isWrite && !controlOperation) {
            return { direction: 'upload', bucketId, objectPathSegments }
        }

        // A signed upload URL still transfers object bytes, even though its
        // route is nested below /object/upload/sign.
        if (isWrite && operation === 'upload' && segments[2] === 'sign' && segments[3]) {
            return {
                direction: 'upload',
                bucketId: segments[3],
                objectPathSegments: segments.slice(4)
            }
        }
    }

    if (
        isRead
        && segments[0] === 'render'
        && segments[1] === 'image'
        && ['auth', 'public', 'sign'].includes(segments[2])
        && segments[3]
        && segments.length > 4
    ) {
        return {
            direction: 'download',
            bucketId: segments[3],
            objectPathSegments: segments.slice(4)
        }
    }

    return null
}

function getRestTableName(url: URL, supabaseUrl: string): string | null {
    const segments = getRestPathSegments(url, supabaseUrl)
    const tableName = segments?.[0] ?? ''
    if (!tableName || tableName === 'rpc') {
        return null
    }

    return tableName
}

function getRestRpcName(url: URL, supabaseUrl: string): string | null {
    const segments = getRestPathSegments(url, supabaseUrl)
    if (segments?.[0] !== 'rpc') return null

    return segments[1] || null
}

function extractUuidFromPostgrestFilter(value: string): string[] {
    const matches = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)
    return matches?.filter(isUuid) ?? []
}

function extractWorkspaceIdsFromUrl(url: URL, tableName: string) {
    const ids = new Set<string>()

    for (const key of WORKSPACE_FILTER_KEYS) {
        for (const value of url.searchParams.getAll(key)) {
            extractUuidFromPostgrestFilter(value).forEach((workspaceId) => ids.add(workspaceId))
        }
    }

    if (tableName === 'workspaces') {
        for (const value of url.searchParams.getAll('id')) {
            extractUuidFromPostgrestFilter(value).forEach((workspaceId) => ids.add(workspaceId))
        }
    }

    return Array.from(ids)
}

function decodeBase64Url(value: string): string {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')

    if (typeof atob === 'function') {
        return atob(padded)
    }

    return Buffer.from(padded, 'base64').toString('utf8')
}

function readPath(source: unknown, path: string[]): unknown {
    let current = source
    for (const segment of path) {
        if (!current || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[segment]
    }
    return current
}

function getWorkspaceIdFromJwt(authHeader: string | null) {
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : ''
    const payloadSegment = token.split('.')[1]
    if (!payloadSegment) return null

    try {
        const payload = JSON.parse(decodeBase64Url(payloadSegment))
        const candidates = [
            readPath(payload, ['current_workspace']),
            readPath(payload, ['workspace_id']),
            readPath(payload, ['user_metadata', 'current_workspace']),
            readPath(payload, ['user_metadata', 'workspace_id']),
            readPath(payload, ['app_metadata', 'current_workspace']),
            readPath(payload, ['app_metadata', 'workspace_id'])
        ]

        const workspaceId = candidates.find((value): value is string => typeof value === 'string' && isUuid(value))
        return workspaceId ?? null
    } catch {
        return null
    }
}

function resolveWorkspaceId(url: URL, tableName: string, authHeader: string | null) {
    const activeWorkspaceId = getActiveBusinessWorkspaceId()
    const authenticatedWorkspaceId = isUuid(activeWorkspaceId)
        ? activeWorkspaceId
        : getWorkspaceIdFromJwt(authHeader)
    const urlWorkspaceIds = extractWorkspaceIdsFromUrl(url, tableName)

    if (authenticatedWorkspaceId) {
        return authenticatedWorkspaceId
    }

    return urlWorkspaceIds.length === 1 ? urlWorkspaceIds[0] : null
}

function resolveStorageWorkspaceId(
    url: URL,
    transfer: StorageObjectTransfer,
    authHeader: string | null
) {
    // Charge the authenticated/current workspace first. A path segment is
    // only a fallback for a caller whose workspace context is otherwise
    // unavailable; it must never let a client redirect a charge elsewhere.
    const authenticatedWorkspaceId = resolveWorkspaceId(url, 'storage', authHeader)
    if (authenticatedWorkspaceId) return authenticatedWorkspaceId

    const pathWorkspaceId = transfer.objectPathSegments[0]
    if (isUuid(pathWorkspaceId)) return pathWorkspaceId
    return null
}

function getWorkspaceTransferContext(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    supabaseUrl: string
): WorkspaceTransferContext | null {
    const url = getRequestUrl(input)
    if (!url) return null

    const headers = getRequestHeaders(input, init)
    if (headers.get(WORKSPACE_USAGE_SKIP_HEADER) === '1') return null

    const tableName = getRestTableName(url, supabaseUrl)
    const rpcName = getRestRpcName(url, supabaseUrl)
    const method = getRequestMethod(input, init)
    const storageTransfer = getStorageObjectTransfer(url, method, supabaseUrl)
    if (!tableName && !rpcName && !storageTransfer) return null
    if (rpcName && UNMETERED_RPC_NAMES.has(rpcName)) return null

    const isTableFetch = Boolean(tableName && method === 'GET')
    const isTableWrite = Boolean(tableName && TABLE_WRITE_METHODS.has(method))
    const isRpcTransfer = Boolean(rpcName && RPC_METHODS.has(method))
    if (!isTableFetch && !isTableWrite && !isRpcTransfer && !storageTransfer) return null

    const authHeader = headers.get('Authorization')
    const workspaceId = storageTransfer
        ? resolveStorageWorkspaceId(url, storageTransfer, authHeader)
        : resolveWorkspaceId(url, tableName ?? rpcName ?? '', authHeader)
    if (!workspaceId || isLocalWorkspaceMode(workspaceId)) return null

    return {
        workspaceId,
        authHeader,
        countRequestBody: Boolean(storageTransfer?.direction === 'upload') || isTableWrite || (isRpcTransfer && method !== 'GET'),
        countResponseBody: true,
        source: storageTransfer
            ? `storage_${storageTransfer.direction}:${storageTransfer.bucketId}`
            : isTableFetch
                ? `table_fetch:${tableName}`
                : isTableWrite
                    ? `table_write:${tableName}`
                    : `rpc_transfer:${rpcName}`,
        gateway: storageTransfer ? 'storage' : 'rest'
    }
}

function getKnownRequestBodyBytes(body: BodyInit): number | null {
    if (typeof body === 'string') {
        return new TextEncoder().encode(body).byteLength
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return new TextEncoder().encode(body.toString()).byteLength
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return body.size
    }

    if (body instanceof ArrayBuffer) {
        return body.byteLength
    }

    if (ArrayBuffer.isView(body)) {
        return body.byteLength
    }

    return null
}

async function getRequestTransferBytes(input: RequestInfo | URL, init?: RequestInit): Promise<number> {
    const contentLength = getRequestHeaders(input, init).get('Content-Length')
    const parsedLength = contentLength ? Number(contentLength) : NaN
    if (Number.isFinite(parsedLength) && parsedLength > 0) {
        return Math.trunc(parsedLength)
    }

    if (init?.body !== undefined && init.body !== null) {
        const knownBytes = getKnownRequestBodyBytes(init.body)
        if (knownBytes !== null) return knownBytes

        if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
            try {
                const request = new Request('https://workspace-usage.invalid', {
                    method: 'POST',
                    body: init.body
                })
                return (await request.arrayBuffer()).byteLength
            } catch {
                return 0
            }
        }

        return 0
    }

    if (input instanceof Request && input.body) {
        try {
            return (await input.clone().arrayBuffer()).byteLength
        } catch {
            return 0
        }
    }

    return 0
}

async function getResponseTransferBytes(response: Response): Promise<number> {
    const contentLength = response.headers.get('Content-Length')
    const parsedLength = contentLength ? Number(contentLength) : NaN
    if (Number.isFinite(parsedLength) && parsedLength > 0) {
        return Math.trunc(parsedLength)
    }

    try {
        const body = await response.clone().arrayBuffer()
        return body.byteLength
    } catch {
        return 0
    }
}

async function recordSupabaseDataTransfer(
    options: NormalizedWorkspaceUsageFetchOptions,
    workspaceId: string,
    actualBytes: number,
    authHeader: string | null,
    source: string
): Promise<UsageRecordResult> {
    if (!isUuid(workspaceId) || actualBytes <= 0 || !authHeader) {
        return { ok: true }
    }

    const response = await options.fetchImpl(`${options.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/record_workspace_data_transfer`, {
        method: 'POST',
        headers: {
            apikey: options.supabaseAnonKey,
            Authorization: authHeader,
            'Content-Type': 'application/json',
            // Charging is a side effect. Do not add an RPC response body to
            // every metered Tauri request.
            Prefer: 'return=minimal',
            [WORKSPACE_USAGE_SKIP_HEADER]: '1'
        },
        body: JSON.stringify({
            p_workspace_id: workspaceId,
            // p_bytes is measured only for this request. The database applies
            // the trusted Tauri channel rate and persists charged usage only.
            p_bytes: actualBytes,
            p_source: source,
            p_channel: 'tauri'
        })
    })

    if (response.ok) {
        notifyWorkspaceUsageUpdated(workspaceId)
        return { ok: true }
    }

    const message = await response.text().catch(() => '')
    return {
        ok: false,
        limitExceeded: message.includes(WORKSPACE_TRANSFER_LIMIT_MESSAGE),
        message
    }
}

function getGatewayUrl(
    input: RequestInfo | URL,
    supabaseUrl: string,
    webGatewayUrl: string,
    upstreamPrefix: '/rest/v1/' | '/storage/v1/'
): URL | null {
    const sourceUrl = getRequestUrl(input)
    if (!sourceUrl || !webGatewayUrl) return null

    let supabaseBase: URL
    let gatewayBase: URL
    try {
        supabaseBase = new URL(supabaseUrl)
        gatewayBase = new URL(
            webGatewayUrl,
            typeof window === 'undefined' ? undefined : window.location.origin
        )
    } catch {
        return null
    }

    const basePath = supabaseBase.pathname.replace(/\/+$/, '')
    const servicePrefix = `${basePath}${upstreamPrefix}`.replace(/\/{2,}/g, '/')
    if (!sourceUrl.pathname.startsWith(servicePrefix)) return null

    const servicePath = sourceUrl.pathname.slice(servicePrefix.length)
    if (!servicePath || servicePath.split('/').some((segment) => segment === '..')) return null

    gatewayBase.pathname = `${gatewayBase.pathname.replace(/\/+$/, '')}/${servicePath}`
    gatewayBase.search = sourceUrl.search
    return gatewayBase
}

function buildGatewayFetchArgs(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    gatewayUrl: URL
): { input: RequestInfo | URL; init?: RequestInit } {
    if (!(input instanceof Request)) {
        return {
            input: gatewayUrl.toString(),
            init: {
                ...init,
                headers: getRequestHeaders(input, init)
            }
        }
    }

    const original = init ? new Request(input, init) : input
    const method = original.method.toUpperCase()
    return {
        input: new Request(gatewayUrl, {
            method,
            headers: getRequestHeaders(input, init),
            body: method === 'GET' || method === 'HEAD' ? undefined : original.clone().body,
            cache: original.cache,
            credentials: original.credentials,
            integrity: original.integrity,
            keepalive: original.keepalive,
            mode: original.mode,
            redirect: original.redirect,
            referrer: original.referrer,
            referrerPolicy: original.referrerPolicy,
            signal: original.signal
        })
    }
}

function buildDirectFetchArgs(
    input: RequestInfo | URL,
    init: RequestInit | undefined
): { input: RequestInfo | URL; init?: RequestInit } {
    const headers = getRequestHeaders(input, init)
    if (headers.get(WORKSPACE_USAGE_SKIP_HEADER) !== '1') {
        return { input, init }
    }

    // The marker is for this in-app fetch wrapper only. Do not forward it to
    // Supabase: browser bootstrap reads should remain ordinary CORS requests.
    headers.delete(WORKSPACE_USAGE_SKIP_HEADER)

    if (!(input instanceof Request)) {
        return {
            input,
            init: {
                ...init,
                headers
            }
        }
    }

    const original = init ? new Request(input, init) : input
    return {
        input: new Request(original, { headers })
    }
}

function usageErrorResponse(result: UsageRecordResult) {
    const limitExceeded = Boolean(result.limitExceeded)
    return new Response(
        JSON.stringify({
            error: limitExceeded
                ? WORKSPACE_TRANSFER_LIMIT_MESSAGE
                : 'Workspace usage could not be recorded'
        }),
        {
            status: limitExceeded ? 429 : 502,
            headers: {
                'Content-Type': 'application/json'
            }
        }
    )
}

export function createWorkspaceUsageFetch(options: WorkspaceUsageFetchOptions): typeof fetch {
    const normalizedOptions: NormalizedWorkspaceUsageFetchOptions = {
        ...options,
        webGatewayUrl: options.webGatewayUrl?.trim() ?? '',
        webStorageGatewayUrl: options.webStorageGatewayUrl?.trim() ?? '',
        fetchImpl: options.fetchImpl ?? fetch.bind(globalThis)
    }

    return async (input, init) => {
        const countContext = getWorkspaceTransferContext(input, init, normalizedOptions.supabaseUrl)
        const gatewayUrl = countContext
            ? getGatewayUrl(
                input,
                normalizedOptions.supabaseUrl,
                countContext.gateway === 'storage' ? normalizedOptions.webStorageGatewayUrl : normalizedOptions.webGatewayUrl,
                countContext.gateway === 'storage' ? '/storage/v1/' : '/rest/v1/'
            )
            : null
        const gatewayRequest = gatewayUrl ? buildGatewayFetchArgs(input, init, gatewayUrl) : null
        const directRequest = gatewayRequest ? null : buildDirectFetchArgs(input, init)
        const requestBytesPromise = countContext?.countRequestBody
            ? getRequestTransferBytes(input, init)
            : Promise.resolve(0)

        const requestInput = gatewayRequest?.input ?? directRequest?.input ?? input
        const requestInit = gatewayRequest?.init ?? directRequest?.init ?? init
        let response: Response
        try {
            response = await normalizedOptions.fetchImpl(requestInput, requestInit)
        } catch (error) {
            recordNetworkError({
                method: getRequestMethod(requestInput, requestInit),
                endpoint: getRequestEndpoint(requestInput),
                error,
            })
            throw error
        }

        if (!response.ok) {
            void captureNetworkResponseError(response, requestInput, requestInit)
        }
        if (!countContext || !response.ok) {
            return response
        }

        // The same-origin gateway has already metered this exact Web Live request
        // with its server-held credentials. Never report it a second time from
        // an untrusted browser client.
        if (gatewayRequest) {
            notifyWorkspaceUsageUpdated(countContext.workspaceId)
            return response
        }

        const [requestBytes, responseBytes] = await Promise.all([
            requestBytesPromise,
            countContext.countResponseBody ? getResponseTransferBytes(response) : Promise.resolve(0)
        ])
        const bytes = requestBytes + responseBytes
        const result = await recordSupabaseDataTransfer(
            normalizedOptions,
            countContext.workspaceId,
            bytes,
            countContext.authHeader,
            countContext.source
        )

        return result.ok || !result.limitExceeded ? response : usageErrorResponse(result)
    }
}

export const workspaceUsageFetchInternals = {
    extractWorkspaceIdsFromUrl,
    getWorkspaceIdFromJwt,
    getRestRpcName,
    getRestTableName,
    getRequestTransferBytes,
    getStorageObjectTransfer,
    getStoragePathSegments,
    resolveWorkspaceId
}
