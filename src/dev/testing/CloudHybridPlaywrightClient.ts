export type CloudHybridStatus = 'pending' | 'running' | 'planned' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'skipped'

export interface CloudHybridScenarioPlanItem {
    id: string
    name: string
    domain: string
    signature: string
    status: CloudHybridStatus
}

export interface CloudHybridScenarioSelection {
    mode: 'from' | 'only'
    scenarioId: string
    signature: string
    digitalPaymentMethodId?: string | null
}

export interface CloudHybridScenarioResult {
    id: string
    name: string
    status: CloudHybridStatus
    errors?: string[]
    cleanup?: { completed: boolean; errors?: string[] }
    artifacts?: { screenshot?: string }
    [key: string]: unknown
}

export interface CloudHybridRun {
    id: string
    title: string
    status: CloudHybridStatus
    planOnly?: boolean
    stage: string
    currentScenario: string | null
    currentIndex: number
    totalScenarios: number
    passed: number
    failed: number
    blocked: number
    startedAt: string
    updatedAt: string
    finishedAt: string | null
    cancelRequested: boolean
    target: { workspaceName: string; workspaceId: string; mode: string; supabaseHost: string } | null
    results: CloudHybridScenarioResult[]
    scenarioPlan?: CloudHybridScenarioPlanItem[]
    scenarioDimensions?: {
        selectedDigitalPaymentMethod?: { id: string; label: string } | null
    }
    scenarioSelection?: { mode: 'all' | 'from' | 'only'; scenarioId?: string }
    logs: Array<{ at: string; level: string; message: string; details?: unknown }>
    diagnosticsPath: string
    tracePath?: string | null
}

export interface CloudHybridPreflight {
    status: 'ready' | 'blocked'
    target?: { workspaceName: string; workspaceId: string; mode: string; supabaseHost: string }
    reason?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/api/cloud-hybrid-playwright/${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers }
    })
    const result = await response.json().catch(() => ({})) as T & { error?: string }
    if (!response.ok) throw new Error(result.error || `Runner request failed (${response.status}).`)
    return result
}

export const cloudHybridPlaywrightClient = {
    preflight: () => request<CloudHybridPreflight>('preflight'),
    current: () => request<{ run: CloudHybridRun | null }>('status'),
    prepare: (baseUrl: string) => request<{ run: CloudHybridRun }>('plan', {
        method: 'POST', body: JSON.stringify({ baseUrl })
    }),
    start: (baseUrl: string, scenarioSelection?: CloudHybridScenarioSelection) => request<{ run: CloudHybridRun }>('start', {
        method: 'POST', body: JSON.stringify({ baseUrl, scenarioSelection })
    }),
    cancel: () => request<{ run: CloudHybridRun | null }>('cancel', { method: 'POST', body: '{}' })
}
