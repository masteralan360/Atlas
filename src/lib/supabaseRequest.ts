import { isWeb } from '@/lib/platform'

export const WEB_REQUEST_TIMEOUT_MS = 12000

const RETRY_ERROR_MESSAGE = 'The request did not finish. Please try again.'

type RunSupabaseActionOptions = {
    timeoutMs?: number
    platform?: 'web-only' | 'all'
}

export class SupabaseRequestTimeoutError extends Error {
    readonly code = 'SUPABASE_REQUEST_TIMEOUT'

    constructor(message = RETRY_ERROR_MESSAGE) {
        super(message)
        this.name = 'SupabaseRequestTimeoutError'
    }
}

export class SupabaseNetworkError extends Error {
    readonly code = 'SUPABASE_NETWORK_ERROR'
    readonly status?: number

    constructor(message = RETRY_ERROR_MESSAGE, status?: number) {
        super(message)
        this.name = 'SupabaseNetworkError'
        this.status = status
    }
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
        return (error as { message: string }).message
    }
    return String(error)
}

function getErrorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined
    const status = (error as { status?: unknown }).status
    return typeof status === 'number' ? status : undefined
}

function isNetworkLikeError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase()
    const status = getErrorStatus(error)

    return (
        status === 0 ||
        message.includes('failed to fetch') ||
        message.includes('fetch failed') ||
        message.includes('networkerror') ||
        message.includes('network error') ||
        message.includes('load failed') ||
        message.includes('aborterror')
    )
}

export function normalizeSupabaseActionError(error: unknown): Error {
    if (error instanceof SupabaseRequestTimeoutError || error instanceof SupabaseNetworkError) {
        return error
    }

    if (isNetworkLikeError(error)) {
        return new SupabaseNetworkError(RETRY_ERROR_MESSAGE, getErrorStatus(error))
    }

    if (error instanceof Error) {
        return error
    }

    return new Error(getErrorMessage(error))
}

export function isRetriableWebRequestError(error: unknown): boolean {
    const normalized = normalizeSupabaseActionError(error)
    return normalized instanceof SupabaseRequestTimeoutError || normalized instanceof SupabaseNetworkError
}

export function getRetriableActionToast(error: unknown): { title: string; description: string } {
    const normalized = normalizeSupabaseActionError(error)

    if (normalized instanceof SupabaseRequestTimeoutError) {
        return {
            title: 'Action timed out',
            description: RETRY_ERROR_MESSAGE
        }
    }

    return {
        title: 'Action failed',
        description: RETRY_ERROR_MESSAGE
    }
}

export async function runSupabaseAction<T>(
    label: string,
    promiseFactory: () => PromiseLike<T> | Promise<T> | T,
    options: RunSupabaseActionOptions = {}
): Promise<T> {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? WEB_REQUEST_TIMEOUT_MS
    const shouldApplyTimeout = options.platform === 'all' ? true : isWeb()
    const executeAction = () => Promise.resolve().then(() => promiseFactory())

    const logResult = (status: 'ok' | 'failed', error?: unknown) => {
        const duration = Date.now() - startedAt
        if (status === 'ok') {
            console.debug(`[SupabaseAction] ${label} succeeded in ${duration}ms`)
            return
        }
        console.warn(`[SupabaseAction] ${label} failed in ${duration}ms`, error)
    }

    if (!shouldApplyTimeout) {
        try {
            const result = await executeAction()
            logResult('ok')
            return result
        } catch (error) {
            const normalized = normalizeSupabaseActionError(error)
            logResult('failed', normalized)
            throw normalized
        }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    try {
        const result = await Promise.race<T>([
            executeAction().catch((error) => {
                throw normalizeSupabaseActionError(error)
            }),
            new Promise<T>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new SupabaseRequestTimeoutError())
                }, timeoutMs)
            })
        ])

        logResult('ok')
        return result
    } catch (error) {
        const normalized = normalizeSupabaseActionError(error)
        logResult('failed', normalized)
        throw normalized
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle)
        }
    }
}
