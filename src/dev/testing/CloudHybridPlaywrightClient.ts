export type CloudHybridStatus = 'pending' | 'running' | 'planned' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'skipped'
export type CloudHybridSuiteId = 'pos' | 'sales-order-resilience'

export interface CloudHybridScenarioPlanItem {
    id: string
    name: string
    domain: string
    signature: string
    status: CloudHybridStatus
    titleKey?: string
    description?: string
    descriptionKey?: string
    coverage?: string[]
    requiredCapabilities?: string[]
    prerequisites?: string[]
    expectedUi?: string[]
    expectedEffects?: string[]
    assertions?: string[]
    cleanupRequirements?: string[]
    preparedDimensions?: Record<string, unknown>
    missingCapabilities?: string[]
    statusReason?: string | null
}

export interface CloudHybridScenarioSelection {
    mode: 'all' | 'from' | 'only'
    planId?: string
    scenarioId?: string
    signature?: string
    digitalPaymentMethodId?: string | null
}

export function normalizeCloudHybridScenarioMode(mode?: CloudHybridScenarioSelection['mode']): CloudHybridScenarioSelection['mode'] {
    return mode ?? 'all'
}

export interface CloudHybridScenarioResult {
    id: string
    name: string
    status: CloudHybridStatus
    errors?: string[]
    titleKey?: string
    cleanup?: { completed: boolean; errors?: string[] }
    artifacts?: { screenshot?: string }
    [key: string]: unknown
}

export interface CloudHybridRun {
    id: string
    suiteId: CloudHybridSuiteId
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
    scenarioPlanId?: string
    coverageSummary?: {
        available: string[]
        skipped: Array<{ id: string; reason: string; missingCapabilities?: string[] }>
        blocked: Array<{ id: string; reason: string }>
        unverified: string[]
    }
    hybridBoundaries?: {
        browser: string
        supabase: string
        dexie: string
        nativeSqlite: string
        desktopRuntime: string
    }
    fixtureCleanup?: { completed: boolean; errors?: string[]; removed?: string[] }
    diagnostics?: Array<{ at: string; message: string; details?: unknown }>
    scenarioDimensions?: {
        selectedDigitalPaymentMethod?: { id: string; label: string } | null
      capabilities?: Record<string, unknown>
    }
    scenarioSelection?: { mode: 'all' | 'from' | 'only'; scenarioId?: string }
    logs: Array<{ at: string; level: string; message: string; details?: unknown }>
    diagnosticsPath: string
    tracePath?: string | null
}

export interface CloudHybridPreflight {
    status: 'ready' | 'blocked'
    target?: { workspaceName: string; workspaceId: string; mode: string; supabaseHost: string }
    capabilities?: { available: string[]; unavailable: Array<{ id: string; reason: string }> }
    boundaries?: { browser: string; supabase: string; dexie: string; nativeSqlite: string; desktopRuntime: string }
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
    preflight: (suiteId: CloudHybridSuiteId = 'pos') => request<CloudHybridPreflight>(`preflight?suiteId=${encodeURIComponent(suiteId)}`),
    current: (suiteId: CloudHybridSuiteId = 'pos') => request<{ run: CloudHybridRun | null }>(`status?suiteId=${encodeURIComponent(suiteId)}`),
    prepare: (baseUrl: string, suiteId: CloudHybridSuiteId = 'pos') => request<{ run: CloudHybridRun }>('plan', {
        method: 'POST', body: JSON.stringify({ suiteId, baseUrl })
    }),
    start: (baseUrl: string, suiteId: CloudHybridSuiteId = 'pos', scenarioSelection?: CloudHybridScenarioSelection) => request<{ run: CloudHybridRun }>('start', {
        method: 'POST', body: JSON.stringify({ suiteId, baseUrl, scenarioSelection })
    }),
    cancel: (suiteId: CloudHybridSuiteId = 'pos', runId?: string) => request<{ run: CloudHybridRun | null }>('cancel', {
        method: 'POST', body: JSON.stringify({ suiteId, runId })
    })
}
