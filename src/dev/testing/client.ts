import type { RunnerSession, TestRun } from './types'

const prefix = '/__atlas-dev-testing'
const errorKeys = new Set(['local_only', 'invalid_session', 'run_busy', 'invalid_options', 'invalid_groups', 'invalid_suite', 'run_not_found'])

async function request<T>(path: string, { token, body, signal }: { token?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const abort = new AbortController()
    const cancel = () => abort.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) abort.abort()
    const timeout = setTimeout(cancel, 10_000)
    try {
        const response = await fetch(`${prefix}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                ...(token ? { 'X-Atlas-Test-Token': token } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            cache: 'no-store', credentials: 'omit', signal: abort.signal,
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        const result = await response.json()
        if (!response.ok) throw new Error(errorKeys.has(result.error) ? result.error : 'unavailable')
        return result as T
    } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', cancel)
    }
}

export const testRunnerClient = {
    session: (signal?: AbortSignal) => request<RunnerSession>('/session', { signal }),
    run: (token: string, signal?: AbortSignal) => request<TestRun | null>('/run', { token, signal }),
    start: (token: string, options: { suiteId: string; groupIds: string[]; seed: number; samples: number }) => request<TestRun>('/runs', { token, body: options }),
    cancel: (token: string, id: string) => request<TestRun>('/cancel', { token, body: { id } })
}

export function runnerErrorKey(error: unknown) {
    const message = error instanceof Error ? error.message : ''
    return `devTesting.errors.${errorKeys.has(message) ? message : 'unavailable'}`
}
